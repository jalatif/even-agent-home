// OpenClaw provider.
//
// Mirrors backend/src/hermes/provider.js structurally: a createXProvider(emit)
// factory that returns the standard provider surface (listSessions, getHistory,
// prompt, getStatus, getSessionStatus, getInfo, interrupt, dispose, plus the
// respondPermission/respondQuestion stubs the router calls).
//
// OpenClaw is reached over HTTP — its Gateway exposes an OpenAI-compatible
// /v1/chat/completions endpoint that we stream from. Session enumeration
// comes from `openclaw sessions --all-agents --json`. The endpoint is
// disabled by default in OpenClaw; the provider surfaces a clear error in
// that case so users get actionable feedback instead of an opaque 404.

import { execFile, execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

import { sortSessionList } from "../shared/sort-sessions.js";

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || "openclaw";
const DEFAULT_AGENT_ID = process.env.OPENCLAW_AGENT_ID || "main";
const DEFAULT_GATEWAY_PORT = 18789;
const SESSION_REFRESH_MS = 15000;
const SESSION_LIST_LIMIT = 50;

// Path to the OpenClaw config JSON. Env override beats the home-directory
// default so the test suite can point at a fixture without touching
// ~/.openclaw/openclaw.json.
function readOpenClawConfig() {
    const configPath = process.env.OPENCLAW_CONFIG_PATH || join(homedir(), ".openclaw", "openclaw.json");
    if (!existsSync(configPath)) return {};
    try {
        return JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
        return {};
    }
}

// OpenClaw's "bind" field is a *mode* (loopback / tailnet / lan / 0.0.0.0 /
// a literal interface name), not a hostname. When the user is running the
// bridge on the same host as the Gateway, we want 127.0.0.1 regardless of
// which bind mode OpenClaw is in.
function resolveLoopbackHost(bind) {
    if (!bind) return "127.0.0.1";
    const value = String(bind).toLowerCase();
    if (value === "loopback" || value === "localhost" || value === "127.0.0.1") return "127.0.0.1";
    if (value === "0.0.0.0" || value === "all" || value === "lan") return "127.0.0.1";
    // Literal hostnames (e.g. "lan0", "192.168.1.10") pass through.
    return bind;
}

function gatewayUrlFromConfig(config) {
    if (process.env.OPENCLAW_GATEWAY_URL) return process.env.OPENCLAW_GATEWAY_URL.replace(/\/+$/, "");

    const gateway = config.gateway || {};

    if (gateway.mode === "remote") {
        const remoteUrl = gateway.remote?.url || gateway.remoteUrl;
        if (remoteUrl) return String(remoteUrl).replace(/\/+$/, "");
    }

    const protocol = gateway.tls?.enabled ? "https" : "http";
    const host = resolveLoopbackHost(gateway.http?.host || gateway.http?.bind || gateway.host);
    const port = process.env.OPENCLAW_GATEWAY_PORT
        || gateway.http?.port
        || gateway.port
        || DEFAULT_GATEWAY_PORT;
    return `${protocol}://${host}:${port}`;
}

function authSecretFromConfig(config) {
    if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
    if (process.env.OPENCLAW_GATEWAY_PASSWORD) return process.env.OPENCLAW_GATEWAY_PASSWORD;
    const auth = config.gateway?.auth || {};
    return auth.token || auth.password || "";
}

// Public: resolved {url, authSecret} used by the prompt path. Tests import
// this directly to verify env-var precedence and config-file fallback.
export function resolveOpenClawGatewayConfig() {
    const config = readOpenClawConfig();
    return {
        url: gatewayUrlFromConfig(config),
        authSecret: authSecretFromConfig(config),
    };
}

// Map the provider-agnostic `model` field (e.g. "openclaw" or "openclaw/main")
// onto the agent-id the Gateway uses for routing.
function agentIdFromModel(model) {
    if (!model || model === "openclaw") return DEFAULT_AGENT_ID;
    const value = String(model);
    if (value.startsWith("openclaw/")) return value.slice("openclaw/".length) || DEFAULT_AGENT_ID;
    return value;
}

function modelFromAgentId(agentId) {
    return `openclaw/${agentId || DEFAULT_AGENT_ID}`;
}

function responseTextFromChoice(choice) {
    const content = choice?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => typeof part === "string" ? part : part?.text || "")
            .filter(Boolean)
            .join("\n");
    }
    return "";
}

