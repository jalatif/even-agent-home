import { spawn, execSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sortSessionList } from "../shared/sort-sessions.js";
import { debugLog } from "../debug.js";

/**
 * antigravity (agy) provider.
 *
 * Wraps the `agy` CLI (Antigravity) the same way `oh-my-pi/provider.js` wraps
 * `omp`.  Each prompt spawns one `agy -p` subprocess.  The CLI is batched
 * (like `claude --print`) — stdout is delivered only after the process exits,
 * so we cannot stream incremental `text_delta` events.  Best we can do is one
 * `text_delta` carrying the full response text, followed by a `result` and
 * `status:idle`.
 *
 * Session continuity uses the `agy` `--conversation <uuid>` flag, mirroring
 * `omp --resume <ompSessionId>`.  The phone generates UUID session IDs, so
 * we maintain a `phoneToAgy` map: phoneId → agy conversation UUID.
 *
 * Detecting the agy UUID for a fresh prompt is tricky: `agy -p` does NOT
 * print the conversation ID on stdout.  The conversation directory is
 * created at `~/.gemini/antigravity-cli/brain/<uuid>/` during the run.  We
 * snapshot the brain-dir mtimes before spawning and pick the dir with a
 * newer mtime after the process exits.  For resume we already know the UUID
 * from `phoneToAgy` and the same dir is reused (no new one is created).
 *
 * Storage layout:
 *   ~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl
 *   ~/.gemini/antigravity-cli/history.jsonl   (recent prompts with `workspace`)
 *
 * Transcript format (JSONL, one event per line):
 *   {step_index, source:"USER_EXPLICIT", type:"USER_INPUT", content:"<USER_REQUEST>..."}
 *   {step_index, source:"SYSTEM",        type:"CONVERSATION_HISTORY"}
 *   {step_index, source:"MODEL",         type:"PLANNER_RESPONSE", content, thinking}
 *
 * Cross-cutting patterns applied (see AGENTS.md):
 *   #1 phoneToAgy session ID map
 *   #3 per-cwd session cache with TTL (30s)
 *   #4 provider override (agy absorbs `claude`/`codex` from the phone)
 *   #5 session-dir layout replicated exactly
 *   #7 CLI-subprocess hardening (timeout, SIGKILL escalation, safeEmit)
 *   #8 session listing reads only the file header (4KB)
 */

const AGY_BIN = process.env.AGY_BIN || "agy";
const AGY_HOME = process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
const BRAIN_DIR = join(AGY_HOME, "brain");
const HISTORY_FILE = join(AGY_HOME, "history.jsonl");
const SESSION_CACHE_TTL_MS = 30000;
const PROMPT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_HISTORY = 50;
const HEADER_BYTES = 4096;

/** Strip agy's <USER_REQUEST> / <ADDITIONAL_METADATA> markup from prompt content. */
function stripRequestMarkup(content) {
    if (typeof content !== "string") return "";
    return content
        .replace(/<USER_REQUEST>\s*/g, "")
        .replace(/<\/USER_REQUEST>/g, "")
        .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
        .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
        .trim();
}

function listAllBrainDirs() {
    if (!existsSync(BRAIN_DIR)) return [];
    try {
        if (!statSync(BRAIN_DIR).isDirectory()) return [];
        return readdirSync(BRAIN_DIR)
            .filter((d) => /^[0-9a-f-]{36}$/i.test(d))
            .map((d) => join(BRAIN_DIR, d));
    } catch {
        return [];
    }
}

function findTranscriptFile(brainDir) {
    // Both `transcript.jsonl` and `transcript_full.jsonl` exist.  Prefer
    // the `_full` variant which is identical in content but the canonical
    // path for the provider to read from.
    const full = join(brainDir, ".system_generated", "logs", "transcript_full.jsonl");
    if (existsSync(full)) return full;
    const plain = join(brainDir, ".system_generated", "logs", "transcript.jsonl");
    if (existsSync(plain)) return plain;
    return null;
}

