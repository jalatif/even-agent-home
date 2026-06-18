import { spawn, execSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { sortSessionList } from "../shared/sort-sessions.js";
import { resolve, relative, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { debugLog } from "../debug.js";

/**
 * pi (omp) provider.
 *
 * Spawns `omp -p --mode json` as a subprocess per prompt.  omp streams
 * JSON events on stdout in real time:
 *   {type:"session", id, timestamp, cwd, title}
 *   {type:"agent_start"} / {type:"agent_end"}
 *   {type:"turn_start"}  / {type:"turn_end"}
 *   {type:"message_start", message:{role, content:[...]}}
 *   {type:"message_update", assistantMessageEvent:{type, delta, partial, ...}}
 *   {type:"message_end",   message:{role, content:[...]}}
 *
 * We translate:
 *   text_delta            → {type:"text_delta", text}
 *   tooluse_start/_end    → {type:"tool_start", name, toolId}
 *   agent_end / proc.close → {type:"result", success, text, provider:"pi"}
 *   thinking_delta         → {type:"text_delta", text} (phone has no thinking type, so show as text)
 *   err / stderr           → {type:"error", value}
 *
 * Sessions are stored by omp at ~/.pi/agent/sessions/<encoded-cwd>/<file>.jsonl.
 * The phone generates UUID session IDs; we map them to omp session IDs via
 * phoneToPi (the omp session ID is captured from the first {type:"session"} event).
 *
 * omp manages its own credentials (LiteLLM, Bitwarden) via ~/.pi/agent/agent.db
 * and ~/.pi/agent/models.yml — no env loading needed here.
 */

const PI_BIN = process.env.PI_BIN || "pi";
const PI_HOME = process.env.PI_HOME || join(homedir(), ".pi");
const SESSIONS_DIR = join(PI_HOME, "agent", "sessions");
const SESSION_CACHE_TTL_MS = 30000;
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY = 50;
const MAX_PHONE_MAP_ENTRIES = 500;
/** Resolve symlinks + macOS /private/* normalisation, matching omp's resolveEquivalentPath. */
function resolveEquivalentPath(inputPath) {
    const resolved = resolve(inputPath);
    try {
        return realpathSync(resolved);
    } catch {
        return resolved;
    }
}

/** Matches omp's pathIsWithin. */
function pathIsWithin(root, candidate) {
    const r = relative(resolveEquivalentPath(root), resolveEquivalentPath(candidate));
    return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function encodeLegacyAbsoluteSessionDirName(cwd) {
    const resolvedCwd = resolve(cwd);
    return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function encodeRelativeSessionDirName(prefix, root, cwd) {
    const rel = relative(root, cwd).replace(/[/\\:]/g, "-");
    return rel ? (prefix.endsWith("-") ? `${prefix}${rel}` : `${prefix}-${rel}`) : prefix;
}

/** Replicates omp's getDefaultSessionDirName: home → `-...`, temp → `-tmp-...`, else legacy `--...--`. */
function encodeCwd(cwd) {
    if (!cwd) return "";
    const resolvedCwd = resolve(cwd);
    const canonicalCwd = resolveEquivalentPath(resolvedCwd);
    const home = resolveEquivalentPath(homedir());
    const tempRoot = resolveEquivalentPath(tmpdir());
    if (pathIsWithin(home, canonicalCwd)) {
        return encodeRelativeSessionDirName("-", home, canonicalCwd);
    }
    if (pathIsWithin(tempRoot, canonicalCwd)) {
        return encodeRelativeSessionDirName("-tmp", tempRoot, canonicalCwd);
    }
    return encodeLegacyAbsoluteSessionDirName(canonicalCwd);
}


function listSessionFilesForCwd(cwd) {
    const dir = cwd ? join(SESSIONS_DIR, encodeCwd(cwd)) : null;
    if (!dir || !existsSync(dir)) return [];
    try {
        if (!statSync(dir).isDirectory()) return [];
        return readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => join(dir, f));
    } catch {
        return [];
    }
}

function listAllSessionFiles() {
    if (!existsSync(SESSIONS_DIR)) return [];
    try {
        if (!statSync(SESSIONS_DIR).isDirectory()) return [];
        const result = [];
        for (const sub of readdirSync(SESSIONS_DIR)) {
            const subdir = join(SESSIONS_DIR, sub);
            try {
                if (!statSync(subdir).isDirectory()) continue;
                for (const f of readdirSync(subdir)) {
                    if (f.endsWith(".jsonl")) result.push(join(subdir, f));
                }
            } catch {}
        }
        return result;
    } catch {
        return [];
    }
}

function readSessionJsonl(file) {
    try {
        const text = readFileSync(file, "utf8");
        const out = [];
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                out.push(JSON.parse(trimmed));
            } catch {}
        }
        return out;
    } catch {
        return [];
    }
}
/** Read only the first JSON line of a .jsonl session file (the session header).
 *  This is ~100x faster than reading the entire file when building session lists. */
function readSessionHeader(file) {
    try {
        const buf = Buffer.alloc(4096);
        const fd = openSync(file, "r");
        const bytesRead = readSync(fd, buf, 0, 4096, 0);
        closeSync(fd);
        const firstNewline = buf.indexOf(10, 0); // '\n'
        const len = firstNewline >= 0 ? firstNewline : bytesRead;
        const line = buf.toString("utf8", 0, len).trim();
        if (!line) return [];
        const parsed = JSON.parse(line);
        return parsed && parsed.type === "session" ? [parsed] : [];
    } catch {
        return [];
    }
}

function setBoundedMapping(map, key, value) {
    if (!key || !value) return;
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > MAX_PHONE_MAP_ENTRIES) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
    }
}

