import { spawn, execSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from "node:fs";
import { sortSessionList } from "../shared/sort-sessions.js";
import { resolve, relative, isAbsolute, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { debugLog } from "../debug.js";

/**
 * oh-my-pi (omp) provider.
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
 *   agent_end / proc.close → {type:"result", success, text, provider:"oh-my-pi"}
 *   thinking_delta         → {type:"text_delta", text} (phone has no thinking type, so show as text)
 *   err / stderr           → {type:"error", value}
 *
 * Sessions are stored by omp at ~/.omp/agent/sessions/<encoded-cwd>/<file>.jsonl.
 * The phone generates UUID session IDs; we map them to omp session IDs via
 * phoneToOmp (the omp session ID is captured from the first {type:"session"} event).
 *
 * omp manages its own credentials (LiteLLM, Bitwarden) via ~/.omp/agent/agent.db
 * and ~/.omp/agent/models.yml — no env loading needed here.
 */

const OMP_BIN = process.env.OMP_BIN || "omp";
const OMP_HOME = process.env.OMP_HOME || join(homedir(), ".omp");
const SESSIONS_DIR = join(OMP_HOME, "agent", "sessions");
const SESSION_CACHE_TTL_MS = 30000;
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY = 50;
const MAX_PHONE_MAP_ENTRIES = 500;

// Kill the whole omp process GROUP. omp is spawned detached (its own session)
// so it can't grab the backend's controlling TTY; killing just the leader
// would orphan its subprocesses. Negative PID = signal the whole group.
function killProcGroup(proc, signal = "SIGTERM") {
    if (!proc || proc.killed) return;
    try { process.kill(-proc.pid, signal); }
    catch { try { proc.kill(signal); } catch {} }
}
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

export function createOhMyPiProvider(emit) {
    const sessions = new Map();
    const phoneToOmp = new Map();
    const sessionCaches = new Map(); // cwd -> { data: [], time: ms }

    function getSession(phoneId) {
        if (!phoneId) return null;
        if (sessions.has(phoneId)) return sessions.get(phoneId);
        const ompId = phoneToOmp.get(phoneId);
        if (ompId && sessions.has(ompId)) return sessions.get(ompId);
        return null;
    }

    function buildArgs(text, ompSessionId, model, thinking, yolo) {
        const args = [
            "-p",
            "--mode", "json",
            "--no-extensions",
            "--no-skills",
            "--no-rules",
        ];
        if (yolo) {
            args.push("--auto-approve");
        }
        if (model) {
            args.push("--model", model);
        } else if (process.env.OMP_MODEL) {
            args.push("--model", process.env.OMP_MODEL);
        }
        if (thinking && thinking !== "off") {
            args.push("--thinking", thinking);
        }
        if (ompSessionId) {
            args.push("--resume", ompSessionId);
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
            existing || { id: null, busy: true, cwd: resolvedDir, proc: null, ompSessionId: null, partialText: "" };
        session.busy = true;
        session.cwd = resolvedDir;
        // When resuming an external session (not in memory), use the frontend-provided
        // session ID as the omp session ID so --resume works.
        if (!existing && phoneSessionId && !session.ompSessionId) {
            session.ompSessionId = phoneSessionId;
        }
        session.cwd = resolvedDir;
        session.partialText = "";

        const emitId = phoneSessionId || `oh-my-pi-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!sessions.has(emitId)) sessions.set(emitId, session);
        if (phoneSessionId && session.ompSessionId) {
            setBoundedMapping(phoneToOmp, phoneSessionId, session.ompSessionId);
        }

        const safeEmit = (id, msg) => { try { emit(id, msg); } catch {} };
        safeEmit(emitId, { type: "user_prompt", text });
        safeEmit(emitId, { type: "status", state: "busy" });

        const args = buildArgs(text, session.ompSessionId, model, thinking, yolo);
        debugLog("oh-my-pi", "spawning", `${OMP_BIN} ${args.join(" ")}`);

        const proc = spawn(OMP_BIN, args, {
            cwd: resolvedDir,
            stdio: ["ignore", "pipe", "pipe"],
            // Run omp in its OWN process group/session so it cannot grab the
            // backend's controlling TTY. omp (like pi) is a TUI app; even with
            // piped stdio it opens /dev/tty directly and emits raw terminal
            // control codes, corrupting the backend's shell into an
            // irrecoverable raw-mode state. detached: true = new session
            // (setsid) with no controlling terminal. Drop TTY/color env too.
            detached: true,
            env: {
                ...process.env,
                TERM: "dumb",
                NO_COLOR: "1",
                FORCE_COLOR: "0",
                CLICOLOR: "0",
                CI: "1",
            },
        });
        try { proc.unref(); } catch {}
        session.proc = proc;

        let lineBuffer = "";
        let fullText = "";
        let lastError = null;  // track turn-level errors (model failures, etc.)
        let sawTurnEnd = false;  // did omp emit a turn_end/agent_end event?
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

                // Track whether omp signaled turn completion. finalize() uses
                // this to distinguish an empty-but-completed turn from a silent
                // failure (omp quit without ever starting the model, e.g. a
                // provider with no API key).
                if (event.type === "turn_end" || event.type === "agent_end") {
                    sawTurnEnd = true;
                }

                if (event.type === "session" && event.id) {
                    if (!session.ompSessionId) {
                        session.ompSessionId = event.id;
                        if (emitId !== event.id) {
                            setBoundedMapping(phoneToOmp, emitId, event.id);
                        }
                        if (phoneSessionId) setBoundedMapping(phoneToOmp, phoneSessionId, event.id);
                        // Got the real ID — resolve prompt now so frontend polls with canonical ID
                        if (promptResolver) promptResolver();
                    }
                    continue;
                }

                if (event.type === "message_update" && event.assistantMessageEvent) {
                    const inner = event.assistantMessageEvent;
                    if (inner.type === "text_delta" && typeof inner.delta === "string") {
                        fullText += inner.delta;
                        session.partialText += inner.delta;
                        safeEmit(emitId, { type: "text_delta", text: inner.delta });
                    } else if (inner.type === "thinking_delta" && typeof inner.delta === "string") {
                        fullText += inner.delta;
                        session.partialText += inner.delta;
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
                    console.error(`[oh-my-pi] Turn error: ${msg}`);
                    safeEmit(emitId, { type: "error", value: msg });
                }
                // Detect turn-level error (model failure, HTTP error, etc.)
                if (event.type === "message_end" && event.message?.stopReason === "error") {
                    const errMsg = event.message?.errorMessage || `Error: ${event.message?.stopReason}`;
                    lastError = errMsg;
                    console.error(`[oh-my-pi] Model error: ${errMsg}`);
                    safeEmit(emitId, { type: "error", value: errMsg });
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            const t = chunk.toString();
            if (!t.trim()) return;
            // Always accumulate stderr (stripped of ANSI) so finalize() can
            // surface it as the error message on a silent failure (no output,
            // no turn_end) — e.g. a provider with no configured API key.
            stderrBuffer += t.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
            const lines = t.split('\n').filter(l => l.trim());
            // oh-my-pi (like pi) writes non-error content to stderr: startup
            // banner, docs paths, ANSI escapes, Bun/Node debug traces. Emitting
            // every stderr line as {type:"error"} made the glasses flash
            // "Agent Error" briefly on every turn. Only genuine error markers
            // are surfaced immediately; a non-matching real error is still
            // caught later by finalize()'s silent-failure detection.
            const isErrorLine = (l) =>
                /^\s*error:/i.test(l) ||
                /^\s*panic:/i.test(l) ||
                /\b(error|fatal|traceback|exception)\b[:\s]/i.test(l);
            const errorLine = lines.find(l => isErrorLine(l));
            if (errorLine) {
                const errMsg = errorLine.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
                lastError = errMsg;
                console.error(`[oh-my-pi] stderr (error): ${errMsg}`);
                safeEmit(emitId, { type: "error", value: errMsg });
            } else {
                console.log(`[oh-my-pi] stderr: ${lines[lines.length - 1].trim()}`);
            }
        });

        let promptResolver = null;
        return new Promise((resolvePromise) => {
            let promptResolved = false;
            promptResolver = () => {
                if (promptResolved) return;
                promptResolved = true;
                clearTimeout(resolveTimer);
                const canonicalId = session.ompSessionId || (phoneSessionId || emitId);
                resolvePromise({ sessionId: canonicalId, provider: "oh-my-pi" });
            };
            const resolveTimer = setTimeout(promptResolver, 3000);
            proc.once("spawn", () => {
                if (session.ompSessionId) {
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
                // Silent-failure detection: omp may exit (code 0) producing NO
                // assistant output and NO turn_end event (e.g. a provider with
                // no configured API key, which omp writes to stderr and then
                // quits). The old logic reported success-with-empty-text, so the
                // user saw a blank turn. Surface the captured stderr as the
                // error when there's no output and no turn_end.
                let resolvedError = lastError;
                let success = code === 0 && !lastError;
                if (!fullText && !sawTurnEnd) {
                    success = false;
                    if (!resolvedError && stderrBuffer.trim()) {
                        resolvedError = stderrBuffer.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
                    }
                    if (!resolvedError) resolvedError = "oh-my-pi produced no response";
                    console.warn(`[oh-my-pi] silent failure [source=exit]: code=${code} stderr=${JSON.stringify(resolvedError).slice(0, 200)}`);
                }
                // Store error on session for status endpoint
                if (resolvedError && session) session.lastError = resolvedError;
                session.proc = null;
                safeEmit(emitId, {
                    type: "result",
                    success,
                    text: fullText,
                    provider: "oh-my-pi",
                    error: resolvedError || undefined,
                });
                safeEmit(emitId, { type: "status", state: "idle" });
            };

            const timer = setTimeout(() => {
                safeEmit(emitId, { type: "error", value: `oh-my-pi: prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`, source: "timeout" });
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
        if (s) return { state: s.busy ? "busy" : "idle", provider: "oh-my-pi", error: s.lastError || undefined };
        return null;
    }

    function getSessionStatus(sessionId) {
        const status = getStatus(sessionId);
        return status ? status.state : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync(`${OMP_BIN} --version`, {
                timeout: 3000,
                encoding: "utf8",
                shell: process.env.SHELL || "sh",
            }).trim();
        } catch {}
        const model = process.env.OMP_MODEL || "omp-default";
        return {
            account: { email: `${model} (via oh-my-pi)`, organization: "oh-my-pi" },
            model,
            version: version || "Unknown",
            provider: "oh-my-pi",
        };
    }


    /** Derive session status ("busy"/"idle") from persisted JSONL data.
     *  Uses the same isBusy logic as getHistory(). */
    function sessionStatusFromJsonl(sessionId) {
        const files = listAllSessionFiles();
        for (const file of files) {
            const headers = readSessionHeader(file);
            if (!headers[0] || headers[0].id !== sessionId) continue;
            const events = readSessionJsonl(file);
            let isBusy = false;
            for (const e of events) {
                if (e.type === "message" && e.message) {
                    const role = e.message.role;
                    if (role === "user" || role === "toolResult") {
                        isBusy = true;
                    } else if (role === "assistant") {
                        isBusy = e.stopReason === "toolUse";
                    }
                }
                if (e.type === "agent_end" || e.type === "turn_end") {
                    isBusy = false;
                }
            }
            return isBusy ? "busy" : "idle";
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
                if (!title) title = `omp-${sessionEvent.id.split('-')[0]}`;
                result.push({
                    id: sessionEvent.id,
                    title,
                    timestamp: stats.mtime.toISOString(),
                    cwd: sessionEvent.cwd || cwd || "",
                    provider: "oh-my-pi",
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
        // Resolve emitId (phone-frontend ID) to omp session ID via mapping
        const resolvedId = phoneToOmp.get(sessionId) || sessionId;
        for (const file of files) {
            const headers = readSessionHeader(file);
            if (!headers[0] || (headers[0].id !== sessionId && headers[0].id !== resolvedId)) continue;
            
            const events = readSessionJsonl(file);
            const sessionEvent = headers[0];
            const history = [];
            let partialText = "";
            let isBusy = false;
            
            for (const e of events) {
                if (e.type === "message" && e.message) {
                    const role = e.message.role;
                    if (role === "user" || role === "toolResult") {
                        isBusy = true;
                    } else if (role === "assistant") {
                        isBusy = e.stopReason === "toolUse";
                    }
                }
                if (e.type === "agent_end" || e.type === "turn_end") {
                    isBusy = false;
                }
                
                if (e.type === "text_delta" || e.type === "thinking_delta") {
                    partialText += e.text || "";
                }
                
                if (e.type !== "message" || !e.message?.content) continue;
                const role = e.message.role;
                if (role !== "user" && role !== "assistant") continue;
                const content = e.message.content;
                if (!Array.isArray(content)) continue;
                for (const c of content) {
                    if (c?.type === "text" && typeof c.text === "string") {
                        history.push({ role, text: c.text });
                        if (role === "assistant") partialText = ""; // reset partial on full message
                    }
                }
            }
            const max = Math.min(limit || 10, MAX_HISTORY);
            const result = history.slice(-max);
            
            const activeSession = getSession(sessionId) || getSession(sessionEvent.id);
            if (activeSession && activeSession.busy && activeSession.partialText) {
                result.push({ role: "assistant", text: activeSession.partialText });
            } else if (isBusy) {
                // If it's busy in an external terminal, append its partial text
                result.push({ role: "assistant", text: partialText ? partialText : "Thinking..." });
            }
            return result;
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