function responseTextFromChatCompletionPayload(text) {
    if (!text || !text.trim()) return "";
    try {
        const parsed = JSON.parse(text);
        const choice = parsed.choices?.[0];
        return responseTextFromChoice(choice) || choice?.delta?.content || "";
    } catch {
        return "";
    }
}

// Normalize a single session record from `openclaw sessions --all-agents
// --json` into the shape the route layer expects.
function normalizeSessionRow(row) {
    const id = String(row.sessionId || row.id || row.sessionKey || row.key || "").trim();
    if (!id) return null;
    const timestampValue = row.updatedAt || row.updated_at || row.lastActiveAt || row.createdAt;
    const timestamp = timestampValue ? new Date(timestampValue).toISOString() : new Date().toISOString();
    // The openclaw session list doesn't include a human-readable title. The
    // first user message from the .jsonl transcript is the most useful
    // identifier; `enrichSessionTitles` fills it in after the list is loaded.
    const fallback = String(
        row.title || row.name || row.summary
        || (row.modelProvider && row.model ? `${row.modelProvider}/${row.model}` : null)
        || row.agentId
        || id
    ).slice(0, 64);
    return {
        id,
        title: fallback,
        timestamp,
        cwd: "",
        provider: "openclaw",
        status: row.abortedLastRun ? "aborted" : null,
    };
}

// Read the first user message from a session's .jsonl transcript file. The
// file is line-delimited JSON; we walk line-by-line and stop at the first
// `{"type":"message","message":{"role":"user",...}}` entry. Returns the
// text content of that message, or null if no user message is found.
function firstUserMessageText(jsonlPath) {
    const messages = readTranscriptMessages(jsonlPath);
    for (const m of messages) {
        if (m.role === "user") return m.text;
    }
    return null;
}

// Read all user/assistant messages from a session's .jsonl transcript. The
// file is line-delimited JSON; we return the messages as `{role, text}`
// pairs in chronological order. Image-only user turns and pure-thinking
// assistant turns surface as short placeholders so the UI can show them.
function readTranscriptMessages(jsonlPath) {
    let content;
    try {
        content = readFileSync(jsonlPath, "utf8");
    } catch {
        return [];
    }
    const messages = [];
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let entry;
        try { entry = JSON.parse(trimmed); } catch { continue; }
        if (entry?.type !== "message") continue;
        const msg = entry.message;
        if (!msg) continue;
        const { role, text, hasImage } = extractMessageContent(msg);
        if (role !== "user" && role !== "assistant") continue;
        if (!text && !hasImage) continue;
        const display = text || (hasImage ? "[image attachment]" : "");
        if (!display) continue;
        messages.push({ role, text: display });
    }
    return messages;
}

// Extract a single text-or-image string from a message's `content` field.
// Content can be a plain string, an array of typed parts (text / thinking /
// image / image_url / tool_use / tool_result), or a structured tool block.
// We want a single user-readable string per message so the glasses view
// shows one line per turn. Pure-thinking assistant turns (no text, no
// image) collapse to an empty string and get filtered upstream.
function extractMessageContent(msg) {
    const raw = msg.content;
    if (typeof raw === "string") return { role: msg.role, text: raw, hasImage: false };
    if (!Array.isArray(raw)) return { role: msg.role, text: "", hasImage: false };
    const parts = [];
    let hasImage = false;
    let hasToolCall = false;
    for (const p of raw) {
        if (!p) continue;
        if (typeof p === "string") { parts.push(p); continue; }
        if (p.type === "text" && typeof p.text === "string") {
            parts.push(p.text);
        } else if (p.type === "thinking" && typeof p.thinking === "string") {
            // Skip chain-of-thought; the glasses view doesn't show it.
        } else if (p.type === "image" || p.type === "image_url") {
            hasImage = true;
        } else if (p.type === "tool_use" || p.type === "tool_result") {
            hasToolCall = true;
        }
    }
    let text = parts.join("\n").replace(/\s+/g, " ").trim();
    if (!text && hasToolCall) text = "[tool call]";
    return { role: msg.role, text, hasImage };
}

