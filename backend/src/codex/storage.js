import { codexThreadStatus } from "./status.js";
export async function listCodexSessions(client, limit, cwd) {
    const result = await client.threadList({
        limit: limit,
        ...(cwd ? { cwd } : {}),
        archived: false,
        sortKey: "updated_at",
    });
    return result.data.slice(0, 10).map((t) => ({
        id: String(t.id ?? ""),
        title: String(t.name ?? t.preview ?? "Codex session").slice(0, 64),
        timestamp: new Date((Number(t.updatedAt ?? t.createdAt ?? Date.now() / 1000)) * 1000).toISOString(),
        cwd: String(t.cwd ?? ""),
        status: codexThreadStatus(t),
    }));
}
const MAX_HISTORY_ITEMS = 10;
export async function getCodexSessionHistory(client, sessionId, limit) {
    const thread = await client.threadRead(sessionId, true);
    const turns = Array.isArray(thread?.turns) ? thread.turns : [];
    const messages = [];
    for (const turn of turns) {
        const items = Array.isArray(turn?.items) ? turn.items : [];
        for (const item of items) {
            if (item?.type === "userMessage") {
                const text = extractUserMessageText(item);
                if (text)
                    messages.push({ role: "user", text });
            }
            else if (item?.type === "agentMessage") {
                const text = extractAgentMessageText(item);
                if (text)
                    messages.push({ role: "assistant", text });
            }
        }
    }
    const returnCount = Math.min(limit, MAX_HISTORY_ITEMS);
    return messages.slice(-returnCount);
}
function extractUserMessageText(item) {
    const content = Array.isArray(item?.content) ? item.content : [];
    const parts = [];
    for (const c of content) {
        if (c?.type === "text" && typeof c?.text === "string" && c.text.trim()) {
            parts.push(c.text.trim());
        }
    }
    return parts.join("\n").trim();
}
function extractAgentMessageText(item) {
    if (typeof item?.text === "string" && item.text.trim())
        return item.text.trim();
    return "";
}
