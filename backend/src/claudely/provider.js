import { spawn, execSync } from "node:child_process";
import { listSessions as listClaudeSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { debugLog } from "../debug.js";
import { claudeSessionStatus } from "../claude/provider.js";
import { sortSessionList } from "../shared/sort-sessions.js";

const BITWARDEN_ITEM = "llm-provider/secret-key";
const BITWARDEN_FIELD = "LITELLM_API_KEY";
const BASE_URL = "http://localhost:4000";
const MODEL = "deepseek-claude-pro";

function resolveApiKey() {
    const fromEnv = process.env.LITELLM_API_KEY;
    if (fromEnv) return fromEnv;

    try {
        const session = execSync(
            `security find-generic-password -s "vaultwarden-master" -w 2>/dev/null | /opt/homebrew/bin/bw unlock --raw 2>/dev/null`,
            { timeout: 10000, encoding: "utf8", shell: true },
        ).trim();
        if (session) {
            const key = execSync(
                `/opt/homebrew/bin/bw get item "${BITWARDEN_ITEM}" --session "${session}" 2>/dev/null | /opt/homebrew/bin/jq -r '.fields[] | select(.name=="'"${BITWARDEN_FIELD}"'") | .value'`,
                { timeout: 10000, encoding: "utf8", shell: true },
            ).trim();
            if (key) return key;
        }
    } catch {}

    return "";
}

export function createClaudelyProvider(emit) {
    const sessions = new Map();
    let apiKey = null;

    function ensureKey() {
        if (apiKey) return apiKey;
        apiKey = resolveApiKey();
        if (!apiKey) {
            console.warn("[claudely] No LITELLM_API_KEY found in env or Bitwarden");
        }
        return apiKey;
    }

    function makeSession(sessionId) {
        if (sessionId) {
            const existing = sessions.get(sessionId);
            if (existing) return existing;
        }
        const session = { id: sessionId, busy: false, cwd: null };
        if (sessionId) sessions.set(sessionId, session);
        return session;
    }

    function buildArgs(text, _cwd, model, thinking, yolo) {
        return [
            "--print",
            "--output-format", "stream-json",
            "--verbose",
            ...(yolo ? ["--dangerously-skip-permissions"] : []),
            "--model", model || MODEL,
            ...(thinking ? ["--thinking"] : []),
            text,
        ];
    }

    function buildEnv() {
        const key = ensureKey();
        return {
            ...process.env,
            ANTHROPIC_BASE_URL: BASE_URL,
            ANTHROPIC_AUTH_TOKEN: key || "",
            ANTHROPIC_API_KEY: "",
            CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        };
    }

    async function prompt(sessionId, text, cwd, model, thinking, yolo) {
        const key = ensureKey();
        if (!key) {
            emit("__system__", { type: "error", value: "No LITELLM_API_KEY available" });
            throw new Error("claudely: LITELLM_API_KEY not found. Set LITELLM_API_KEY env var or configure Bitwarden.");
        }

        const session = makeSession(sessionId);
        if (!sessionId) {
            sessionId = `claudely-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            session.id = sessionId;
            sessions.set(sessionId, session);
        }

        session.busy = true;
        session.cwd = cwd || process.env.PROJECT_DIR || process.cwd();

        emit(sessionId, { type: "user_prompt", text });
        emit(sessionId, { type: "status", state: "busy" });

        const args = buildArgs(text, session.cwd, model, thinking, yolo);
        const env = buildEnv();

        debugLog("claudely", "spawning", `claude ${args.join(" ")}`);

        const proc = spawn("claude", args, {
            cwd: session.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            env,
        });

        let lineBuffer = "";

        proc.stdout.on("data", (chunk) => {
            lineBuffer += chunk.toString();
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() || "";
            if (lines.length > 0) console.log(`[claudely] stdout: ${lines.length} line(s) for ${sessionId}`);

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);

                    if (event.type === "assistant" && event.message?.content) {
                        for (const block of event.message.content) {
                            if (block.type === "text" && block.text) {
                                console.log(`[claudely] emit text_delta: "${block.text.slice(0, 80)}" to ${sessionId}`);
                                setImmediate(() => emit(sessionId, { type: "text_delta", text: block.text }));
                            } else if (block.type === "tool_use") {
                                setImmediate(() => emit(sessionId, { type: "tool_use", name: block.name, input: block.input }));
                            } else if (block.type === "tool_result") {
                                const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
                                if (content) setImmediate(() => emit(sessionId, { type: "text", value: `[tool result]\n${content}\n` }));
                            }
                        }
                    } else if (event.type === "result") {
                        console.log(`[claudely] result: ${event.stop_reason} (error=${event.is_error})`);
                        if (event.is_error) {
                            setImmediate(() => emit(sessionId, { type: "error", value: event.result ?? "Tool error" }));
                        }
                    } else if (event.type === "error") {
                        setImmediate(() => emit(sessionId, { type: "error", value: event.error?.message ?? event.message ?? String(event) }));
                    }
                } catch {
                    if (line.trim()) setImmediate(() => emit(sessionId, { type: "text", value: line + "\n" }));
                }
            }
        });

        proc.stderr.on("data", (chunk) => {
            const text = chunk.toString();
            if (text.trim() && !text.includes("Claude Code")) {
                emit(sessionId, { type: "text", value: text });
            }
        });

        return new Promise((resolvePromise) => {
            proc.on("close", (code) => {
                console.log(`[claudely] closed code=${code} busy=${session.busy} sess=${sessionId}`);
                session.busy = false;
                emit(sessionId, { type: "result", success: code === 0, text: "", provider: "claudely" });
                emit(sessionId, { type: "status", state: "idle" });
                resolvePromise({ sessionId, provider: "claudely" });
            });

            proc.on("error", (err) => {
                session.busy = false;
                emit(sessionId, { type: "error", value: err.message });
                emit(sessionId, { type: "status", state: "idle" });
                resolvePromise({ sessionId, provider: "claudely" });
            });
        });
    }

    function getStatus(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return null;
        return { state: session.busy ? "busy" : "idle", provider: "claudely" };
    }

    function getSessionStatus(sessionId) {
        const session = sessions.get(sessionId);
        return session?.busy ? "busy" : "idle";
    }

    function getInfo() {
        let version = "";
        try {
            version = execSync("claude --version", { timeout: 3000, encoding: "utf8", shell: process.env.SHELL || "sh" }).trim().replace(" (Claude Code)", "");
        } catch {}
        return {
            account: { email: `deepseek-v4-flash (via Litellm)`, organization: "Local-Claudely" },
            model: MODEL,
            version: version || "Unknown",
            provider: "claudely",
        };
    }
    async function listSessions(limit, cwd) {
        try {
            const infos = await listClaudeSessions(cwd ? { dir: cwd, limit } : { limit });
            return sortSessionList(infos.map((info) => ({
                id: info.sessionId,
                title: (info.customTitle || info.summary || info.firstPrompt || "").slice(0, 64),
                timestamp: new Date(info.lastModified).toISOString(),
                cwd: info.cwd || "",
                provider: "claudely",
                status: claudeSessionStatus(info.sessionId),
            })));
        } catch {
            return [];
        }
    }

    async function getHistory(sessionId, limit) {
        try {
            const messages = await getSessionMessages(sessionId);
            const history = [];
            for (const msg of messages) {
                const contents = msg.message?.content;
                if (!Array.isArray(contents)) continue;
                for (const c of contents) {
                    if (c?.type === "text") {
                        history.push({ role: msg.type, text: c.text });
                    }
                }
            }
            const max = Math.min(limit || 10, 10);
            return history.slice(-max);
        } catch {
            return [];
        }
    }

    function respondPermission(_sessionId, _decision) {}

    function respondQuestion(_sessionId, _answer) {}

    function interrupt(sessionId) {
        const session = sessions.get(sessionId);
        if (session) session.busy = false;
    }

    return {
        listSessions,
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