export function createPiProvider(emit) {
    const sessions = new Map();
    const phoneToPi = new Map();
    const sessionCaches = new Map(); // cwd -> { data: [], time: ms }

    function getSession(phoneId) {
        if (!phoneId) return null;
        if (sessions.has(phoneId)) return sessions.get(phoneId);
        const ompId = phoneToPi.get(phoneId);
        if (ompId && sessions.has(ompId)) return sessions.get(ompId);
        return null;
    }

    function buildArgs(text, piSessionId, model, thinking) {
        const args = [
            "-p",
            "--mode", "json",
            "--no-extensions",
            "--no-skills",
        ];
        if (model) {
            args.push("--model", model);
        } else if (process.env.PI_MODEL) {
            args.push("--model", process.env.PI_MODEL);
        }
        if (thinking && thinking !== "off") {
            args.push("--thinking", thinking);
        }
        if (piSessionId) {
            args.push("--resume", piSessionId);
        }
        args.push(text);
        return args;
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const resolvedDir = cwd || process.env.PROJECT_DIR || process.cwd();

        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session =
            existing || { id: null, busy: true, cwd: resolvedDir, proc: null, piSessionId: null };
        session.busy = true;
        session.cwd = resolvedDir;
        // When resuming an external session, use the frontend-provided session ID
        if (!existing && phoneSessionId && !session.piSessionId) {
            session.piSessionId = phoneSessionId;
        }
        const emitId = phoneSessionId || `pi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!sessions.has(emitId)) sessions.set(emitId, session);
        if (phoneSessionId && session.piSessionId) {
            setBoundedMapping(phoneToPi, phoneSessionId, session.piSessionId);
        }

        const safeEmit = (id, msg) => { try { emit(id, msg); } catch {} };
        safeEmit(emitId, { type: "user_prompt", text });
        safeEmit(emitId, { type: "status", state: "busy" });

        const args = buildArgs(text, session.piSessionId, model, thinking);
        debugLog("pi", "spawning", `${PI_BIN} ${args.join(" ")}`);

        const proc = spawn(PI_BIN, args, {
            cwd: resolvedDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
        });
        session.proc = proc;

        let lineBuffer = "";
        let fullText = "";
        let lastError = null;  // track turn-level errors
        const seenToolCalls = new Set();

        proc.stdout.on("data", (chunk) => {
            lineBuffer += chunk.toString();
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;
                let event;
                try {
                    event = JSON.parse(line);
                } catch {
                    continue;
                }
                if (!event || typeof event !== "object") continue;

                if (event.type === "session" && event.id) {
                    if (!session.piSessionId) {
                        session.piSessionId = event.id;
                        if (emitId !== event.id) {
                            setBoundedMapping(phoneToPi, emitId, event.id);
                        }
                        if (phoneSessionId) setBoundedMapping(phoneToPi, phoneSessionId, event.id);
                        // Got the real ID — resolve prompt so frontend polls with canonical ID
                        if (promptResolver) promptResolver();
                    }
                    continue;
                }

                if (event.type === "message_update" && event.assistantMessageEvent) {
                    const inner = event.assistantMessageEvent;
                    if (inner.type === "text_delta" && typeof inner.delta === "string") {
                        fullText += inner.delta;
                        session.partialText = fullText;
                        safeEmit(emitId, { type: "text_delta", text: inner.delta });
                    } else if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
                        fullText += inner.delta;
                        session.partialText = fullText;
                        safeEmit(emitId, { type: "text_delta", text: inner.delta });
                    } else if (inner.type === "tooluse_start") {
                        const block = inner.partial?.content?.[inner.contentIndex];
                        if (block && block.name) {
                            const toolId = block.id || `tc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                            seenToolCalls.add(toolId);
                            safeEmit(emitId, {
                                type: "tool_start",
                                name: block.name,
                                toolId,
                                input: block.input,
                            });
                        }
                    }
                    continue;
                }

                if (event.type === "message_end" && event.message?.role === "toolResult") {
                    const content = event.message.content;
                    const text = Array.isArray(content)
                        ? content
                              .map((c) => (typeof c?.text === "string" ? c.text : ""))
                              .filter(Boolean)
                              .join("\n")
                        : typeof content === "string"
                          ? content
                          : "";
                    const toolCallId = event.message.toolCallId;
                    if (toolCallId) {
                        safeEmit(emitId, {
                            type: "tool_end",
                            toolId: toolCallId,
                            name: event.message.toolName || "tool",
                            summary: text.slice(0, 200),
                            detail: text,
                        });
                    }
                    continue;
                }
                if (event.type === "error" || event.error) {
                    const msg = event.error?.message || event.message || event.value || String(event);
                    lastError = msg;
                    console.error(`[pi] Turn error: ${msg}`);
                    safeEmit(emitId, { type: "error", value: msg });
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            const t = chunk.toString();
            if (t.trim()) {
                const lines = t.split('\n').filter(l => l.trim());
                const errMsg = lines.findLast(l => l.startsWith('error:')) || lines[lines.length - 1] || t.trim();
                lastError = errMsg.trim();
                console.error(`[pi] stderr: ${errMsg.trim()}`);
                safeEmit(emitId, { type: "error", value: errMsg.trim() });
            }
        });

        let promptResolver = null;
        return new Promise((resolvePromise) => {
            let promptResolved = false;
            promptResolver = () => {
                if (promptResolved) return;
                promptResolved = true;
                clearTimeout(resolveTimer);
                const canonicalId = session.piSessionId || (phoneSessionId || emitId);
                resolvePromise({ sessionId: canonicalId, provider: "pi" });
            };
            const resolveTimer = setTimeout(promptResolver, 3000);
            proc.once("spawn", () => {
                if (session.piSessionId) {
                    clearTimeout(resolveTimer);
                    promptResolver();
                }
            });

            let settled = false;
            const finalize = (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearTimeout(resolveTimer);
                session.busy = false;
                if (lastError && session) session.lastError = lastError;
                session.proc = null;
                safeEmit(emitId, {
                    type: "result",
                    success: code === 0 && !lastError,
                    text: fullText,
                    provider: "pi",
                    error: lastError || undefined,
                });
                safeEmit(emitId, { type: "status", state: "idle" });
            };

            const timer = setTimeout(() => {
                safeEmit(emitId, { type: "error", value: `pi: prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s` });
                try {
                    if (session.proc && !session.proc.killed) session.proc.kill("SIGKILL");
                } catch {}
                finalize(124);
            }, PROMPT_TIMEOUT_MS);

            proc.on("close", (code) => finalize(code));
            proc.on("error", (err) => {
                safeEmit(emitId, { type: "error", value: err.message });
                finalize(1);
            });
        });
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (!s) return null;
        return { state: s.busy ? "busy" : "idle", provider: "pi", error: s.lastError || undefined };
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        return s?.busy ? "busy" : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync(`${PI_BIN} --version`, {
                timeout: 3000,
                encoding: "utf8",
                shell: process.env.SHELL || "sh",
            }).trim();
        } catch {}
        const model = process.env.PI_MODEL || "pi-default";
        return {
            account: { email: `${model} (via pi)`, organization: "pi" },
            model,
            version: version || "Unknown",
            provider: "pi",
        };
    }

    function sessionStatusFromJsonl(sessionId) {
        const files = listAllSessionFiles();
        for (const file of files) {
            const events = readSessionJsonl(file);
            const sessionEvent = events.find((e) => e.type === "session" && e.id === sessionId);
            if (!sessionEvent) continue;
            // Check if the last event indicates an active turn
            for (let i = events.length - 1; i >= 0; i--) {
                const e = events[i];
                if (e.type === "agent_end" || e.type === "turn_end") return "idle";
                if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason && e.message.stopReason !== "toolUse") return "idle";
                if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "toolResult")) return "busy";
            }
            return "idle";
        }
        return null;
    }

    function buildSessionList(cwd) {
        const files = cwd ? listSessionFilesForCwd(cwd) : listAllSessionFiles();
        const result = [];
        for (const file of files) {
            try {
                const headers = readSessionHeader(file);
                const sessionEvent = headers[0];
                if (!sessionEvent || !sessionEvent.id) continue;
                if (cwd && sessionEvent.cwd && sessionEvent.cwd !== cwd) continue;
                const stats = statSync(file);
                if (stats.size < 300) continue;
                let title = (sessionEvent.title || "").slice(0, 64).trim();
                if (!title) title = `pi-${sessionEvent.id.split('-')[0]}`;
                result.push({
                    id: sessionEvent.id,
                    title,
                    timestamp: stats.mtime.toISOString(),
                    cwd: sessionEvent.cwd || cwd || "",
                    provider: "pi",
                    status: sessionStatusFromJsonl(sessionEvent.id),
                });
            } catch {}
        }
        sortSessionList(result);
        return result;
    }

    function listSessions(limit, cwd) {
        const key = cwd || "*";
        const now = Date.now();
        const cached = sessionCaches.get(key);
        if (cached && now - cached.time < SESSION_CACHE_TTL_MS) {
            return cached.data.slice(0, limit || 20);
        }
        const data = buildSessionList(cwd);
        sessionCaches.set(key, { data, time: now });
        return data.slice(0, limit || 20);
    }

    function getHistory(sessionId, limit) {
        const files = listAllSessionFiles();
        // Resolve emitId (phone-frontend ID) to pi session ID via mapping
        const resolvedId = phoneToPi.get(sessionId) || sessionId;
        for (const file of files) {
            const events = readSessionJsonl(file);
            const sessionEvent = events.find((e) => e.type === "session" && (e.id === sessionId || e.id === resolvedId));
            if (!sessionEvent) continue;
            const history = [];
            for (const e of events) {
                if (e.type !== "message" || !e.message?.content) continue;
                const role = e.message.role;
                if (role !== "user" && role !== "assistant") continue;
                const content = e.message.content;
                if (!Array.isArray(content)) continue;
                for (const c of content) {
                    if (c?.type === "text" && typeof c.text === "string") {
                        history.push({ role, text: c.text });
                    }
                }
            }
            const max = Math.min(limit || 10, MAX_HISTORY);
            const s = getSession(sessionId);
            if (s && s.busy && s.partialText) {
                history.push({ role: "assistant", text: s.partialText });
            }
            return history.slice(-max);
        }
        
        const s = getSession(sessionId);
        if (s && s.busy && s.partialText) {
            return [{ role: "assistant", text: s.partialText }];
        }
        
        return [];
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s && s.proc && !s.proc.killed) {
            const proc = s.proc;
            try {
                proc.kill("SIGTERM");
                const escalation = setTimeout(() => {
                    if (proc && !proc.killed) {
                        try { proc.kill("SIGKILL"); } catch {}
                    }
                }, 2000);
                proc.once("close", () => clearTimeout(escalation));
            } catch {}
        }
        if (s) {
            s.busy = false;
            s.proc = null;
        }
    }

    function dispose() {
        for (const s of sessions.values()) {
            if (s?.proc && !s.proc.killed) {
                try { s.proc.kill("SIGTERM"); } catch {}
            }
            if (s) {
                s.busy = false;
                s.proc = null;
            }
        }
    }

    return {
        listSessions,
        getSessionStatus,
        getInfo,
        getHistory,
        prompt,
        respondPermission,
        respondQuestion,
        interrupt,
        getStatus,
        dispose,
    };
}
