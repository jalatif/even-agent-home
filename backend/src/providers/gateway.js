/**
 * Tier 1 — generic OpenAI-compatible gateway provider.
 *
 * A parameterized version of the built-in `hermes` provider (see
 * `../hermes/provider.js`): instead of module-level constants
 * (GATEWAY_URL/MODEL/API_KEY), the connection details come from a resolved
 * config object. This powers config-file-defined `type: gateway` agents so a
 * user can add an OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a proxy,
 * …) with zero JavaScript.
 *
 * Streaming contract (identical to hermes):
 *   POST `${gatewayUrl}/v1/chat/completions` with `{ model, messages, stream:true }`
 *   response is SSE; each `data: {...}` line's `choices[0].delta.content` is a
 *   token, emitted as `{type:"text_delta"}`. End of stream → `{type:"result"}`.
 *
 * Sessions are held in-memory only (matching hermes); there is no on-disk
 * transcript and no external session-list refresh. `listSessions` therefore
 * returns only sessions active in this backend process.
 */
import { sortSessionList } from "../shared/sort-sessions.js";

function resolveApiKey(config) {
    if (config.apiKeyEnv) {
        const v = process.env[config.apiKeyEnv];
        if (v) return v;
    }
    return config.apiKey || "";
}

export function createGatewayProvider(config, emit) {
    const name = config.name;
    const gatewayUrl = (config.gatewayUrl || "").replace(/\/+$/, "");
    const defaultModel = config.model;
    const apiKey = resolveApiKey(config);

    const sessions = new Map();

    function getSession(sessionId) {
        return sessions.has(sessionId) ? sessions.get(sessionId) : null;
    }

    async function prompt(phoneSessionId, text, cwd, model, thinking, yolo) {
        const existing = phoneSessionId ? getSession(phoneSessionId) : null;
        if (existing && existing.busy) {
            throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        }

        const session = existing || {
            id: phoneSessionId || `${name}-${Date.now()}`,
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
            const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: model || defaultModel,
                    messages: session.messages,
                    stream: true,
                }),
                signal: abortController.signal,
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => "");
                throw new Error(`Gateway error ${response.status}: ${errText.slice(0, 500)}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let fullResponse = "";

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
                        const content = parsed.choices?.[0]?.delta?.content;
                        if (content) {
                            fullResponse += content;
                            session.partialText = fullResponse;
                            emit(sessionId, { type: "text_delta", text: content });
                        }
                    } catch {}
                }
            }

            if (fullResponse) {
                session.messages.push({ role: "assistant", content: fullResponse });
            }

            session.busy = false;
            session.abortController = null;
            session.partialText = undefined;
            emit(sessionId, { type: "result", success: true, text: fullResponse, provider: name });
            emit(sessionId, { type: "status", state: "idle" });

            return { sessionId, provider: name };
        } catch (err) {
            session.busy = false;
            session.abortController = null;

            if (err.name === "AbortError") {
                emit(sessionId, { type: "status", state: "idle" });
            } else {
                emit(sessionId, { type: "error", value: err.message });
                emit(sessionId, { type: "status", state: "idle" });
                emit(sessionId, {
                    type: "result",
                    success: false,
                    text: "",
                    provider: name,
                    error: err.message,
                });
            }

            return { sessionId, provider: name };
        }
    }

    function getStatus(sessionId) {
        const s = getSession(sessionId);
        if (!s) return null;
        return { state: s.busy ? "busy" : "idle", provider: name };
    }

    function getSessionStatus(sessionId) {
        const s = getSession(sessionId);
        return s?.busy ? "busy" : "idle";
    }

    function getInfo() {
        return {
            account: { email: `${defaultModel} (via gateway)`, organization: name },
            model: defaultModel,
            version: "gateway",
            provider: name,
        };
    }

    function listSessions(limit) {
        const result = [];
        for (const [id, s] of sessions) {
            const lastMsg = s.messages.length > 0 ? s.messages[s.messages.length - 1].content : "";
            result.push({
                id,
                title: String(lastMsg).slice(0, 64),
                timestamp: new Date().toISOString(),
                cwd: "",
                provider: name,
                status: s.busy ? "busy" : null,
            });
        }
        return sortSessionList(result).slice(0, limit || 10);
    }

    function getHistory(sessionId, limit) {
        const s = getSession(sessionId);
        if (!s) return [];
        const max = Math.min(limit || 10, 10);
        const history = s.messages.slice(-max).map((m) => ({ role: m.role, text: m.content }));
        if (s.busy && s.partialText) {
            history.push({ role: "assistant", text: s.partialText });
        }
        return history.slice(-max);
    }

    function respondPermission(_sessionId, _decision) {}
    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const s = getSession(sessionId);
        if (s?.abortController) {
            try { s.abortController.abort(); } catch {}
        }
        if (s) {
            s.busy = false;
            s.abortController = null;
        }
    }

    function dispose() {
        for (const s of sessions.values()) {
            try { s.abortController?.abort(); } catch {}
            s.busy = false;
            s.abortController = null;
        }
    }

    return {
        prompt, listSessions, getHistory, getStatus, interrupt,
        getSessionStatus, getInfo, respondPermission, respondQuestion, dispose,
    };
}
