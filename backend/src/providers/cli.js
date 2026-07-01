/**
 * Tier 2 — generic streaming-JSONL CLI provider.
 *
 * A generalization of the built-in `pi`/`oh-my-pi` providers (see
 * `../pi/provider.js`): spawn a CLI per prompt, read one JSON object per line
 * from stdout, and map fields to Agent Home's events using a user-declared
 * `events` schema. This lets a user describe a `pi`/`oh-my-pi`-family CLI (and
 * any other JSONL-streaming CLI) with zero JavaScript.
 *
 * The user declares, via config:
 *   - `bin` + `args`: how to invoke the CLI, with `{{placeholders}}`
 *   - `events`: which JSON fields mean what (session id, token deltas, result)
 *   - optional `sessionsDir` / `cwdEncoder`: where transcripts live (for
 *     listing/history), reusing the shared transcript helpers
 *
 * Everything the pi provider did bespoke (process-group kill, fork-prompt
 * suppression, TTY/color suppression, timeouts) is available as config toggles
 * with sensible defaults, so a plain non-TUI CLI works out of the box while a
 * pi-class TUI CLI can opt into the hardened behavior.
 */
import { spawn } from "node:child_process";
import { sortSessionList } from "../shared/sort-sessions.js";
import { stripAnsi } from "../shared/ansi.js";
import { debugLog } from "../debug.js";
import {
    listSessionFiles,
    readSessionJsonl,
    readSessionHeader,
    firstUserMessageLine,
} from "./shared/transcripts.js";
import { statSync } from "node:fs";

const DEFAULT_PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY = 50;
const MAX_PHONE_MAP_ENTRIES = 500;

