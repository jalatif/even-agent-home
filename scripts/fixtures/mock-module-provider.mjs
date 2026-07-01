/**
 * Mock Tier 3 module provider for test-module-provider.mjs.
 *
 * Implements the full provider contract (the same 10-method surface the
 * built-in providers return) so the dynamic-import hook's validation passes
 * and the methods behave predictably for assertions.
 */
export function createProvider(emit, options = {}) {
    const name = options.name || "mock-module-agent";
    const sessions = new Map();

    async function prompt(sessionId, text, cwd, model, thinking, yolo) {
        const session = sessions.get(sessionId) || { id: sessionId, busy: false, text: "" };
        if (session.busy) throw Object.assign(new Error("Session is busy"), { statusCode: 409 });
        session.busy = true;
        sessions.set(sessionId, session);

        emit(sessionId, { type: "user_prompt", text });
        emit(sessionId, { type: "status", state: "busy" });

        // Emit a couple of deltas then a result — exactly what a real provider does.
        emit(sessionId, { type: "text_delta", text: "mock " });
        emit(sessionId, { type: "text_delta", text: "reply" });
        const answer = "mock reply";
        session.text = answer;
        session.busy = false;
        emit(sessionId, { type: "result", success: true, text: answer, provider: name });
        emit(sessionId, { type: "status", state: "idle" });
        return { sessionId, provider: name };
    }

    function listSessions(limit) {
        return Array.from(sessions.values()).slice(0, limit || 10).map((s) => ({
            id: s.id, title: s.text.slice(0, 64), timestamp: new Date().toISOString(),
            cwd: "", provider: name, status: s.busy ? "busy" : null,
        }));
    }
    function getHistory(sessionId, limit) {
        const s = sessions.get(sessionId);
        return s ? [{ role: "user", text: "" }, { role: "assistant", text: s.text }].slice(-(limit || 10)) : [];
    }
    function getStatus(sessionId) {
        const s = sessions.get(sessionId);
        return s ? { state: s.busy ? "busy" : "idle", provider: name } : null;
    }
    function interrupt(_sessionId) {}
    function dispose() { sessions.clear(); }

    return {
        prompt, listSessions, getHistory, getStatus, interrupt, dispose,
        // omit respondPermission/respondQuestion/getInfo/getSessionStatus
        // to verify the wrapper backfills them as no-ops.
    };
}