/** Read only the first 4KB of a transcript file and parse the first JSON line.
 *  ~100x faster than reading the entire file when listing sessions. */
function readTranscriptHeader(file) {
    try {
        const buf = Buffer.alloc(HEADER_BYTES);
        const fd = openSync(file, "r");
        const bytesRead = readSync(fd, buf, 0, HEADER_BYTES, 0);
        closeSync(fd);
        const firstNewline = buf.indexOf(10, 0); // '\n'
        const len = firstNewline >= 0 ? firstNewline : bytesRead;
        const line = buf.toString("utf8", 0, len).trim();
        if (!line) return [];
        const parsed = JSON.parse(line);
        return parsed && parsed.type ? [parsed] : [];
    } catch {
        return [];
    }
}

function readTranscriptJsonl(file) {
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

/** Walk the brain dir mtimes to find the conversation directory created or
 *  updated by the most recent `agy -p` invocation.  `agy` does not print
 *  the new UUID on stdout, so we rely on the filesystem: snapshot the
 *  set of (mtime, dir) pairs before spawning, then after the process
 *  exits pick the dir with the newest mtime within the prompt window.
 *  This works for both fresh prompts (new dir appears) and resume
 *  (existing dir mtime updates). */
function snapshotBrainMtimes() {
    // Track mtime of each brain dir's transcript file.  `agy` may not
    // bump the brain dir mtime on resume (it only appends to the
    // transcript), so we look at the transcript file itself.
    const snap = new Map();
    for (const dir of listAllBrainDirs()) {
        const transcript = findTranscriptFile(dir);
        if (!transcript) continue;
        try {
            snap.set(dir, statSync(transcript).mtimeMs);
        } catch {}
    }
    return snap;
}

function findChangedBrainDir(before, startMs) {
    let best = null;
    let bestMtime = startMs;
    for (const dir of listAllBrainDirs()) {
        const transcript = findTranscriptFile(dir);
        if (!transcript) continue;
        let mtime = 0;
        try {
            mtime = statSync(transcript).mtimeMs;
        } catch {
            continue;
        }
        const prev = before.get(dir);
        // A brain dir is "ours" if it didn't exist before OR its
        // transcript mtime advanced past what we saw in the snapshot
        // AND it sits inside the prompt window.
        const isNew = prev === undefined;
        const isUpdated = prev !== undefined && mtime > prev + 1;
        if ((isNew || isUpdated) && mtime >= startMs - 1000 && mtime > bestMtime) {
            best = dir;
            bestMtime = mtime;
        }
    }
    return best;
}

/** Read the most recent prompt from history.jsonl (across the whole CLI history). */
function readHistoryIndex() {
    if (!existsSync(HISTORY_FILE)) return [];
    try {
        const text = readFileSync(HISTORY_FILE, "utf8");
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

export function createAntigravityProvider(emit) {
    const sessions = new Map();
    const phoneToAgy = new Map();
    const sessionCaches = new Map(); // cwd -> { data: [], time: ms }
    const procBySession = new Map(); // phoneSessionId -> ChildProcess
    function buildArgs(text, agyUuid) {
        // `agy -p` consumes the first non-flag arg as the prompt.  All
        // boolean/value flags must come BEFORE `-p`, otherwise they are
        // treated as the prompt itself.  Order: --dangerously-skip-permissions
        // first, then --conversation / --model flags, then `-p`, then
        // the prompt.
        const args = ["--dangerously-skip-permissions"];
        if (agyUuid) {
            args.push("--conversation", agyUuid);
        }
        if (process.env.AGY_MODEL) {
            args.push("--model", process.env.AGY_MODEL);
        }
        args.push("-p", text);
        return args;
    }

    async function prompt(phoneSessionId, text, cwd) {

        const resolvedDir = cwd || process.env.PROJECT_DIR || process.cwd();

        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const emitId = phoneSessionId || `antigravity-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const session = existing || {
            id: emitId,
            busy: false,
            cwd: resolvedDir,
            agyUuid: null,
        };
        session.busy = true;
        session.cwd = resolvedDir;
        sessions.set(emitId, session);

        // If the phone sent back a known agy conversation UUID via a prior
        // prompt, use it.  Otherwise pass nothing and discover after exit.
        const agyUuid = session.agyUuid || (phoneSessionId ? phoneToAgy.get(phoneSessionId) : null) || null;

        const safeEmit = (id, msg) => { try { emit(id, msg); } catch {} };
        safeEmit(emitId, { type: "user_prompt", text });
        safeEmit(emitId, { type: "status", state: "busy" });

        const args = buildArgs(text, agyUuid);
        debugLog("antigravity", "spawning", `${AGY_BIN} ${args.join(" ")}`);

        const beforeSnapshot = snapshotBrainMtimes();
        const startedAt = Date.now();

        const proc = spawn(AGY_BIN, args, {
            cwd: resolvedDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env },
        });
        let stdout = "";
        let stderr = "";
        procBySession.set(emitId, proc);

        // `agy -p` is fully batched today — stdout arrives in one chunk
        // after the process exits.  We still accumulate in chunks so a
        // future streaming mode would work without changes.
        proc.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });

        proc.stderr.on("data", (chunk) => {
            const t = chunk.toString();
            stderr += t;
            if (t.trim()) {
                // `agy` prints installer / status info on stderr (e.g. the
                // I0614... installer log).  Filter those out and only
                // forward meaningful errors to the phone.
                if (/error|fatal|panic|fail/i.test(t)) {
                    safeEmit(emitId, { type: "error", value: t.trim() });
                }
            }
        });

        return new Promise((resolvePromise) => {
            let settled = false;
            const finalize = (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                session.busy = false;
                procBySession.delete(emitId);

                // If we don't have an agy UUID yet, find the brain dir that
                // was created or updated during this prompt.
                if (!session.agyUuid) {
                    const brainDir = findChangedBrainDir(beforeSnapshot, startedAt);
                    if (brainDir) {
                        const uuid = brainDir.split("/").pop();
                        session.agyUuid = uuid;
                        if (phoneSessionId) phoneToAgy.set(phoneSessionId, uuid);
                    }
                }

                // Strip a leading newline that agy sometimes emits; keep
                // everything else verbatim — the response text is what
                // the user sees on the phone.
                const text = stdout.replace(/^\s+/, "").replace(/\s+$/, "");

                if (code === 0) {
                    if (text) safeEmit(emitId, { type: "text_delta", text });
                    safeEmit(emitId, {
                        type: "result",
                        success: true,
                        text,
                        provider: "antigravity",
                    });
                } else {
                    const errMsg = stderr.trim() || text || `agy exited with code ${code}`;
                    safeEmit(emitId, { type: "error", value: errMsg });
                    safeEmit(emitId, {
                        type: "result",
                        success: false,
                        text,
                        provider: "antigravity",
                    });
                }
                safeEmit(emitId, { type: "status", state: "idle" });
                resolvePromise({ sessionId: emitId, provider: "antigravity" });
            };

            const timer = setTimeout(() => {
                safeEmit(emitId, {
                    type: "error",
                    value: `antigravity: prompt timed out after ${PROMPT_TIMEOUT_MS / 1000}s`,
                });
                try {
                    if (proc && !proc.killed) proc.kill("SIGKILL");
                } catch {}
                finalize(124);
            }, PROMPT_TIMEOUT_MS);

            proc.on("close", (code) => finalize(code ?? 0));
            proc.on("error", (err) => {
                safeEmit(emitId, { type: "error", value: err.message });
                finalize(1);
            });
        });
    }

    function getSession(phoneId) {
        if (!phoneId) return null;
        if (sessions.has(phoneId)) return sessions.get(phoneId);
        return null;
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);

        if (!s) return null;
        return { state: s.busy ? "busy" : "idle", provider: "antigravity" };
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        return s?.busy ? "busy" : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync(`${AGY_BIN} --version`, {
                timeout: 3000,
                encoding: "utf8",
                shell: process.env.SHELL || "sh",
            }).trim();
        } catch {}
        const model = process.env.AGY_MODEL || "agy-default";
        return {
            account: { email: `${model} (via antigravity)`, organization: "antigravity" },
            model,
            version: version || "Unknown",
            provider: "antigravity",
        };
    }

    function listSessionsForCwd(cwd) {
        // For a given cwd we use the agy `history.jsonl` index to find
        // recent prompts with that workspace, then map each prompt to its
        // conversation UUID.  `agy` doesn't store a workspace per brain
        // dir, so we infer by matching the most recent prompt timestamp
        // for each workspace against the brain dir mtimes.
        const history = readHistoryIndex();
        const matchingUuids = new Map(); // uuid -> latest timestamp
        for (const entry of history) {
            if (!entry || entry.workspace !== cwd) continue;
            // history.jsonl doesn't carry conversation IDs, so this is
            // best-effort.  We rely on `agy -p` having written a brain
            // dir with a matching mtime for each entry.  The brain dir
            // mapping happens in the prompt path, so this function only
            // surfaces conversations we already know about.
        }

        // Walk all brain dirs; emit a session entry per dir.  This is the
        // same approach omp/opencode take when there's no per-cwd
        // metadata in the session file itself.
        const allDirs = listAllBrainDirs();
        const result = [];
        for (const dir of allDirs) {
            const transcript = findTranscriptFile(dir);
            if (!transcript) continue;
            const headers = readTranscriptHeader(transcript);
            const firstUserInput = headers[0];
            if (!firstUserInput || firstUserInput.type !== "USER_INPUT") continue;
            const uuid = dir.split("/").pop();
            const prompt = stripRequestMarkup(firstUserInput.content || "");
            const mtime = (() => { try { return statSync(transcript).mtime; } catch { return new Date(0); } })();
            result.push({
                id: uuid,
                title: prompt.slice(0, 64),
                timestamp: mtime.toISOString(),
                cwd: cwd || "",
                provider: "antigravity",
                status: null,
            });
        }
        return result;
    }

    function listSessions(limit, cwd) {
        const key = cwd || "*";
        const now = Date.now();
        const cached = sessionCaches.get(key);
        if (cached && now - cached.time < SESSION_CACHE_TTL_MS) {
            return cached.data.slice(0, limit || 10);
        }
        const data = listSessionsForCwd(cwd);
        sortSessionList(data);
        sessionCaches.set(key, { data, time: now });
        return data.slice(0, limit || 10);
    }

    function getHistory(sessionId, limit) {
        // Resolve the session ID back to an agy brain dir.  The phone may
        // pass either an agy UUID directly (from a previous listSessions
        // call) or a phone session ID.  We try both lookups.
        const agyUuid = phoneToAgy.get(sessionId) || sessionId;
        const brainDir = join(BRAIN_DIR, agyUuid);
        const transcript = findTranscriptFile(brainDir);
        if (!transcript) return [];
        const events = readTranscriptJsonl(transcript);
        const history = [];
        for (const e of events) {
            if (e.type === "USER_INPUT" && typeof e.content === "string") {
                history.push({ role: "user", text: stripRequestMarkup(e.content) });
            } else if (e.type === "PLANNER_RESPONSE" && typeof e.content === "string") {
                history.push({ role: "assistant", text: e.content });
            }
        }
        const max = Math.min(limit || 10, MAX_HISTORY);
        return history.slice(-max);
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const proc = procBySession.get(sessionId);
        if (proc && !proc.killed) {
            try {
                proc.kill("SIGTERM");
                setTimeout(() => {
                    if (proc && !proc.killed) {
                        try { proc.kill("SIGKILL"); } catch {}
                    }
                }, 2000);
            } catch {}
        }
        const s = getSession(sessionId);
        if (s) s.busy = false;
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
    };
}