function killProcGroup(proc, signal = "SIGTERM") {
    if (!proc || proc.killed) return;
    try { process.kill(-proc.pid, signal); }
    catch { try { proc.kill(signal); } catch {} }
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

/** Read a dotted path ("a.b.c") off an object; returns undefined if any step is missing. */
function getPath(obj, dotted) {
    if (!dotted || typeof dotted !== "string") return undefined;
    let cur = obj;
    for (const part of dotted.split(".")) {
        if (cur == null) return undefined;
        cur = cur[part];
    }
    return cur;
}

/** Render an args template, substituting {{placeholder}} values. Returns the
 *  concrete args array. A placeholder that resolves to "" is replaced with "". */
function renderArgs(template, vars) {
    return template.map((arg) => {
        if (typeof arg !== "string") return arg;
        return arg.replace(/\{\{(\w+)\}\}/g, (m, key) => {
            const v = vars[key];
            return v === undefined || v === null ? "" : String(v);
        });
    });
}

export function createCliProvider(config, emit) {
    const name = config.name;
    const bin = config.bin;
    const argsTemplate = config.args || [];
    const sessionFlag = config.sessionFlag;
    const thinkingFlag = config.thinkingFlag;
    const defaultModel = config.model;
    const ev = config.events || {};
    const resultMarkers = new Set(ev.resultMarkers || []);
    const thinkingAsText = ev.thinkingAsText === true;
    const sessionsDir = config.sessionsDir || null;
    const cwdEncoder = config.cwdEncoder || null;
    const env = config.env || {};
    // Hardening toggles (default to pi-like behavior so a pi-family CLI works
    // out of the box; set false for a plain non-TUI CLI).
    const detached = config.detached !== false; // default true
    const suppressColor = config.suppressColor !== false; // default true
    const timeoutMs = config.timeoutMs || DEFAULT_PROMPT_TIMEOUT_MS;

    const sessions = new Map();
    const phoneToCli = new Map();

    function getSession(phoneId) {
        if (!phoneId) return null;
        if (sessions.has(phoneId)) return sessions.get(phoneId);
        const cliId = phoneToCli.get(phoneId);
        if (cliId && sessions.has(cliId)) return sessions.get(cliId);
        return null;
    }

    function buildArgs(text, cliSessionId, model, thinking) {
        const vars = {
            text,
            sessionId: cliSessionId || "",
            model: model || defaultModel || "",
            thinking: thinking && thinking !== "off" ? thinking : "",
            yolo: "", // populated by caller if needed
        };
        const args = renderArgs(argsTemplate, vars);
        if (sessionFlag && cliSessionId) {
            args.push(...renderArgs(sessionFlag, vars));
        }
        if (thinkingFlag && vars.thinking) {
            args.push(...renderArgs(thinkingFlag, vars));
        }
        return args;
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const resolvedDir = existing?.cwd || cwd || process.env.PROJECT_DIR || process.cwd();
        const session = existing || { id: null, busy: true, cwd: resolvedDir, proc: null, cliSessionId: null };
        session.busy = true;
        session.cwd = resolvedDir;
        session.lastError = undefined;
        if (!existing && phoneSessionId && !session.cliSessionId) {
            session.cliSessionId = phoneSessionId;
        }
        const emitId = phoneSessionId || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        if (!sessions.has(emitId)) sessions.set(emitId, session);

        const safeEmit = (id, msg) => { try { emit(id, msg); } catch {} };
        safeEmit(emitId, { type: "user_prompt", text });
        safeEmit(emitId, { type: "status", state: "busy" });

        const args = buildArgs(text, session.cliSessionId, model, thinking);
        debugLog(name, "spawning", `${bin} ${args.join(" ")}`);

        const childEnv = { ...process.env, ...env };
        if (suppressColor) {
            childEnv.TERM = "dumb";
            childEnv.NO_COLOR = "1";
            childEnv.FORCE_COLOR = "0";
            childEnv.CLICOLOR = "0";
            childEnv.CI = "1";
        }
        const spawnOpts = {
            cwd: resolvedDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: childEnv,
        };
        if (detached) spawnOpts.detached = true;

        const proc = spawn(bin, args, spawnOpts);
        try { if (detached) proc.unref(); } catch {}
        session.proc = proc;

        let lineBuffer = "";
        let fullText = "";
        let lastError = null;
        let sawResult = false;
        let stderrBuffer = "";

        const textDelta = ev.textDelta || {};
        const tdType = textDelta.type;
        const tdValue = textDelta.value;
        const tdNestedType = textDelta.nestedType;

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

                const etype = event.type;

                // Session-id capture
                if (ev.sessionId && getPath(event, ev.sessionId)) {
                    const realId = getPath(event, ev.sessionId);
                    if (!session.cliSessionId) {
                        session.cliSessionId = realId;
                        if (emitId !== realId) setBoundedMapping(phoneToCli, emitId, realId);
                        if (phoneSessionId) setBoundedMapping(phoneToCli, phoneSessionId, realId);
                        if (promptResolver) promptResolver();
                    }
                    continue;
                }

                // Result markers → completion
                if (resultMarkers.has(etype)) {
                    sawResult = true;
                    continue;
                }

                // Token delta
                if (tdType && etype === tdType) {
                    const innerType = tdNestedType ? getPath(event, tdNestedType) : undefined;
                    const value = tdValue ? getPath(event, tdValue) : undefined;
                    if (typeof value === "string") {
                        const isText = tdNestedType ? innerType === "text_delta" : true;
                        const isThinking = tdNestedType ? innerType === "thinking_delta" : false;
                        if (isText || (isThinking && thinkingAsText)) {
                            fullText += value;
                            session.partialText = fullText;
                            safeEmit(emitId, { type: "text_delta", text: value });
                        }
                    }
                    continue;
                }

                // Error event
                if (etype === "error" || event.error) {
                    const msg = event.error?.message || event.message || event.value || String(event);
                    lastError = msg;
                    console.error(`[${name}] event error: ${msg}`);
                    safeEmit(emitId, { type: "error", value: msg, source: "event" });
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            try {
                const t = chunk.toString();
                if (!t.trim()) return;
                const clean = stripAnsi(t);
                stderrBuffer += clean;
                const lines = clean.split("\n").filter((l) => l.trim());
                const isErrorLine = (l) =>
                    /^\s*error:/i.test(l) ||
                    /^\s*panic:/i.test(l) ||
                    /\b(error|fatal|traceback|exception)\b[:\s]/i.test(l);
                const errorLine = lines.find((l) => isErrorLine(l));
                if (errorLine) {
                    const errMsg = errorLine.trim();
                    lastError = errMsg;
                    console.error(`[${name}] stderr: ${errMsg}`);
                    safeEmit(emitId, { type: "error", value: errMsg, source: "stderr" });
                } else if (lines.length) {
                    console.log(`[${name}] stderr (benign): ${lines[lines.length - 1].trim()}`);
                }
            } catch (dataErr) {
                console.error(`[${name}] stderr handler error: ${dataErr.message}`);
            }
        });

        let promptResolver = null;
        return new Promise((resolvePromise) => {
            let promptResolved = false;
            promptResolver = () => {
                if (promptResolved) return;
                promptResolved = true;
                clearTimeout(resolveTimer);
                const canonicalId = session.cliSessionId || (phoneSessionId || emitId);
                resolvePromise({ sessionId: canonicalId, provider: name });
            };
            const resolveTimer = setTimeout(promptResolver, 3000);
            proc.once("spawn", () => {
                if (session.cliSessionId) {
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
                session.proc = null;

                let resolvedError = lastError;
                let success = code === 0 && !lastError;
                // Silent-failure detection: exit 0 with no text and no result
                // marker → treat as failure (e.g. "No API key found" on stderr).
                if (!fullText && !sawResult) {
                    success = false;
                    if (!resolvedError && stderrBuffer.trim()) resolvedError = stderrBuffer.trim();
                    if (!resolvedError) resolvedError = `${name} produced no response`;
                }
                session.lastError = resolvedError || undefined;
                session.partialText = undefined;
                safeEmit(emitId, {
                    type: "result",
                    success,
                    text: fullText,
                    provider: name,
                    error: resolvedError || undefined,
                });
                safeEmit(emitId, { type: "status", state: "idle" });
            };

            const timer = setTimeout(() => {
                safeEmit(emitId, { type: "error", value: `${name}: prompt timed out after ${timeoutMs / 1000}s`, source: "timeout" });
                if (detached) killProcGroup(session.proc, "SIGKILL");
                else { try { session.proc?.kill("SIGKILL"); } catch {} }
                finalize(124);
            }, timeoutMs);

            proc.on("close", (code) => finalize(code));
            proc.on("error", (err) => {
                safeEmit(emitId, { type: "error", value: err.message });
                finalize(1);
            });
        });
    }

    // ---- on-disk transcript session listing/history (optional) ----
    function buildSessionList(cwd) {
        if (!sessionsDir) return [];
        const files = listSessionFiles({ sessionsDir, cwd, encoder: cwdEncoder });
        const result = [];
        for (const file of files) {
            try {
                const header = readSessionHeader(file);
                if (!header) continue;
                const sid = getPath(header, ev.sessionId) || header.id;
                if (!sid) continue;
                const stats = statSync(file);
                if (stats.size < 300) continue;
                let title = (header.title || "").toString().slice(0, 64).trim();
                if (!title) {
                    const firstMsg = firstUserMessageLine(file);
                    title = firstMsg ? firstMsg.slice(0, 64) : `${name}-${String(sid).split("-")[0]}`;
                }
                result.push({
                    id: sid,
                    title,
                    timestamp: stats.mtime.toISOString(),
                    cwd: header.cwd || cwd || "",
                    provider: name,
                    status: null,
                });
            } catch {}
        }
        sortSessionList(result);
        return result;
    }

    function listSessions(limit, cwd) {
        // In-memory (always available) on top of on-disk (if configured).
        const result = [];
        for (const [id, s] of sessions) {
            const lastMsg = s.partialText || (s.messages && s.messages.length ? s.messages[s.messages.length - 1] : "");
            result.push({
                id,
                title: String(lastMsg).slice(0, 64),
                timestamp: new Date().toISOString(),
                cwd: s.cwd || "",
                provider: name,
                status: s.busy ? "busy" : null,
            });
        }
        const existingIds = new Set(result.map((r) => r.id));
        for (const s of buildSessionList(cwd)) {
            if (!existingIds.has(s.id)) result.push(s);
        }
        return sortSessionList(result).slice(0, limit || 20);
    }

    function getHistory(sessionId, limit) {
        const resolvedId = phoneToCli.get(sessionId) || sessionId;
        const max = Math.min(limit || 10, MAX_HISTORY);

        // In-memory (busy session partial text) takes precedence.
        const s = getSession(sessionId);
        if (s && s.busy && s.partialText) {
            return [{ role: "assistant", text: s.partialText }];
        }

        if (!sessionsDir) return [];
        const files = listSessionFiles({ sessionsDir, cwd: null, encoder: cwdEncoder });
        for (const file of files) {
            const events = readSessionJsonl(file);
            const header = events[0];
            const sid = (header && getPath(header, ev.sessionId)) || (header && header.id);
            if (sid !== sessionId && sid !== resolvedId) continue;
            const history = [];
            for (const e of events) {
                const role = e.message?.role || e.role;
                if (role !== "user" && role !== "assistant") continue;
                const content = e.message?.content ?? e.content;
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (c && typeof c.text === "string") history.push({ role, text: c.text });
                    }
                } else if (typeof content === "string") {
                    history.push({ role, text: content });
                }
            }
            return history.slice(-max);
        }
        return [];
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (s) return { state: s.busy ? "busy" : "idle", provider: name, error: s.lastError || undefined };
        return null;
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        return s?.busy ? "busy" : "idle";
    }

    function getInfo() {
        return {
            account: { email: `${defaultModel || name} (via cli)`, organization: name },
            model: defaultModel || name,
            version: "cli",
            provider: name,
        };
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s && s.proc && !s.proc.killed) {
            const proc = s.proc;
            try {
                if (detached) {
                    killProcGroup(proc, "SIGTERM");
                    const escalation = setTimeout(() => {
                        if (proc && !proc.killed) killProcGroup(proc, "SIGKILL");
                    }, 2000);
                    proc.once("close", () => clearTimeout(escalation));
                } else {
                    proc.kill("SIGTERM");
                    const escalation = setTimeout(() => {
                        if (proc && !proc.killed) proc.kill("SIGKILL");
                    }, 2000);
                    proc.once("close", () => clearTimeout(escalation));
                }
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
                try {
                    if (detached) killProcGroup(s.proc, "SIGTERM");
                    else s.proc.kill("SIGTERM");
                } catch {}
            }
            s.busy = false;
            s.proc = null;
        }
    }

    return {
        prompt, listSessions, getHistory, getStatus, interrupt,
        getSessionStatus, getInfo, respondPermission, respondQuestion, dispose,
    };
}