// Replace each session's placeholder title with the first user message from
// its transcript. The openclaw session list JSON includes `stores[].path`
// pointing at each agent's `sessions.json` index; per-session transcripts
// live next to that index as `<sessionId>.jsonl`. Without enrichment, the
// placeholder `"<modelProvider>/<model>"` repeats for every session, which
// makes the sidebar unreadable when all sessions use the same model.
function enrichSessionTitles(sessions, transcriptDirs) {
    if (!sessions || sessions.length === 0 || !transcriptDirs || transcriptDirs.length === 0) return sessions;
    for (const s of sessions) {
        if (!s.id) continue;
        let found = null;
        for (const dir of transcriptDirs) {
            if (!dir) continue;
            const transcriptPath = join(dir, `${s.id}.jsonl`);
            if (existsSync(transcriptPath)) {
                found = firstUserMessageText(transcriptPath);
                if (found) break;
            }
        }
        if (found) {
            const cleaned = found.replace(/\s+/g, " ").trim().slice(0, 64);
            if (cleaned) s.title = cleaned;
        }
    }
    return sessions;
}

function parseSessionListJson(text) {
    if (!text || !text.trim()) return { sessions: [], transcriptDirs: [] };
    try {
        const parsed = JSON.parse(text);
        const rows = Array.isArray(parsed)
            ? parsed
            : parsed.sessions || parsed.items || parsed.data || parsed.rows || [];
        if (!Array.isArray(rows)) return { sessions: [], transcriptDirs: [] };
        const sessions = rows.map(normalizeSessionRow).filter(Boolean);
        const transcriptDirs = collectTranscriptDirs(parsed);
        enrichSessionTitles(sessions, transcriptDirs);
        return { sessions, transcriptDirs };
    } catch {
        return { sessions: [], transcriptDirs: [] };
    }
}

// Walk the `stores[]` array in the openclaw session list JSON and return the
// parent directories of each store index file. Each store's transcripts
// (per-session `.jsonl` files) live alongside `sessions.json`.
function collectTranscriptDirs(parsed) {
    const stores = Array.isArray(parsed?.stores) ? parsed.stores : [];
    const dirs = [];
    for (const s of stores) {
        if (s && typeof s.path === "string" && s.path) {
            dirs.push(dirname(s.path));
        }
    }
    // Also try the top-level `path` field (used when the CLI was invoked with
    // an explicit --store for a single agent).
    if (typeof parsed?.path === "string" && parsed.path) {
        dirs.push(dirname(parsed.path));
    }
    return dirs;
}

function runOpenClawJson(args, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
        execFile(OPENCLAW_BIN, args, {
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 4 * 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout || "");
        });
    });
}

// Eager initial sync (mirrors hermes's IIFE pattern): the first listSessions
// call after backend start has data ready, no async race for the route layer
// to handle. Best-effort — failure just leaves the cache empty.
function loadSessionCacheSync() {
    try {
        const output = execFileSync(
            OPENCLAW_BIN,
            ["sessions", "--all-agents", "--json", "--limit", String(SESSION_LIST_LIMIT)],
            { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 }
        );
        const { sessions, transcriptDirs } = parseSessionListJson(String(output));
        initialTranscriptDirs = transcriptDirs;
        return sessions;
    } catch {
        return [];
    }
}

