import { spawn, execSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { sortSessionList } from "../shared/sort-sessions.js";
import { stripAnsi } from "../shared/ansi.js";
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
const MODELS_JSON = join(PI_HOME, "agent", "models.json");
const SESSION_CACHE_TTL_MS = 30000;
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;

// Kill the whole pi process GROUP. pi is spawned detached (its own session) so
// it can't grab the backend's controlling TTY; killing just the leader would
// orphan its subprocesses (model providers etc.). Negative PID = signal the
// whole group.
function killProcGroup(proc, signal = "SIGTERM") {
    if (!proc || proc.killed) return;
    try { process.kill(-proc.pid, signal); }
    catch { try { proc.kill(signal); } catch {} }
}
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
    if (!cwd) return [];
    const encodedDirs = [
        encodeCwd(cwd),
        encodeLegacyAbsoluteSessionDirName(resolveEquivalentPath(cwd)),
    ].filter(Boolean);
    const dirs = [...new Set(encodedDirs)].map((encoded) => join(SESSIONS_DIR, encoded));
    const files = [];
    for (const dir of dirs) {
        if (!existsSync(dir)) continue;
        try {
            if (!statSync(dir).isDirectory()) continue;
            files.push(...readdirSync(dir)
                .filter((f) => f.endsWith(".jsonl"))
                .map((f) => join(dir, f)));
        } catch {}
    }
    return files;
}

const STALE_SESSION_MS = 5 * 60 * 1000; // 5 min — if last user activity is older, treat as idle

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

let customModelAliases = null;
let customModelAliasesMtimeMs = 0;
function getCustomModelAliases() {
    let mtimeMs = 0;
    try {
        mtimeMs = existsSync(MODELS_JSON) ? statSync(MODELS_JSON).mtimeMs : 0;
        if (customModelAliases && customModelAliasesMtimeMs === mtimeMs) return customModelAliases;
        customModelAliasesMtimeMs = mtimeMs;
        customModelAliases = new Map();
        if (!mtimeMs) return customModelAliases;
        const parsed = JSON.parse(readFileSync(MODELS_JSON, "utf8"));
        for (const [provider, providerConfig] of Object.entries(parsed.providers || {})) {
            const models = Array.isArray(providerConfig?.models) ? providerConfig.models : [];
            for (const modelDef of models) {
                if (!modelDef || typeof modelDef.id !== "string") continue;
                const qualified = `${provider}/${modelDef.id}`;
                customModelAliases.set(modelDef.id, qualified);
                if (typeof modelDef.name === "string") customModelAliases.set(modelDef.name, qualified);
            }
        }
    } catch (err) {
        customModelAliases = customModelAliases || new Map();
        console.warn(`[pi] failed to read custom model aliases: ${err.message}`);
    }
    return customModelAliases;
}

