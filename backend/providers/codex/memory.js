const threadMeta = new Map();
const threadMessages = new Map();
export function recordThreadMeta(id, cwd, title) {
    if (!id)
        return;
    const prev = threadMeta.get(id);
    threadMeta.set(id, {
        id,
        cwd: cwd || prev?.cwd || "",
        title: (title || prev?.title || "Codex session").slice(0, 64),
        updatedAt: Date.now(),
    });
}
export function appendThreadMessage(id, role, text) {
    if (!id || !text.trim())
        return;
    const arr = threadMessages.get(id) ?? [];
    arr.push({ role, text: text.trim(), ts: Date.now() });
    if (arr.length > 80)
        arr.splice(0, arr.length - 80);
    threadMessages.set(id, arr);
    const meta = threadMeta.get(id);
    if (meta) {
        meta.updatedAt = Date.now();
    }
}
export function listInMemorySessions(cwd) {
    return Array.from(threadMeta.values())
        .filter((m) => !cwd || m.cwd === cwd)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map((m) => ({
        id: m.id,
        title: m.title || "Codex session",
        timestamp: new Date(m.updatedAt).toISOString(),
        cwd: m.cwd || "",
    }));
}
export function getInMemoryHistory(threadId, limit) {
    const rows = threadMessages.get(threadId) ?? [];
    if (rows.length === 0)
        return [];
    const rounds = [];
    let cur = [];
    for (const m of rows) {
        if (m.role === "user") {
            if (cur.length > 0)
                rounds.push(cur);
            cur = [{ role: "user", text: m.text }];
        }
        else {
            cur.push({ role: "assistant", text: m.text });
        }
    }
    if (cur.length > 0)
        rounds.push(cur);
    return rounds
        .slice(-limit)
        .flat()
        .map((m) => ({ role: m.role, text: m.text.slice(0, 800) }));
}