// Captured at provider construction from the eager `sessions --json` call.
// Used as the source of transcript directories for `getHistory` when the
// user opens a session that was never prompted through this process.
let initialTranscriptDirs = [];

// Fallback when getHistory is called before any listSessions has populated
// `knownTranscriptDirs`: derive candidate store paths from the openclaw
// config (per-agent `agents.<id>` entries) and the conventional state dir
// layout (`~/.openclaw[/-dev|-<profile>]/agents/<id>/sessions`).
function collectTranscriptDirsFromConfig() {
    const config = readOpenClawConfig();
    const dirs = [];
    const stateDir = process.env.OPENCLAW_STATE_DIR
        || (process.env.OPENCLAW_PROFILE ? join(homedir(), `.openclaw-${process.env.OPENCLAW_PROFILE}`) : null)
        || join(homedir(), ".openclaw");
    const agents = config.agents && typeof config.agents === "object" ? config.agents : {};
    // Use every concrete agent id, plus "main" / "default" fallbacks so we
    // still find transcripts even if the config doesn't enumerate them.
    const ids = new Set();
    for (const key of Object.keys(agents)) {
        if (key === "defaults") continue;
        if (typeof key === "string" && key) ids.add(key);
    }
    if (ids.size === 0) { ids.add("main"); ids.add("default"); }
    for (const id of ids) {
        dirs.push(join(stateDir, "agents", id, "sessions"));
    }
    return dirs;
}