function normalizeModel(model) {
    if (!model || model.includes("/")) return model;
    return getCustomModelAliases().get(model) || model;
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

    /** Given a pi session UUID, find the matching JSONL file and return
 *  the session cwd from its header. Returns null if unknown. */
function findSessionCwd(sessionId) {
    try {
        const dirs = readdirSync(SESSIONS_DIR);
        let best = null;
        let bestSize = 0;
        for (const dir of dirs) {
            const dirPath = join(SESSIONS_DIR, dir);
            const files = readdirSync(dirPath);
            for (const f of files) {
                if (!f.includes(sessionId)) continue;
                const fp = join(dirPath, f);
                const st = statSync(fp);
                if (st.size > bestSize) {
                    bestSize = st.size;
                    const headers = readSessionHeader(fp);
                    if (headers[0]?.cwd) {
                        best = headers[0].cwd;
                    }
                }
            }
        }
        return best;
    } catch {}
    return null;
}

function buildArgs(text, piSessionId, model, thinking) {
        const resolvedModel = normalizeModel(model);
        const args = [
            "-p",
            "--mode", "json",
            "--no-skills",
            "--provider", "litellm",
        ];
        if (resolvedModel) {
            args.push("--model", resolvedModel);
        } else if (process.env.PI_MODEL) {
            args.push("--model", normalizeModel(process.env.PI_MODEL));
        }
        if (thinking && thinking !== "off") {
            args.push("--thinking", thinking);
        }
        if (piSessionId) {
            args.push("--session", piSessionId);
        }
        args.push(text);
        return args;
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const existing = phoneSessionId ? getSession(phoneSessionId) : null;

        // Reuse the cwd we already pinned for this session on a prior turn
        // (set either from the JSONL header below or from the caller). Without
        // this, the second+ message re-derives resolvedDir from the request/
        // backend cwd — which usually differs from the session's original
        // project — and pi responds with its interactive "Fork this session?"
        // prompt. stdin is set to "ignore", so pi reads EOF (= "N"), produces
        // no output, and the turn surfaces as "Agent Error".
        let resolvedDir = existing?.cwd
            || cwd
            || process.env.PROJECT_DIR
            || process.cwd();

        // When resuming an existing session (not in our local map), use its
        // stored cwd from the JSONL header so pi doesn't ask to fork when
        // the backend runs from a different working directory.
        if (phoneSessionId && !existing) {
            const sessionCwd = findSessionCwd(phoneSessionId);
            if (sessionCwd) {
                resolvedDir = sessionCwd;
            }
        }

        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session =
            existing || { id: null, busy: true, cwd: resolvedDir, proc: null, piSessionId: null };
        session.busy = true;
        session.cwd = resolvedDir;
        session.lastError = undefined;
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
            // Run pi in its OWN process group/session so it cannot grab the
            // backend's controlling TTY. pi is a TUI app; even with piped stdio
            // it opens /dev/tty directly and emits raw terminal control codes
            // (e.g. `ESC[99;5:1u`), which corrupted the backend's shell into an
            // irrecoverable raw-mode state. `detached: true` puts the child in a
            // new session (setsid) with no controlling terminal. Also drop TTY/
            // color env so pi doesn't render color codes into its JSON stream.
            detached: true,
            env: {
                ...process.env,
                // Signal "no terminal" so pi skips TUI/color/escape init.
                TERM: "dumb",
                NO_COLOR: "1",
                FORCE_COLOR: "0",
                CLICOLOR: "0",
                CI: "1",
            },
        });
        // Don't keep the backend alive waiting on the pi child group.
        try { proc.unref(); } catch {}
        session.proc = proc;

        let lineBuffer = "";
        let fullText = "";
        let lastError = null;  // track turn-level errors
        let sawTurnEnd = false;  // did pi emit a turn_end/agent_end event?
        let stderrBuffer = "";  // accumulate stderr for silent-failure messages
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

                // Track whether pi signaled turn completion. Used by finalize()
                // to distinguish a genuinely-empty-but-completed turn from a
                // silent failure (pi quit without ever starting the model, e.g.
                // "No API key found for minimax").
                if (event.type === "turn_end" || event.type === "agent_end") {
                    sawTurnEnd = true;
                }

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
                    console.error(`[pi] Turn error [source=event]: ${msg}`);
                    safeEmit(emitId, { type: "error", value: msg, source: "event" });
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            try {
                const t = chunk.toString();
                if (!t.trim()) return;
                // Always accumulate stderr (stripped of ALL ANSI/control sequences,
                // including Kitty keyboard-protocol and DEC private-mode codes pi
                // emits) so finalize() can surface it as the error message on a
                // silent failure (no output, no turn_end) — e.g. "No API key found
                // for minimax". Stripping before logging is also what prevents pi's
                // raw escape bytes from being echoed into the host terminal and
                // corrupting it (the "shell needs kill+restart" bug).
                const clean = stripAnsi(t);
                stderrBuffer += clean;
                const lines = clean.split('\n').filter(l => l.trim());
                if (lines.length === 0) return;
                // pi writes a LOT of non-error content to stderr: its startup banner
                // (the `────` rule), docs paths (`.../docs/models.md`), and ANSI
                // escape sequences (`^[[?7u`, `^[[?62;22c`). These are NORMAL output,
                // not errors. Emitting every stderr line as `{type:"error"}` made the
                // glasses flash "Agent Error" on every turn (and, with some models,
                // shadow the real response). Only treat stderr as an IMMEDIATE error
                // if a line is unambiguously an error marker; otherwise just log it.
                // (A non-matching real error like "No API key found" is still caught
                // — just later, by finalize()'s silent-failure detection.)
                const isErrorLine = (l) =>
                    /^\s*error:/i.test(l) ||
                    /^\s*panic:/i.test(l) ||
                    /\b(error|fatal|traceback|exception)\b[:\s]/i.test(l);
                const errorLine = lines.find(l => isErrorLine(l));
                if (errorLine) {
                    const errMsg = errorLine.trim();
                    lastError = errMsg;
                    console.error(`[pi] stderr [source=stderr]: ${errMsg}`);
                    safeEmit(emitId, { type: "error", value: errMsg, source: "stderr" });
                } else {
                    // Non-error stderr (banner, docs path). Log for debugging but do
                    // NOT surface to the user — it's not an error. Stripped above so
                    // no raw escape sequence reaches the host terminal.
                    console.log(`[pi] stderr (benign): ${lines[lines.length - 1].trim()}`);
                }
            } catch (dataErr) {
                console.error(`[pi] stderr handler error: ${dataErr.message}`);
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
                // Silent-failure detection: pi sometimes exits with code 0 but
                // produces NO assistant output and NO turn_end event (e.g. a
                // model with no configured API key — "No API key found for
                // minimax" — which pi writes to stderr and then quits). The old
                // logic treated that as success with empty text, so the user
                // saw a blank turn. If we got no response text and no explicit
                // turn_end, treat it as a failure and surface any captured
                // stderr as the error message.
                let resolvedError = lastError;
                let success = code === 0 && !lastError;
                // Detect pi's interactive "Fork this session into current
                // directory?" prompt. When the session's original cwd differs
                // from the backend's cwd, pi prints this prompt to stderr and,
                // because stdin is "ignore", reads EOF (= "N") and exits with no
                // assistant output. It is NOT a real error — the session is still
                // usable (the next prompt reuses the session cwd). Suppress it so
                // it doesn't surface as a confusing "Agent Error" on the glasses.
                const combinedBuffer = `${resolvedError || ""}\n${stderrBuffer}`;
                const isForkPrompt = /Fork this session into current directory\??/i.test(combinedBuffer)
                    && /different project|Session found in/i.test(combinedBuffer);
                if (isForkPrompt) {
                    success = true;
                    resolvedError = undefined;
                    console.log("[pi] suppressed fork-prompt (session cwd differs from backend cwd; not an error)");
                } else if (!fullText && !sawTurnEnd) {
                    success = false;
                    if (!resolvedError && stderrBuffer.trim()) {
                        resolvedError = stderrBuffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
                    }
                    if (!resolvedError) resolvedError = "pi produced no response";
                    console.warn(`[pi] silent failure [source=exit]: code=${code} stderr=${JSON.stringify(resolvedError).slice(0, 200)}`);
                }
                if (session) {
                    if (resolvedError) session.lastError = resolvedError;
                    else session.lastError = undefined;
                }
                session.proc = null;
                safeEmit(emitId, {
                    type: "result",
                    success,
                    text: fullText,
                    provider: "pi",
                    error: resolvedError || undefined,
                });
                safeEmit(emitId, { type: "status", state: "idle" });
            };

            const timer = setTimeout(() => {
                safeEmit(emitId, { type: "error", value: `pi: prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`, source: "timeout" });
                killProcGroup(session.proc, "SIGKILL");
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
        if (s) return { state: s.busy ? "busy" : "idle", provider: "pi", error: s.lastError || undefined };
        // Session isn't tracked by THIS backend instance — it may be running
        // under the pi CLI, another backend process, or pre-existed on disk.
        // Fall back to the JSONL event log, which is the source of truth for
        // "is the agent currently working" regardless of which process owns
        // the turn. Without this, /status says "idle" while /sessions shows
        // the same session as "busy", and the glasses footer sticks at
        // "Waiting for input" even though messages are actively streaming.
        const jsonlState = sessionStatusFromJsonl(sessionId);
        if (jsonlState) return { state: jsonlState, provider: "pi" };
        return null;
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        if (s) return s.busy ? "busy" : "idle";
        return sessionStatusFromJsonl(sessionId) || "idle";
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
            // Walk backwards from the most recent event to determine status.
            for (let i = events.length - 1; i >= 0; i--) {
                const e = events[i];
                if (e.type === "agent_end" || e.type === "turn_end") return "idle";
                if (e.type === "message" && e.message?.role === "assistant" && e.message.stopReason && e.message.stopReason !== "toolUse") return "idle";
                if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "toolResult")) {
                    // The last activity was a user message with no trailing
                    // turn_end — the agent may be working, or it may have
                    // crashed/exited. If the message is old, treat as idle.
                    if (e.timestamp) {
                        const msgTime = new Date(e.timestamp).getTime();
                        if (!isNaN(msgTime) && Date.now() - msgTime > STALE_SESSION_MS) {
                            return "idle";
                        }
                    }
                    return "busy";
                }
            }
            return "idle";
        }
        return null;
    }

    /** Read the first user message from a pi session JSONL file.
 *  The session header (first line) may not have a meaningful title, so
 *  we walk through the first 32KB looking for the first user message. */
function firstUserMessageLine(file) {
    try {
        const buf = Buffer.alloc(32768);
        const fd = openSync(file, "r");
        const bytesRead = readSync(fd, buf, 0, 32768, 0);
        closeSync(fd);
        const text = buf.toString("utf8", 0, bytesRead);
        for (const line of text.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const e = JSON.parse(trimmed);
                if (e.type === "message" && e.message?.role === "user") {
                    const content = e.message.content;
                    if (Array.isArray(content)) {
                        for (const block of content) {
                            if (block.type === "text" && block.text?.trim()) {
                                return block.text.trim();
                            }
                        }
                    } else if (typeof content === "string" && content.trim()) {
                        return content.trim();
                    }
                }
            } catch {}
        }
    } catch {}
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
                if (!title) {
                    const firstMsg = firstUserMessageLine(file);
                    title = firstMsg ? firstMsg.slice(0, 64) : `pi-${sessionEvent.id.split('-')[0]}`;
                }
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
                killProcGroup(proc, "SIGTERM");
                const escalation = setTimeout(() => {
                    if (proc && !proc.killed) {
                        killProcGroup(proc, "SIGKILL");
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
                killProcGroup(s.proc, "SIGTERM");
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
