import WebSocket from "ws";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { debugLog } from "../debug.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
export class CodexAppServerClient {
    ws = null;
    wsUrl;
    initialized = false;
    nextId = 1;
    handleNotification;
    handleServerRequest;
    handleClose;
    pending = new Map();
    initPromise = null;
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
    }
    async threadList(params) {
        const result = await this.call("thread/list", params);
        return {
            data: Array.isArray(result?.data) ? result.data : [],
            nextCursor: result?.nextCursor ?? null,
        };
    }
    async threadRead(threadId, includeTurns = true) {
        const result = await this.call("thread/read", {
            threadId,
            includeTurns,
        });
        return result?.thread ?? null;
    }
    async threadStart(params) {
        const result = await this.call("thread/start", params);
        return result?.thread ?? null;
    }
    async threadResume(params) {
        const result = await this.call("thread/resume", params);
        return result?.thread ?? null;
    }
    async turnStart(params) {
        const result = await this.call("turn/start", params);
        return result?.turn ?? null;
    }
    async turnInterrupt(threadId, turnId) {
        await this.call("turn/interrupt", { threadId, turnId });
    }
    async threadUnsubscribe(threadId) {
        const result = await this.call("thread/unsubscribe", { threadId });
        return result?.status ?? "unknown";
    }
    async getAccount() {
        try {
            const result = await this.call("account/get", {});
            return result?.account ?? null;
        }
        catch {
            return null;
        }
    }
    respondToServerRequest(id, result) {
        this.send({
            jsonrpc: "2.0",
            id,
            result,
        });
    }
    /** Connect and initialize eagerly (for receiving notifications at startup). */
    async connect() {
        await this.ensureInitialized();
    }
    async close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.initialized = false;
        this.initPromise = null;
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("Client closed"));
        }
        this.pending.clear();
    }
    send(msg) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN)
            return;
        this.ws.send(JSON.stringify(msg));
    }
    async call(method, params) {
        await this.ensureInitialized();
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("codex app-server not connected");
        }
        const id = this.nextId++;
        const req = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, 30000);
            this.pending.set(id, { resolve, reject, timer });
            this.send(req);
        });
    }
    async ensureInitialized() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN && this.initialized)
            return;
        if (this.initPromise)
            return this.initPromise;
        this.initPromise = this.connectAndInitialize().finally(() => {
            this.initPromise = null;
        });
        return this.initPromise;
    }
    async connectAndInitialize() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            await this.connectWebSocket();
        }
        if (!this.initialized) {
            await this.callRaw("initialize", {
                clientInfo: {
                    name: "agent-home-server",
                    version: pkg.version,
                },
                capabilities: {
                    experimentalApi: true,
                },
            });
            this.initialized = true;
            // Send initialized notification
            this.send({ jsonrpc: "2.0", method: "initialized" });
        }
    }
    connectWebSocket() {
        return new Promise((resolve, reject) => {
            const ws = new WebSocket(this.wsUrl);
            const connectTimeout = setTimeout(() => {
                ws.close();
                reject(new Error(`WebSocket connect timeout: ${this.wsUrl}`));
            }, 10000);
            ws.on("open", () => {
                clearTimeout(connectTimeout);
                this.ws = ws;
                resolve();
            });
            ws.on("message", (data) => {
                const text = typeof data === "string" ? data : data.toString();
                // app-server may send multiple JSON-RPC messages in one frame (newline-delimited)
                for (const line of text.split("\n")) {
                    if (line.trim())
                        this.handleLine(line);
                }
            });
            ws.on("error", (err) => {
                clearTimeout(connectTimeout);
                console.error(`[codex-app-server] ws error: ${err.message}`);
                const e = new Error(`codex app-server ws error: ${err.message}`);
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(e);
                }
                this.pending.clear();
                this.ws = null;
                this.initialized = false;
                try {
                    this.handleClose?.(e);
                }
                catch { }
                reject(e);
            });
            ws.on("close", () => {
                const err = new Error("codex app-server ws closed");
                for (const [, p] of this.pending) {
                    clearTimeout(p.timer);
                    p.reject(err);
                }
                this.pending.clear();
                this.ws = null;
                this.initialized = false;
                try {
                    this.handleClose?.(err);
                }
                catch { }
            });
        });
    }
    async callRaw(method, params) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("codex app-server not connected");
        }
        const id = this.nextId++;
        const req = {
            jsonrpc: "2.0",
            id,
            method,
            params,
        };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`RPC timeout: ${method}`));
            }, 10000);
            this.pending.set(id, { resolve, reject, timer });
            this.send(req);
        });
    }
    handleLine(line) {
        const trimmed = line.trim();
        if (!trimmed)
            return;
        let msg;
        try {
            msg = JSON.parse(trimmed);
        }
        catch {
            return;
        }
        // JSON-RPC notification (no id)
        if (msg?.id === undefined || msg?.id === null) {
            if (typeof msg?.method === "string") {
                debugLog("codex-app-server", `notification ${msg.method}`, toOneLineJson(msg.params ?? {}));
                try {
                    this.handleNotification?.(msg.method, msg.params ?? {});
                }
                catch { }
            }
            return;
        }
        // JSON-RPC server request (has method + id)
        if (typeof msg?.method === "string" && msg?.id !== undefined) {
            debugLog("codex-app-server", `server_request id=${String(msg.id)} method=${msg.method}`, toOneLineJson(msg.params ?? {}));
            try {
                this.handleServerRequest?.(msg.id, msg.method, msg.params ?? {});
            }
            catch { }
            return;
        }
        // JSON-RPC response
        const pending = this.pending.get(msg.id);
        if (!pending)
            return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
            const err = Object.assign(new Error(msg.error.message || "RPC error"), {
                rpcCode: msg.error.code,
                rpcData: msg.error.data,
            });
            pending.reject(err);
            return;
        }
        pending.resolve(msg.result);
    }
}
function toOneLineJson(value) {
    try {
        const raw = JSON.stringify(value);
        if (!raw)
            return "";
        return raw.length > 1000 ? raw.slice(0, 1000) + "...(truncated)" : raw;
    }
    catch {
        return "";
    }
}
