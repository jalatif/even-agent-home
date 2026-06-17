import { execSync, spawn } from "node:child_process";

import { sortSessionList } from "../shared/sort-sessions.js";
const GATEWAY_URL = process.env.HERMES_GATEWAY_URL || "http://127.0.0.1:8642";
const MODEL = "hermes-agent";
const API_KEY = process.env.HERMES_API_KEY || "my-secret-hermes-gateway-token";

export function createHermesProvider(emit, enableSessionRefresh = false) {
    const sessions = new Map();
    const phoneToGateway = new Map();
    let gatewaySessionCache = null;

    function getSession(sessionId) {
        if (sessions.has(sessionId)) return sessions.get(sessionId);
        const gatewayId = phoneToGateway.get(sessionId);
        if (gatewayId && sessions.has(gatewayId)) return sessions.get(gatewayId);
        return null;
    }

    async function prompt(phoneSessionId, text, cwd) {
        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session = existing || {
            id: phoneSessionId || `hermes-${Date.now()}`,
            busy: true,
            messages: [],
            abortController: null,
        };
        session.busy = true;

        const sessionId = session.id;
        if (!sessions.has(sessionId)) sessions.set(sessionId, session);

        emit(sessionId, { type: "user_prompt", text });
        emit(sessionId, { type: "status", state: "busy" });

        session.messages.push({ role: "user", content: text });

        const abortController = new AbortController();
        session.abortController = abortController;

        try {
            const response = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${API_KEY}`,
                },
                body: JSON.stringify({
                    model: MODEL,
                    messages: session.messages,
                    stream: true,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Gateway error ${response.status}: ${errText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullResponse = "";
            let chatId = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop() || "";

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith("data: ")) continue;
                    const payload = trimmed.slice(6);
                    if (payload === "[DONE]") continue;

                    try {
                        const parsed = JSON.parse(payload);
                        if (parsed.id && !chatId) chatId = parsed.id;

                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullResponse += content;
                            emit(sessionId, { type: "text_delta", text: content });
                        }
                    } catch {
                    }
                }
            }

            if (fullResponse) {
                session.messages.push({ role: "assistant", content: fullResponse });
            }

            if (chatId) {
                session.gatewaySessionId = chatId;
                phoneToGateway.set(sessionId, chatId);
            }

            session.busy = false;
            session.abortController = null;
            emit(sessionId, { type: "result", success: true, text: fullResponse, provider: "hermes" });
            emit(sessionId, { type: "status", state: "idle" });

            return { sessionId, provider: "hermes" };

        } catch (err) {
            session.busy = false;
            session.abortController = null;

            if (err.name === "AbortError") {
                emit(sessionId, { type: "status", state: "idle" });
            } else {
                emit(sessionId, { type: "error", value: err.message });
                emit(sessionId, { type: "status", state: "idle" });
            }

            return { sessionId, provider: "hermes" };
        }
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (!s) return null;
        return { state: s.busy ? "busy" : "idle", provider: "hermes" };
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        return s?.busy ? "busy" : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync("hermes --version", { timeout: 3000, encoding: "utf8", shell: true }).trim();
        } catch {}
        return {
            account: { email: `${MODEL} (via Gateway)`, organization: "Hermes Agent" },
            model: MODEL,
            version: version || "Unknown",
            provider: "hermes",
        };
    }

    function parseSessionList(stdout) {
        try {
            const result = [];
            const lines = stdout.trim().split("\n");
            let headerSkipped = false;
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                if (!headerSkipped) { headerSkipped = true; continue; }
                const parts = trimmed.split(/\s{2,}/);
                if (parts.length >= 4) {
                    result.push({
                        id: parts[parts.length - 1],
                        title: parts[0].slice(0, 64),
                        timestamp: new Date().toISOString(),
                        cwd: "",
                        provider: "hermes",
                        status: null,
                    });
                }
            }
            return result;
        } catch {
            return [];
        }
    }

    // Initial sync load — ensures sessions are available immediately
    try {
        const output = execSync(
            "hermes sessions list --limit 50 2>/dev/null",
            { timeout: 10000, encoding: "utf8", shell: true }
        );
        gatewaySessionCache = parseSessionList(output);
    } catch {}

    if (enableSessionRefresh) {
        function refreshGatewaySessionCache() {
            const proc = spawn("hermes", ["sessions", "list", "--limit", "50"], {
                stdio: ["ignore", "pipe", "pipe"],
            });
            let stdout = "";
            proc.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
            proc.on("close", () => {
                const parsed = parseSessionList(stdout);
                if (parsed.length > 0) gatewaySessionCache = parsed;
            });
        }
        refreshGatewaySessionCache();
        setInterval(refreshGatewaySessionCache, 15000);
    }
    function listSessions(limit) {
        const result = [];

        for (const [id, s] of sessions) {
            const lastMsg = s.messages.length > 0 ? s.messages[0].content : "";
            result.push({
                id,
                title: lastMsg.slice(0, 64),
                timestamp: new Date().toISOString(),
                cwd: "",
                provider: "hermes",
                status: s.busy ? "busy" : null,
            });
        }

        const existingIds = new Set(result.map(r => r.id));
        for (const s of gatewaySessionCache || []) {
            if (!existingIds.has(s.id)) {
                result.push(s);
            }
        }

        return sortSessionList(result).slice(0, limit || 10);
    }

    function getHistory(sessionId, limit) {
        const s = getSession(sessionId);
        if (!s) return [];
        const max = Math.min(limit || 10, 10);
        return s.messages.slice(-max).map(m => ({ role: m.role, text: m.content }));
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s?.abortController) {
            s.abortController.abort();
        }
        if (s) {
            s.busy = false;
            s.abortController = null;
        }
    }

    return {
        listSessions, getSessionStatus, getInfo, getHistory,
        prompt, respondPermission, respondQuestion, interrupt, getStatus,
    };
}
