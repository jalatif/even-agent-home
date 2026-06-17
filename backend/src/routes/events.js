import { Router } from "express";
import { writeToLogFile } from "../logger.js";
const router = Router();
// ── Per-session message ring buffer + SSE clients ────
const MAX_MESSAGES_PER_SESSION = 500;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000; // 30 min
const sessions = new Map();
function getSession(sessionId) {
    let s = sessions.get(sessionId);
    if (!s) {
        s = { messages: [], clients: new Set(), nextId: 1, lastActivity: Date.now() };
        sessions.set(sessionId, s);
    }
    s.lastActivity = Date.now();
    return s;
}
// Periodic cleanup of idle sessions with no clients. Busy providers that emit
// progress keep their SSE buffer alive until their bounded provider poll loop
// finishes, then the normal idle TTL evicts the buffer.
setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
        if (s.clients.size === 0 && now - s.lastActivity > SESSION_IDLE_TTL_MS) {
            sessions.delete(id);
        }
    }
}, 60000).unref();
export function pushMessage(sessionId, msg) {
    const s = getSession(sessionId);
    const id = s.nextId++;
    s.messages.push({ id, msg });
    if (s.messages.length > MAX_MESSAGES_PER_SESSION) {
        s.messages.shift();
    }
    return id;
}
export function getMessages(sessionId, after) {
    const s = sessions.get(sessionId);
    if (!s)
        return [];
    return s.messages
        .filter((m) => m.id > after)
        .map((m) => ({ id: m.id, ...m.msg }));
}
export function broadcast(sessionId, msg, id) {
    const s = sessions.get(sessionId);
    const data = JSON.stringify(msg);
    if (process.env.VERBOSE === "1") {
        console.log(`[SSE-${sessionId}]: ${data}`);
    }
    else if (process.env.VERBOSE_SSE === "1") {
        writeToLogFile(`[SSE-${sessionId}] type=${msg.type} id=${id}`);
    }
    if (!s || s.clients.size === 0)
        return;
    let deadCount = 0;
    for (const res of s.clients) {
        try {
            res.write(`id: ${id}\ndata: ${data}\n\n`);
        }
        catch {
            s.clients.delete(res);
            deadCount++;
        }
    }
    if (deadCount > 0) {
        console.warn(`[sse] Removed ${deadCount} dead client(s) for session=${sessionId} (remaining: ${s.clients.size})`);
    }
}
export function clientCount() {
    let total = 0;
    for (const s of sessions.values())
        total += s.clients.size;
    return total;
}
export function sessionHasClients(sessionId) {
    const s = sessions.get(sessionId);
    return !!s && s.clients.size > 0;
}
router.get("/events", (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        res.status(400).json({ error: "Missing 'sessionId' query parameter" });
        return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();
    res.write(":ok\n\n");
    const s = getSession(sessionId);
    if (req.query.needReplay === "true" && s.messages.length > 0) {
        // Replay buffered messages for this session
        for (const entry of s.messages) {
            res.write(`id: ${entry.id}\ndata: ${JSON.stringify(entry.msg)}\n\n`);
        }
    }
    s.clients.add(res);
    console.log(`[sse] Client connected session=${sessionId} (session clients: ${s.clients.size}, total: ${clientCount()})`);
    // Heartbeat every 15s
    const heartbeat = setInterval(() => {
        try {
            res.write(":heartbeat\n\n");
        }
        catch {
            clearInterval(heartbeat);
            s.clients.delete(res);
        }
    }, 15000);
    req.on("close", () => {
        clearInterval(heartbeat);
        s.clients.delete(res);
        console.log(`[sse] Client disconnected (total: ${clientCount()})`);
    });
});
export default router;