export function createOpenClawProvider(emit) {
    const sessions = new Map();
    let sessionCache = loadSessionCacheSync();
    let knownTranscriptDirs = initialTranscriptDirs;
    let refreshTimer = null;

    function getSession(sessionId) {
        return sessionId ? sessions.get(sessionId) || null : null;
    }

    /** Load the conversation history from an existing transcript when
     *  resuming a session that was created externally. Returns [] if
     *  the session has no on-disk transcript yet. */
    function loadMessagesFromTranscript(sessionId) {
        if (!sessionId) return [];
        const dirs = knownTranscriptDirs.length > 0
            ? knownTranscriptDirs
            : collectTranscriptDirsFromConfig();
        for (const dir of dirs) {
            if (!dir) continue;
            const transcriptPath = join(dir, `${sessionId}.jsonl`);
            if (existsSync(transcriptPath)) {
                return readTranscriptMessages(transcriptPath);
            }
        }
        return [];
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing?.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session = existing || {
            id: phoneSessionId || `openclaw-${Date.now()}`,
            busy: true,
            messages: loadMessagesFromTranscript(phoneSessionId),
            partialText: "",
            abortController: null,
            lastError: undefined,
        };
        session.busy = true;
        session.abortController = new AbortController();

        const sessionId = session.id;
        if (!sessions.has(sessionId)) sessions.set(sessionId, session);

        emit(sessionId, { type: "user_prompt", text });
        emit(sessionId, { type: "status", state: "busy" });
        session.messages.push({ role: "user", content: text });

        runPrompt(session, sessionId, model, thinking);
        return { sessionId, provider: "openclaw" };
    }

    // runPrompt is invoked fire-and-forget from prompt() (prompt returns the
    // sessionId immediately while streaming continues). Because it is never
    // awaited, it MUST NOT produce an unhandled rejection: every code path —
    // including header/gateway resolution before the fetch — is wrapped in the
    // try below so any throw is funneled into the same error/cleanup path as a
    // streaming failure.
    async function runPrompt(session, sessionId, model, thinking) {
        try {
        const agentId = agentIdFromModel(model);
        const gateway = resolveOpenClawGatewayConfig();
        const headers = {
            "Content-Type": "application/json",
            "x-openclaw-session-key": sessionId,
            "x-openclaw-agent-id": agentId,
        };
        if (gateway.authSecret) headers.Authorization = `Bearer ${gateway.authSecret}`;
        if (thinking && thinking !== "off") headers["x-openclaw-thinking-level"] = String(thinking);
            const response = await fetch(`${gateway.url}/v1/chat/completions`, {
                method: "POST",
                headers,
                body: JSON.stringify({
                    model: modelFromAgentId(agentId),
                    user: sessionId,
                    messages: session.messages,
                    stream: true,
                }),
                signal: session.abortController.signal,
            });

            if (!response.ok) {
                const errBody = await response.text().catch(() => "");
                const hint = response.status === 404
                    ? " — OpenClaw Gateway /v1/chat/completions is disabled. Set gateway.http.endpoints.chatCompletions.enabled = true in openclaw.json."
                    : "";
                throw new Error(`OpenClaw gateway error ${response.status}${hint}${errBody ? `: ${errBody.slice(0, 300)}` : ""}`);
            }

            let fullResponse = "";
            if (response.body?.getReader) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                let rawBody = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const chunk = decoder.decode(value, { stream: true });
                    rawBody += chunk;
                    buffer += chunk;
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed || !trimmed.startsWith("data: ")) continue;
                        const payload = trimmed.slice(6);
                        if (payload === "[DONE]") continue;
                        try {
                            const parsed = JSON.parse(payload);
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullResponse += delta;
                                session.partialText = fullResponse;
                                emit(sessionId, { type: "text_delta", text: delta });
                            }
                        } catch {}
                    }
                }
                const trailing = buffer.trim();
                if (trailing.startsWith("data: ")) {
                    const payload = trailing.slice(6);
                    if (payload !== "[DONE]") {
                        try {
                            const parsed = JSON.parse(payload);
                            const delta = parsed.choices?.[0]?.delta?.content;
                            if (delta) {
                                fullResponse += delta;
                                session.partialText = fullResponse;
                                emit(sessionId, { type: "text_delta", text: delta });
                            }
                        } catch {}
                    }
                }
                if (!fullResponse) {
                    fullResponse = responseTextFromChatCompletionPayload(rawBody);
                    if (fullResponse) {
                        session.partialText = fullResponse;
                        emit(sessionId, { type: "text_delta", text: fullResponse });
                    }
                }
            } else {
                const data = await response.json();
                fullResponse = responseTextFromChoice(data.choices?.[0]);
                if (fullResponse) {
                    session.partialText = fullResponse;
                    emit(sessionId, { type: "text_delta", text: fullResponse });
                }
            }

            if (fullResponse) session.messages.push({ role: "assistant", content: fullResponse });
            session.busy = false;
            session.abortController = null;
            session.partialText = "";
            session.lastError = undefined;
            // A new chat happened; trigger an immediate refresh so the
            // sessions list picks up the new entry without waiting for
            // the 15s interval timer. Don't null the cache — the old
            // data is a better placeholder than an empty list.
            refreshSessionCache();
            emit(sessionId, { type: "result", success: true, text: fullResponse, provider: "openclaw" });
            emit(sessionId, { type: "status", state: "idle" });
        } catch (err) {
            session.busy = false;
            session.abortController = null;
            // Match the success path: clear any streamed-but-uncommitted
            // partial text. Without this, a failed/aborted turn leaves
            // session.partialText populated, and the NEXT prompt() flips
            // busy=true before its first delta arrives — getHistory() then
            // appends the dead turn's fragments as the new turn's in-progress
            // reply.
            session.partialText = "";
            if (err.name === "AbortError") {
                emit(sessionId, { type: "status", state: "idle" });
            } else {
                emit(sessionId, { type: "error", value: err.message });
                emit(sessionId, { type: "status", state: "idle" });
                session.lastError = err.message;
            }
        }
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (!s) return null;
        const status = { state: s.busy ? "busy" : "idle", provider: "openclaw" };
        if (s.lastError) status.error = s.lastError;
        return status;
    }

    function getSessionStatus(sessionId) {
        return getSession(sessionId)?.busy ? "busy" : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync(`${OPENCLAW_BIN} --version`, { timeout: 3000, encoding: "utf8", shell: true }).trim();
        } catch {}
        const gateway = resolveOpenClawGatewayConfig();
        return {
            account: { email: `${modelFromAgentId(DEFAULT_AGENT_ID)} via ${gateway.url}`, organization: "OpenClaw" },
            model: modelFromAgentId(DEFAULT_AGENT_ID),
            version: version || "Unknown",
            provider: "openclaw",
        };
    }

    function refreshSessionCache() {
        const proc = spawn(OPENCLAW_BIN, ["sessions", "--all-agents", "--json", "--limit", String(SESSION_LIST_LIMIT)], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        proc.on("close", () => {
            const { sessions: parsed, transcriptDirs } = parseSessionListJson(stdout);
            if (parsed.length > 0 || sessionCache === null) sessionCache = parsed;
            if (transcriptDirs && transcriptDirs.length > 0) knownTranscriptDirs = transcriptDirs;
        });
        proc.on("error", () => {});
    }

    refreshTimer = setInterval(refreshSessionCache, SESSION_REFRESH_MS);
    refreshTimer.unref();

    function listSessions(limit) {
        const result = [];
        for (const [id, s] of sessions) {
            const lastMsg = s.messages.length > 0 ? s.messages[0].content : "";
            result.push({
                id,
                title: lastMsg.slice(0, 64) || id,
                timestamp: new Date().toISOString(),
                cwd: "",
                provider: "openclaw",
                status: s.busy ? "busy" : null,
            });
        }
        const existingIds = new Set(result.map((r) => r.id));
        for (const s of sessionCache || []) {
            if (!existingIds.has(s.id)) result.push(s);
        }
        // Ensure transcript dirs are populated even if listSessions is the
        // very first provider call (the eager loadSessionCacheSync already
        // captured them, but be defensive in case that failed).
        if (knownTranscriptDirs.length === 0) {
            knownTranscriptDirs = collectTranscriptDirsFromConfig();
        }
        return sortSessionList(result).slice(0, limit || 10);
    }

    function getHistory(sessionId, limit) {
        const s = getSession(sessionId);
        const max = Math.min(limit || 50, 50);
        if (s) {
            // In-memory session (active or recently active in this process).
            // Use the in-memory message log; merge with any partial text.
            const history = s.messages.slice(-max).map((m) => ({ role: m.role, text: m.content }));
            if (s.busy && s.partialText) history.push({ role: "assistant", text: s.partialText });
            return history.slice(-max);
        }
        // No in-memory session — fall back to the on-disk transcript. This
        // covers sessions the user opened from the list that were started
        // by a previous backend run, a different client, or the openclaw
        // TUI. The transcript dir(s) were captured by the last listSessions
        // call; if none are known, try to derive them.
        const dirs = knownTranscriptDirs.length > 0
            ? knownTranscriptDirs
            : collectTranscriptDirsFromConfig();
        for (const dir of dirs) {
            if (!dir) continue;
            const transcriptPath = join(dir, `${sessionId}.jsonl`);
            if (existsSync(transcriptPath)) {
                const messages = readTranscriptMessages(transcriptPath);
                return messages.slice(-max);
            }
        }
        return [];
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        try { s?.abortController?.abort(); } catch {}
        if (s) {
            s.busy = false;
            s.abortController = null;
            s.partialText = "";
        }
    }

    function dispose() {
        if (refreshTimer) clearInterval(refreshTimer);
        refreshTimer = null;
        for (const s of sessions.values()) {
            try { s.abortController?.abort(); } catch {}
            s.busy = false;
            s.abortController = null;
            s.partialText = "";
        }
    }

    return {
        listSessions, getSessionStatus, getInfo, getHistory,
        prompt, respondPermission, respondQuestion, interrupt, getStatus, dispose,
    };
}
