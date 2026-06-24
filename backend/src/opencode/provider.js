import { spawn, execSync, execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { debugLog } from "../debug.js";
import { sortSessionList } from "../shared/sort-sessions.js";

const OPENCODE_BIN = resolve(homedir(), ".opencode", "bin", "opencode");
const SERVER_PASSWORD = `agent-home-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const OPENCODE_CONFIG_PATH = resolve(homedir(), ".config", "opencode", "opencode.json");
const MAX_PHONE_MAP_ENTRIES = 500;

function findOpenCodeBin() {
    return existsSync(OPENCODE_BIN) ? OPENCODE_BIN : "opencode";
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function createOpenCodeTempEnv(extraEnv = {}) {
    const dir = mkdtempSync(join(tmpdir(), "even-opencode-"));
    return {
        dir,
        env: {
            ...process.env,
            ...extraEnv,
            TMPDIR: `${dir}/`,
            TMP: dir,
            TEMP: dir,
        },
    };
}

function cleanupOpenCodeTemp(dir) {
    if (!dir) return;
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function findFreePort() {
    return new Promise((resolvePort) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            server.close(() => resolvePort(port));
        });
        server.on("error", () => resolvePort(0));
    });
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

async function startServer() {
    const bin = findOpenCodeBin();
    const port = await findFreePort();
    if (!port) throw new Error("Could not find free port for opencode server");

    const temp = createOpenCodeTempEnv({ OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD });
    const proc = spawn(bin, ["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
        stdio: ["ignore", "pipe", "pipe"],
        env: temp.env,
    });
    proc.once("close", () => cleanupOpenCodeTemp(temp.dir));
    proc.once("error", () => cleanupOpenCodeTemp(temp.dir));

    await new Promise((resolveReady) => {
        let isReady = false;
        const timeout = setTimeout(() => { if (!isReady) resolveReady(); }, 10000);
        const checkReady = (chunk) => {
            if (chunk.toString().includes("listening") && !isReady) {
                isReady = true;
                clearTimeout(timeout);
                resolveReady();
            }
        };
        proc.stdout.on("data", checkReady);
        proc.stderr.on("data", checkReady);
        proc.on("error", () => { if (!isReady) { clearTimeout(timeout); resolveReady(); } });
        proc.on("exit", () => { if (!isReady) { clearTimeout(timeout); resolveReady(); } });
    });

    return { proc, port, url: `http://127.0.0.1:${port}` };
}

