import { spawn, execSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import { debugLog } from "../debug.js";
import { sortSessionList } from "../shared/sort-sessions.js";

const OPENCODE_BIN = resolve(homedir(), ".opencode", "bin", "opencode");
const SERVER_PASSWORD = `agent-home-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const OPENCODE_CONFIG_PATH = resolve(homedir(), ".config", "opencode", "opencode.json");

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

    proc.stderr.on("data", () => {});

    await new Promise((resolveReady) => {
        const timeout = setTimeout(() => resolveReady(), 10000);
        proc.stdout.on("data", (chunk) => {
            if (chunk.toString().includes("listening")) {
                clearTimeout(timeout);
                resolveReady();
            }
        });
        proc.on("error", () => { clearTimeout(timeout); resolveReady(); });
        proc.on("exit", () => { clearTimeout(timeout); resolveReady(); });
    });

    return { proc, port, url: `http://127.0.0.1:${port}` };
}

export function createOpenCodeProvider(emit) {
    const sessions = new Map();
    const phoneToServer = new Map();
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

    function pollExport(emitId, ocSessionId) {
        const bin = findOpenCodeBin();
        let prevCount = 0;
        let polls = 0;
        let firstPoll = true;

        const timer = setInterval(() => {
            polls++;
            if (polls > 150) {
                clearInterval(timer);
                const s = getSession(emitId);
                if (s) { s.busy = false; s.proc = null; }
                return;
            }
            try {
                const temp = createOpenCodeTempEnv();
                const tmpFile = join(temp.dir, `oc-export-${ocSessionId}.json`);
                let output = "";
                try {
                    execSync(`${shellQuote(bin)} export ${shellQuote(ocSessionId)} > ${shellQuote(tmpFile)} 2>/dev/null`, {
                        timeout: 30000, shell: true, env: temp.env,
                    });
                    output = readFileSync(tmpFile, "utf8");
                } finally {
                    cleanupOpenCodeTemp(temp.dir);
                }
                const data = JSON.parse(output);
                const messages = data.messages || [];
                if (messages.length <= prevCount) return;

                const newCount = messages.length - prevCount;
                if (firstPoll) { firstPoll = false; console.log(`[opencode] pollExport started for ${ocSessionId}, ${messages.length} existing msgs`); }
                console.log(`[opencode] pollExport #${polls}: +${newCount} msgs (total ${messages.length})`);

                for (let i = prevCount; i < messages.length; i++) {
                    const msg = messages[i];
                    const role = msg.info?.role;
                    if (role !== "assistant") continue;
                    for (const part of msg.parts || []) {
                        if (part.type === "text" && part.text) {
                            console.log(`[opencode] emit text_delta: "${part.text.slice(0, 80)}" to ${emitId}`);
                            emit(emitId, { type: "text_delta", text: part.text });
                        }
                    }
                }
                prevCount = messages.length;

                const last = messages[messages.length - 1];
                if (last?.info?.role === "assistant") {
                    const finish = last.info.finish;
                    if (finish === "end-turn" || finish === "stop" || finish === "tool-calls") {
                        const s = getSession(emitId);
                        if (s) { s.busy = false; s.proc = null; }
                        emit(emitId, { type: "result", success: true, text: "", provider: "opencode" });
                        emit(emitId, { type: "status", state: "idle" });
                        console.log(`[opencode] pollExport complete: ${ocSessionId}`);
                        clearInterval(timer);
                    }
                }
            } catch (err) {
                if (firstPoll) console.log(`[opencode] pollExport #${polls} err: ${err.message}`);
            }
        }, 2000);
    }

    async function prompt(phoneSessionId, text, cwd) {
        const { port } = await ensureServer();
        const resolvedDir = cwd || process.env.PROJECT_DIR || process.cwd();

        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session = existing || { id: null, busy: true, cwd: resolvedDir, proc: null };
        session.busy = true;
        session.cwd = resolvedDir;

        const emitId = phoneSessionId || `opencode-${Date.now()}`;
        if (!sessions.has(emitId)) sessions.set(emitId, session);
        if (phoneSessionId) phoneToServer.set(phoneSessionId, session.id || phoneSessionId);

        emit(emitId, { type: "user_prompt", text });
        emit(emitId, { type: "status", state: "busy" });

        const serverSessionId = session.id || phoneSessionId;
        const bin = findOpenCodeBin();
        const args = [
            "run", "--attach", `http://127.0.0.1:${port}`,
            "--format", "json", "--dangerously-skip-permissions",
            "--dir", resolvedDir,
        ];
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
        proc.once("close", () => cleanupOpenCodeTemp(temp.dir));
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
            session.busy = false;
            session.proc = null;
            emit(emitId, { type: "error", value: "Failed to start opencode session" });
            emit(emitId, { type: "status", state: "idle" });
            return { sessionId: emitId, provider: "opencode" };
        }

        const finalId = stepStart;
        session.id = finalId;
        if (!sessions.has(finalId)) sessions.set(finalId, session);
        if (phoneSessionId) phoneToServer.set(phoneSessionId, finalId);
        if (emitId !== finalId) phoneToServer.set(emitId, finalId);
        emit(emitId, { type: "session_id", sessionID: finalId });

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
        const bin = findOpenCodeBin();
        sessionCacheRefresh = new Promise((resolve) => {
            const temp = createOpenCodeTempEnv();
            const proc = spawn(bin, ["session", "list"], {
                stdio: ["ignore", "pipe", "pipe"],
                env: temp.env,
            });
            let stdout = "";
            proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
            proc.on("error", () => {
                cleanupOpenCodeTemp(temp.dir);
                resolve(sessionCache || []);
            });
            proc.on("close", () => {
                cleanupOpenCodeTemp(temp.dir);
                try {
                    const lines = stdout.trim().split("\n");
                    const result = [];
                    for (let i = 2; i < lines.length; i++) {
                        const line = lines[i].trim();
                        if (!line) continue;
                        const parts = line.split(/\s{2,}/);
                        if (parts.length >= 3) {
                            result.push({
                                id: parts[0].trim(),
                                title: parts[1].trim().slice(0, 64),
                                timestamp: new Date().toISOString(),
                                cwd: "", provider: "opencode", status: null,
                            });
                        }
                    }
                    sessionCache = result;
                    sessionCacheTime = Date.now();
                    resolve(result);
                } catch {
                    resolve(sessionCache || []);
                }
            });
        }).finally(() => {
            sessionCacheRefresh = null;
        });
        return sessionCacheRefresh;
    }

    async function listSessions() {
        if (!sessionCache || Date.now() - sessionCacheTime > 30000) {
            await refreshSessionCache();
        }
        return sortSessionList(sessionCache || []);
    }

    function getHistory(sessionId, limit) {
        let sid = sessionId;
        if (phoneToServer.has(sessionId)) sid = phoneToServer.get(sessionId);
        const bin = findOpenCodeBin();
        const temp = createOpenCodeTempEnv();
        try {
            const tmpFile = join(temp.dir, `oc-history-${sid}.json`);
            execSync(`${shellQuote(bin)} export ${shellQuote(sid)} > ${shellQuote(tmpFile)} 2>/dev/null`, {
                timeout: 15000, shell: true, env: temp.env,
            });
            const output = readFileSync(tmpFile, "utf8");
            const data = JSON.parse(output);
            const history = [];
            for (const msg of data.messages || []) {
                const role = msg.info?.role;
                if (role !== "user" && role !== "assistant") continue;
                for (const part of msg.parts || []) {
                    if (part.type === "text" && part.text) history.push({ role, text: part.text });
                }
            }
            return history.slice(-Math.min(limit || 10, 10));
        } catch { return []; }
        finally { cleanupOpenCodeTemp(temp.dir); }
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s?.proc) { try { s.proc.kill("SIGTERM"); } catch {} }
        if (s) { s.busy = false; s.proc = null; }
    }

    return {
        listSessions, getSessionStatus, getInfo, getHistory,
        prompt, respondPermission, respondQuestion, interrupt, getStatus,
    };
}
