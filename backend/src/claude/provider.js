import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { summarizeClaudeToolCall } from "./summarize.js";
import { ClaudeSession } from "./session.js";
/** Find the jsonl file for a Claude session by scanning project dirs. */
function findSessionFile(sessionId) {
    const claudeDir = join(homedir(), ".claude", "projects");
    if (!existsSync(claudeDir))
        return null;
    for (const dir of readdirSync(claudeDir)) {
        const p = join(claudeDir, dir, `${sessionId}.jsonl`);
        if (existsSync(p))
            return p;
    }
    return null;
}
/** Read last line of a jsonl file. */
function readLastLine(filePath) {
    try {
        const data = readFileSync(filePath, "utf8");
        const lines = data.trimEnd().split("\n");
        if (lines.length === 0)
            return null;
        return JSON.parse(lines[lines.length - 1]);
    }
    catch {
        return null;
    }
}
/** Determine session status by reading the jsonl file directly. */
export function claudeSessionStatus(sessionId) {
    const file = findSessionFile(sessionId);
    if (!file)
        return "idle";
    const last = readLastLine(file);
    if (!last)
        return "idle";
    if (last.type === "last-prompt")
        return "idle";
    if (last.type === "system" && (last.subtype === "stop_hook_summary" || last.subtype === "turn_duration"))
        return "idle";
    if (last.type === "assistant" && last.message?.stop_reason && last.message.stop_reason !== "tool_use")
        return "idle";
    if (last.type === "result")
        return "idle";
    if (last.type === "permission-mode")
        return "idle";
    if (last.type === "user") {
        const c = last.message?.content;
        const text = typeof c === "string" ? c : c?.[0]?.text ?? "";
        if (text.includes("Request interrupted by user"))
            return "idle";
    }
    if (last.timestamp) {
        const ageMs = Date.now() - new Date(last.timestamp).getTime();
        if (ageMs > 120_000)
            return "idle";
    }
    return "busy";
}
// ── SDK message → display turn helpers ────────────────
function extractTextContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content)) {
        return content
            .filter((b) => b.type === "text" && b.text?.trim())
            .map((b) => b.text)
            .join("\n");
    }
    return "";
}
function sdkBlockToLine(block) {
    if (block.type === "text" && block.text?.trim())
        return block.text;
    if (block.type === "tool_use")
        return "> " + summarizeClaudeToolCall(block.name, block.input ?? {});
    if (block.type === "tool_result")
        return extractTextContent(block.content) || null;
    return null;
}
// ── Provider factory ────────────────────────────────────
export function createClaudeProvider(emit) {
    const sessions = new Map();
    function makeSession(sessionId) {
        if (sessionId) {
            const existing = sessions.get(sessionId);
            if (existing)
                return existing;
        }
        const session = new ClaudeSession(emit);
        session.onIdReady((sid) => {
            if (!sessions.has(sid))
                sessions.set(sid, session);
        });
        if (sessionId)
            sessions.set(sessionId, session);
        return session;
    }
    async function prompt(sessionId, text, cwd, model, thinking, yolo) {
        let session;
        if (sessionId)
            session = sessions.get(sessionId);
        if (sessionId && !session && !findSessionFile(sessionId)) {
            throw Object.assign(new Error(`Claude session not found: ${sessionId}`), { statusCode: 404 });
        }
        if (!session) {
            session = makeSession(sessionId);
            await session.start(sessionId, cwd);
        }
        // Emit user_prompt when session ID is known
        session.onIdReady((sid) => {
            emit(sid, { type: "user_prompt", text });
        });
        session.yolo = !!yolo;
        if (session.busy) {
            session.enqueue(text, model, thinking);
        }
        else {
            session.run(text, model, thinking).catch((err) => {
                console.error(`[claude-provider] run failed: ${err.message}`);
            });
        }
        const resolvedId = session.id ?? await session.waitForId(10000).catch(() => null) ?? "";
        return { sessionId: resolvedId, provider: "claude" };
    }
    function respondPermission(sessionId, decision) {
        sessions.get(sessionId)?.respondPermission(decision);
    }
    function respondQuestion(sessionId, answer) {
        sessions.get(sessionId)?.respondQuestion(answer);
    }
    function interrupt(sessionId) {
        sessions.get(sessionId)?.interrupt();
    }
    function getStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (!session)
            return null;
        return { state: session.status, provider: "claude", error: session.lastError || undefined };
    }
    async function getSessionStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (session)
            return session.status;
        return claudeSessionStatus(sessionId);
    }
    async function listClaudeSessions(limit, cwd) {
        const infos = await listSessions(cwd ? { dir: cwd, limit } : { limit });
        return infos.map((info) => ({
            id: info.sessionId,
            title: (info.customTitle || info.summary || info.firstPrompt || "").slice(0, 64),
            timestamp: new Date(info.lastModified).toISOString(),
            cwd: info.cwd || "",
            provider: "claude",
            status: claudeSessionStatus(info.sessionId),
        }));
    }
    async function getInfo() {
        const { exec } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execAsync = promisify(exec);
        const shellOpt = process.env.SHELL || process.env.ComSpec || "sh";
        let version = "";
        try {
            const { stdout } = await execAsync("claude --version", { timeout: 3000, shell: shellOpt });
            version = stdout.trim().replace(" (Claude Code)", "");
        }
        catch { }
        let account = {};
        let model = "";
        try {
            const recent = await listSessions({ limit: 3 });
            for (const info of recent) {
                const messages = await getSessionMessages(info.sessionId);
                for (let i = messages.length - 1; i >= 0; i--) {
                    const entry = messages[i];
                    if (entry.type !== "assistant")
                        continue;
                    const m = entry.message?.model;
                    if (m) {
                        model = m;
                        break;
                    }
                }
                if (model)
                    break;
            }
        }
        catch { }
        let modelDisplay = "";
        if (model) {
            const parts = model.replace("claude-", "").replace(/-\d{8,}$/, "").split("-");
            const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
            const ver = parts.slice(1).join(".");
            modelDisplay = name + (ver ? " " + ver : "");
        }
        try {
            const { stdout } = await execAsync("claude auth status", { timeout: 5000, shell: shellOpt });
            const auth = JSON.parse(stdout.trim());
            account = {
                email: auth.email ?? "",
                organization: auth.orgName ?? "",
                subscriptionType: auth.subscriptionType ?? "",
            };
        }
        catch { }
        return {
            account,
            model: modelDisplay || "Unknown",
            version: version || "Unknown",
            provider: "claude",
        };
    }
    const MAX_HISTORY_ITEMS = 10;
    async function getHistory(sessionId, limit) {
        const messages = await getSessionMessages(sessionId);
        let reduced = messages.reduce(function (acc, msg) {
            const contents = msg.message?.content;
            for (let content of contents) {
                if (content?.type === "text") {
                    acc.push({ role: msg.type, text: content.text });
                }
            }
            return acc;
        }, []);
        let returnCount = Math.min(limit, MAX_HISTORY_ITEMS);
        const session = sessions.get(sessionId);
        if (session && session.busy && session.partialText) {
            reduced.push({ role: "assistant", text: session.partialText });
        }
        return reduced.slice(-returnCount);
    }
    return {
        listSessions: listClaudeSessions,
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