export function createOpenCodeProvider(emit) {
    const sessions = new Map();
    const phoneToServer = new Map();
    const pollTimers = new Set();
    let serverHandle = null;
    let serverPromise = null;
    let sessionCache = null;
    let sessionCacheTime = 0;
    let sessionCacheRefresh = null;

    async function ensureServer() {
        if (serverHandle) return serverHandle;
        if (serverPromise) return serverPromise;
        serverPromise = startServer().then((handle) => {
            serverHandle = handle;
            return handle;
        }).catch((err) => {
            serverPromise = null;
            throw err;
        });
        return serverPromise;
    }

    function getSession(phoneId) {
        if (sessions.has(phoneId)) return sessions.get(phoneId);
        const serverId = phoneToServer.get(phoneId);
        if (serverId && sessions.has(serverId)) return sessions.get(serverId);
        return null;
    }

    async function pollExport(emitId, ocSessionId) {
        const bin = findOpenCodeBin();
        let prevCount = 0;
        let polls = 0;
        let firstPoll = true;
        let timer = null;
        let stopped = false;
        let currentAbort = null;
        const entry = {
            stop: () => {
                stopped = true;
                if (timer) clearTimeout(timer);
                if (currentAbort) currentAbort.abort();
                pollTimers.delete(entry);
            }
        };
        pollTimers.add(entry);
        function teardown() { pollTimers.delete(entry); }

        async function poll() {
            if (stopped) return;
            polls++;
            if (polls > 150) {
                const s = getSession(emitId);
                if (s && !s.finalized) {
                    s.finalized = true;
                    s.busy = false;
                    s.proc = null;
                    emit(emitId, { type: "result", success: false, text: "", provider: "opencode", error: "poll timeout" });
                    emit(emitId, { type: "status", state: "idle" });
                }
                teardown();
                return;
            }
            const currentSession = getSession(emitId);
            if (!currentSession || !currentSession.busy) {
                teardown();
                return;
            }
            try {
                const temp = createOpenCodeTempEnv();
                try {
                    currentAbort = new AbortController();
                    const stdout = await new Promise((resolvePoll, reject) => {
                        execFile(bin, ["export", ocSessionId], {
                            timeout: 30000, encoding: "utf8", env: temp.env, maxBuffer: 10 * 1024 * 1024, signal: currentAbort.signal,
                        }, (err, out) => {
                            if (err) reject(err);
                            else resolvePoll(out);
                        });
                    });
                    currentAbort = null;
                    if (stopped) return;
                    const data = JSON.parse(stdout);
                    const messages = data.messages || [];

                    let currentText = "";
                    let currentRole = "";
                    if (messages.length > 0) {
                        const lastMsg = messages[messages.length - 1];
                        currentRole = lastMsg.info?.role || "";
                        if (currentRole === "assistant" && Array.isArray(lastMsg.parts)) {
                            for (const part of lastMsg.parts) {
                                if (part.type === "text" && part.text) currentText += part.text;
                            }
                        }
                    }

                    const s = getSession(emitId);
                    let emittedTextLength = s ? (s.emittedTextLength || 0) : 0;

                    if (messages.length > prevCount) {
                        if (firstPoll) { firstPoll = false; console.log(`[opencode] pollExport started for ${ocSessionId}, ${messages.length} existing msgs`); }
                        console.log(`[opencode] pollExport #${polls}: +${messages.length - prevCount} msgs (total ${messages.length})`);
                        emittedTextLength = 0;
                        if (s) s.emittedTextLength = 0;
                        prevCount = messages.length;
                    }

                    if (currentRole === "assistant" && currentText.length > emittedTextLength) {
                        const newText = currentText.slice(emittedTextLength);
                        if (s) {
                            s.partialText = currentText;
                            s.emittedTextLength = currentText.length;
                        }
                        emit(emitId, { type: "text_delta", text: newText });
                    }

                    const lastMsg = messages[messages.length - 1];
                    if (lastMsg?.info?.role === "assistant") {
                        const finish = lastMsg.info.finish;
                        if (finish === "end-turn" || finish === "stop" || finish === "tool-calls") {
                            if (s && !s.finalized) {
                                s.finalized = true;
                                s.busy = false;
                                s.proc = null;
                                emit(emitId, { type: "result", success: true, text: "", provider: "opencode" });
                                emit(emitId, { type: "status", state: "idle" });
                            }
                            console.log(`[opencode] pollExport complete: ${ocSessionId}`);
                            teardown();
                            return;
                        }
                    }
                } finally {
                    currentAbort = null;
                    cleanupOpenCodeTemp(temp.dir);
                }
            } catch (err) {
                if (stopped) {
                    teardown();
                    return;
                }
                if (firstPoll) console.log(`[opencode] pollExport #${polls} err: ${err.message}`);
            }

            if (!stopped) {
                timer = setTimeout(poll, 2000);
            }
        }

        poll();
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const { port } = await ensureServer();
        const resolvedDir = cwd || process.env.PROJECT_DIR || process.cwd();

        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session = existing || { id: null, busy: true, cwd: resolvedDir, proc: null };
        session.busy = true;
        session.cwd = resolvedDir;
        session.finalized = false;

        const emitId = phoneSessionId || `opencode-${Date.now()}`;
        if (!sessions.has(emitId)) sessions.set(emitId, session);
        if (phoneSessionId) setBoundedMapping(phoneToServer, phoneSessionId, session.id || phoneSessionId);

        emit(emitId, { type: "user_prompt", text });
        emit(emitId, { type: "status", state: "busy" });

        const serverSessionId = session.id || phoneSessionId;
        const bin = findOpenCodeBin();
        const args = [
            "run", "--attach", `http://127.0.0.1:${port}`,
            "--format", "json",
            "--dir", resolvedDir,
        ];
        if (yolo) {
            args.push("--dangerously-skip-permissions");
        }
        if (model) {
            let finalModel = model;
            if (!finalModel.includes("/")) {
                // Remove execSync that blocks event loop. Rely on standard litellm prefix or simple fallback
                finalModel = `litellm/${model}`;
            }
            args.push("--model", finalModel);
        } else if (process.env.OPENCODE_MODEL) {
            args.push("--model", process.env.OPENCODE_MODEL);
        }
        if (thinking) {
            args.push("--variant", thinking);
        }
        const isValidOcSession = serverSessionId && serverSessionId.startsWith("ses_");
        if (isValidOcSession) {
            args.push("--session", serverSessionId);
        }
        args.push(text);

        debugLog("opencode", "spawning", `${bin} ${args.join(" ")}`);

        const temp = createOpenCodeTempEnv({
            OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
            OPENCODE_SERVER_USERNAME: "opencode",
        });
        const proc = spawn(bin, args, {
            cwd: resolvedDir,
            stdio: ["ignore", "pipe", "pipe"],
            env: temp.env,
        });
        proc.stderr.on('data', d => console.error('[opencode stderr]', d.toString()));
        proc.once("close", () => {
            cleanupOpenCodeTemp(temp.dir);
            setTimeout(() => {
                const s = getSession(emitId);
                if (s && s.busy && !s.finalized) {
                    s.finalized = true;
                    s.busy = false; s.proc = null;
                    emit(emitId, { type: "result", success: true, text: "", provider: "opencode" });
                    emit(emitId, { type: "status", state: "idle" });
                }
            }, 2000); // Give pollExport time to finish normally
        });
        proc.once("error", () => cleanupOpenCodeTemp(temp.dir));
        session.proc = proc;

        let lineBuffer = "";
        const stepStart = await new Promise((resolve) => {
            const onData = (chunk) => {
                lineBuffer += chunk.toString();
                const lines = lineBuffer.split("\n");
                lineBuffer = lines.pop() || "";
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const ev = JSON.parse(line);
                        if (ev.type === "step_start" && ev.sessionID) {
                            resolve(ev.sessionID);
                            return;
                        }
                    } catch {}
                }
            };
            proc.stdout.on("data", onData);
            proc.on("close", () => resolve(null));
            proc.on("error", () => resolve(null));
            setTimeout(() => resolve(null), 15000);
        });

        if (!stepStart) {
            session.finalized = true;
            session.busy = false;
            session.proc = null;
            if (!phoneSessionId && sessions.get(emitId) === session) sessions.delete(emitId);
            phoneToServer.delete(emitId);
            emit(emitId, { type: "error", value: "Failed to start opencode session" });
            emit(emitId, { type: "status", state: "idle" });
            return { sessionId: emitId, provider: "opencode" };
        }

        const finalId = stepStart;
        session.id = finalId;
        if (!sessions.has(finalId)) sessions.set(finalId, session);
        if (phoneSessionId) setBoundedMapping(phoneToServer, phoneSessionId, finalId);
        if (emitId !== finalId) setBoundedMapping(phoneToServer, emitId, finalId);
        emit(emitId, { type: "session_id", sessionID: finalId });

        // The CLI process can outlive the HTTP request. pollExport is the bounded
        // owner for streamed results and runs for at most 150 polls at 2s each.
        proc.unref();
        pollExport(emitId, finalId);

        return { sessionId: finalId, provider: "opencode" };
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (!s) return null;
        return { state: s.busy ? "busy" : "idle", provider: "opencode" };
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        if (s?.busy) return "busy";
        return "idle";
    }

    let infoCache = null;
    function getInfo() {
        if (infoCache) return infoCache;
        const bin = findOpenCodeBin();
        let version = "";
        const temp = createOpenCodeTempEnv();
        try {
            version = execSync(`${shellQuote(bin)} --version`, {
                timeout: 3000, encoding: "utf8", shell: true, env: temp.env,
            }).trim();
        } catch {
        } finally {
            cleanupOpenCodeTemp(temp.dir);
        }
        let model = "opencode";
        try { const c = JSON.parse(readFileSync(OPENCODE_CONFIG_PATH, "utf8")); if (c.model) model = c.model; } catch {}
        infoCache = { account: { email: model, organization: "OpenCode" }, model, version: version || "Unknown", provider: "opencode" };
        return infoCache;
    }

    function refreshSessionCache() {
        if (sessionCacheRefresh) return sessionCacheRefresh;
        sessionCacheRefresh = new Promise(async (resolvePromise) => {
            try {
                const dbPath = resolve(homedir(), ".local", "share", "opencode", "opencode.db");
                if (existsSync(dbPath)) {
                    const { default: Database } = await import("better-sqlite3");
                    const db = new Database(dbPath, { readonly: true });
                    const rows = db.prepare("SELECT id, title, time_updated FROM session ORDER BY time_updated DESC LIMIT 50;").all();
                    db.close();
                    
                    const result = rows.map(r => ({
                        id: r.id,
                        title: r.title ? r.title.slice(0, 64) : "Session",
                        timestamp: new Date(r.time_updated).toISOString(),
                        cwd: "", provider: "opencode", status: null,
                    }));
                    sessionCache = result;
                    sessionCacheTime = Date.now();
                    resolvePromise(result);
                    return;
                }
            } catch (err) {
                console.error("[opencode] Direct DB read failed, returning cache or empty", err.message);
            }
            resolvePromise(sessionCache || []);
        }).finally(() => {
            sessionCacheRefresh = null;
        });
        return sessionCacheRefresh;
    }

    async function listSessions(limit) {
        if (!sessionCache || Date.now() - sessionCacheTime > 30000) {
            await refreshSessionCache();
        }
        return sortSessionList(sessionCache || []).slice(0, limit || 20);
    }

    async function getHistory(sessionId, limit) {
        let sid = sessionId;
        if (phoneToServer.has(sessionId)) sid = phoneToServer.get(sessionId);
        const bin = findOpenCodeBin();
        const temp = createOpenCodeTempEnv();
        try {
            const stdout = await new Promise((resolveHistory, reject) => {
                execFile(bin, ["export", sid], {
                    timeout: 15000, encoding: "utf8", env: temp.env, maxBuffer: 10 * 1024 * 1024,
                }, (err, out) => {
                    if (err) reject(err);
                    else resolveHistory(out);
                });
            });
            const data = JSON.parse(stdout);
            const history = [];
            for (const msg of data.messages || []) {
                const role = msg.info?.role;
                if (role !== "user" && role !== "assistant") continue;
                for (const part of msg.parts || []) {
                    if (part.type === "text" && part.text) history.push({ role, text: part.text });
                }
            }
            const s = getSession(sessionId);
            if (s && s.busy && s.partialText) {
                history.push({ role: "assistant", text: s.partialText });
            }
            return history.slice(-Math.min(limit || 50, 50));
        } catch {
            const history = [];
            const s = getSession(sessionId);
            if (s && s.busy && s.partialText) {
                history.push({ role: "assistant", text: s.partialText });
            }
            return history;
        }
        finally { cleanupOpenCodeTemp(temp.dir); }
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s?.proc && !s.proc.killed) {
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
        if (s) { s.busy = false; s.proc = null; }
    }

    function dispose() {
        for (const entry of pollTimers) { if (entry?.stop) entry.stop(); }
        pollTimers.clear();
        for (const s of sessions.values()) {
            if (s?.proc && !s.proc.killed) {
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
        if (serverHandle?.proc && !serverHandle.proc.killed) {
            try { serverHandle.proc.kill("SIGTERM"); } catch {}
        }
        serverHandle = null;
        serverPromise = null;
    }

    return {
        listSessions, getSessionStatus, getInfo, getHistory,
        prompt, respondPermission, respondQuestion, interrupt, getStatus, dispose,
    };
}
