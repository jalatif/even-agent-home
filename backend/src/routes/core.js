import { Router } from "express";
import { broadcast, pushMessage, getMessages } from "./events.js";
import { transcribeAudio } from "../stt.js";
import { createClaudeProvider } from "../claude/provider.js";
import { createCodexProvider } from "../codex/provider.js";
import { createOpenCodeProvider } from "../opencode/provider.js";
import { createHermesProvider } from "../hermes/provider.js";
import { createOhMyPiProvider } from "../oh-my-pi/provider.js";
import { createPiProvider } from "../pi/provider.js";
import { createAntigravityProvider } from "../antigravity/provider.js";
import { CodexAppServerClient } from "../codex/app-server.js";
import { debugLog } from "../debug.js";
import { CODEX_APP_SERVER_PORT } from "../startup/common.js";

const router = Router();
const emit = (sessionId, msg) => {
    if (!sessionId) return;
    const id = pushMessage(sessionId, msg);
    broadcast(sessionId, msg, id);
};

const codexClient = new CodexAppServerClient(`ws://127.0.0.1:${CODEX_APP_SERVER_PORT}`);
export { codexClient };

const providerFactories = {
    "claude": () => createClaudeProvider(emit),
    "codex": () => createCodexProvider(emit, () => codexClient),
    "opencode": () => createOpenCodeProvider(emit),
    "antigravity": () => createAntigravityProvider(emit),
    "oh-my-pi": () => createOhMyPiProvider(emit),
    "pi": () => createPiProvider(emit),
    "hermes": () => createHermesProvider(emit, false)
};

const providerInstances = new Map();

function getProviderInstance(name) {
    if (!providerFactories[name]) {
        throw new Error(`Unsupported provider: ${name}`);
    }
    if (!providerInstances.has(name)) {
        providerInstances.set(name, providerFactories[name]());
    }
    return providerInstances.get(name);
}

export async function shutdownProviders() {
    const disposals = [];
    for (const provider of providerInstances.values()) {
        if (typeof provider?.dispose === "function") {
            disposals.push(Promise.resolve().then(() => provider.dispose()).catch(() => {}));
        }
    }
    providerInstances.clear();
    await Promise.all(disposals);
}

const SUPPORTED_PROVIDERS = Object.keys(providerFactories);

import fs from "node:fs/promises";
import path from "node:path";
import { execFile, execSync } from "node:child_process";
import { filterHistory } from "../shared/filters.js";

const CLI_BINS = {
    "claude": null,
    "codex": null,
    "opencode": "opencode",
    "antigravity": "agy",
    "oh-my-pi": "omp",
    "pi": "pi",
    "hermes": "hermes"
};

const DEFAULT_MODELS = {
    claude: ["claude-haiku-4-5","claude-opus-4-5","claude-opus-4-6","claude-opus-4-7","claude-opus-4-8","claude-sonnet-4-5","claude-sonnet-4-6"],
    codex: ["codex-mini-latest","gpt-4","gpt-4-turbo","gpt-4.1","gpt-4.1-mini","gpt-4.1-nano","gpt-4o","gpt-4o-2024-05-13","gpt-4o-2024-08-06","gpt-4o-2024-11-20","gpt-4o-mini","gpt-5","gpt-5-chat-latest","gpt-5-codex","gpt-5-mini","gpt-5-nano","gpt-5-pro","gpt-5.1","gpt-5.1-chat-latest","gpt-5.1-codex","gpt-5.1-codex-max","gpt-5.1-codex-mini","gpt-5.2","gpt-5.2-chat-latest","gpt-5.2-codex","gpt-5.2-pro","gpt-5.3-chat-latest","gpt-5.3-codex","gpt-5.3-codex-spark","gpt-5.4","gpt-5.4-mini","gpt-5.4-nano","gpt-5.4-pro","gpt-5.5","gpt-5.5-pro","o1","o1-pro","o3","o3-deep-research","o3-mini","o3-pro","o4-mini","o4-mini-deep-research"],
    "oh-my-pi": ["deepseek-claude-flash","deepseek-claude-pro","gemma4-mac","gemma4-ollama-pc","openclaw","qwen3-VL-ollama-pc","qwen3.5-mac","qwen3.6-27B-pc","qwen3.6-35B-pc","qwen3.6-ollama-pc","router-glm-5.1","router-gpt-4o-mini","router-qwen3.7-max","deepseek-v4-flash","deepseek-v4-pro","minimax-m3"],
    antigravity: ["claude-haiku-4-5@20251001","claude-opus-4-5@20251101","claude-opus-4-6@default","claude-opus-4-7@default","claude-opus-4-8@default","claude-sonnet-4-5@20250929","claude-sonnet-4-6@default","deepseek-ai/deepseek-v3.1-maas","deepseek-ai/deepseek-v3.2-maas","gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.5-pro","gemini-3-flash-preview","gemini-3.1-flash-lite","gemini-3.1-flash-lite-preview","gemini-3.1-pro-preview","gemini-3.1-pro-preview-customtools","gemini-3.5-flash","gemini-flash-latest","gemini-flash-lite-latest","meta/llama-3.3-70b-instruct-maas","meta/llama-4-maverick-17b-128e-instruct-maas","moonshotai/kimi-k2-thinking-maas","openai/gpt-oss-120b-maas","openai/gpt-oss-20b-maas","qwen/qwen3-235b-a22b-instruct-2507-maas","zai-org/glm-4.7-maas","zai-org/glm-5-maas"],
    pi: ["nemotron-3-super:cloud","qwen2.5:0.5b","gemma4:latest"],
    opencode: ["deepseek-claude-flash","deepseek-claude-pro","gemma4-mac","gemma4-ollama-pc","openclaw","qwen3-VL-ollama-pc","qwen3.5-mac","qwen3.6-27B-pc","qwen3.6-35B-pc","qwen3.6-ollama-pc","router-glm-5.1","router-gpt-4o-mini","router-qwen3.7-max","deepseek-v4-flash","deepseek-v4-pro","minimax-m3"],
    hermes: ["hermes-v2", "hermes-pro"]
};

const modelCache = new Map(Object.entries(DEFAULT_MODELS).map(([provider, models]) => [
    provider,
    { models, source: "static", status: "idle", refreshedAt: null, error: null, available: true, refreshPromise: null }
]));

function isAgentAvailable(provider) {
    const bin = CLI_BINS[provider];
    if (bin === null) return true;
    if (!bin) return false;
    try {
        execSync(`command -v ${bin}`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

function scanAgentAvailability() {
    const result = [];
    for (const provider of SUPPORTED_PROVIDERS) {
        const bin = CLI_BINS[provider];
        result.push({ id: provider, available: isAgentAvailable(provider) });
    }
    return result;
}

function execFileWithTimeout(command, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        execFile(command, args, {
            encoding: "utf8",
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
            if (error) {
                error.stderr = stderr;
                reject(error);
                return;
            }
            resolve(stdout || "");
        });
    });
}

function uniqueStrings(values) {
    return [...new Set(values.map((value) => String(value).trim()).filter(Boolean))];
}

function parseGroupedModelTable(output, fallbackGroup) {
    const models = [];
    let currentGroup = fallbackGroup;
    for (const line of output.split("\n")) {
        const group = line.match(/^([a-z0-9_-]+) \(\d+\)/i);
        if (group) {
            currentGroup = group[1];
            continue;
        }
        if (line.startsWith("│ ") && !line.includes("│ model ")) {
            const parts = line.split("│").map((part) => part.trim());
            if (parts[1]) models.push(`${currentGroup}/${parts[1]}`);
        }
    }
    return uniqueStrings(models);
}

function parseLineModels(output) {
    return uniqueStrings(output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !/^error[:\s]/i.test(line) && !/^warning[:\s]/i.test(line)));
}

function parseModels(provider, output) {
    if (provider === "oh-my-pi") return parseGroupedModelTable(output, provider);
    if (provider === "pi") return parseGroupedModelTable(output, provider);
    return parseLineModels(output);
}

async function refreshModels(provider, { force = false } = {}) {
    if (!SUPPORTED_PROVIDERS.includes(provider)) throw new Error(`Unsupported provider: ${provider}`);
    const cached = modelCache.get(provider) ?? { models: [], source: "empty", status: "idle", refreshedAt: null, error: null, available: false, refreshPromise: null };
    if (cached.refreshPromise && !force) return cached.refreshPromise;

    const available = isAgentAvailable(provider);
    cached.available = available;
    cached.error = null;
    if (!available) {
        cached.models = [];
        cached.source = "unavailable";
        cached.status = "unavailable";
        cached.refreshedAt = new Date().toISOString();
        cached.refreshPromise = null;
        modelCache.set(provider, cached);
        return cached;
    }

    const bin = CLI_BINS[provider];
    if (bin === null || provider === "hermes") {
        cached.models = DEFAULT_MODELS[provider] ?? cached.models ?? [];
        cached.source = "static";
        cached.status = "complete";
        cached.refreshedAt = new Date().toISOString();
        cached.refreshPromise = null;
        modelCache.set(provider, cached);
        return cached;
    }

    cached.status = "refreshing";
    cached.refreshPromise = execFileWithTimeout(bin, ["models"], 5000)
        .then((output) => {
            const models = parseModels(provider, output);
            if (models.length > 0) {
                cached.models = models;
                cached.source = "refreshed";
            } else if ((cached.models?.length ?? 0) === 0) {
                cached.models = DEFAULT_MODELS[provider] ?? [];
                cached.source = cached.models.length > 0 ? "static" : "empty";
            }
            cached.status = "complete";
            cached.error = null;
            cached.refreshedAt = new Date().toISOString();
            return cached;
        })
        .catch((error) => {
            if ((cached.models?.length ?? 0) === 0) {
                cached.models = DEFAULT_MODELS[provider] ?? [];
                cached.source = cached.models.length > 0 ? "static" : "empty";
            }
            cached.status = cached.models.length > 0 ? "complete" : "error";
            cached.error = error?.message ?? String(error);
            cached.refreshedAt = new Date().toISOString();
            return cached;
        })
        .finally(() => {
            cached.refreshPromise = null;
        });
    modelCache.set(provider, cached);
    return cached.refreshPromise;
}

export function startModelRefreshAll() {
    for (const provider of SUPPORTED_PROVIDERS) {
        const available = isAgentAvailable(provider);
        const cached = modelCache.get(provider);
        if (cached) cached.available = available;
        if (!available) {
            if (cached) {
                cached.models = [];
                cached.source = "unavailable";
                cached.status = "unavailable";
                cached.refreshedAt = new Date().toISOString();
                cached.error = null;
            }
            continue;
        }
        refreshModels(provider).catch(() => {});
    }
}

router.get("/agents", (req, res) => {
    res.json({ agents: scanAgentAvailability() });
});

router.get("/models", (req, res) => {
    const providerName = req.query.agent || req.query.provider;
    if (!providerName || !SUPPORTED_PROVIDERS.includes(providerName)) {
        return res.status(400).json({ error: "Invalid or missing agent parameter" });
    }
    const cached = modelCache.get(providerName);
    if (!cached || cached.status === "idle") refreshModels(providerName).catch(() => {});
    res.json({
        models: cached?.models ?? DEFAULT_MODELS[providerName] ?? [],
        source: cached?.source ?? "static",
        status: cached?.status ?? "refreshing",
        available: cached?.available ?? isAgentAvailable(providerName),
        refreshedAt: cached?.refreshedAt ?? null,
        error: cached?.error ?? null,
    });
});

router.get("/sessions", async (req, res) => {
    const providerName = req.query.agent || req.query.provider;
    if (!providerName || !SUPPORTED_PROVIDERS.includes(providerName)) {
        return res.status(400).json({ error: "Invalid or missing agent parameter" });
    }
    
    const provider = getProviderInstance(providerName);
    const cwd = req.query.cwd || process.env.PROJECT_DIR;
    const limit = Number(req.query.limit) || 20;
    
    try {
        const sessions = await provider.listSessions(limit, cwd);
        const validSessions = sessions.filter(s => s && s.id).map(s => {
            let state = s.state || s.status || 'idle';
            try {
                const status = provider.getStatus(s.id);
                if (status) state = status.state;
            } catch (e) {}
            return { ...s, state };
        });
        res.json({ sessions: validSessions });
    } catch (err) {
        res.status(502).json({ sessions: [], error: err.message });
    }
});

router.get("/history", async (req, res) => {
    const sessionId = req.query.sessionId;
    const providerName = req.query.agent || req.query.provider;
    
    if (!sessionId || !providerName || !SUPPORTED_PROVIDERS.includes(providerName)) {
        return res.status(400).json({ error: "Missing or invalid sessionId/agent parameter" });
    }
    
    const provider = getProviderInstance(providerName);
    const limit = Math.min(parseInt(req.query.limit) || 50, 50);
    try {
        const history = await provider.getHistory(sessionId, limit);
        res.json({ history: filterHistory(history) });
    } catch (err) {
        res.status(502).json({ history: [], error: err.message });
    }
});

router.post("/prompt", async (req, res) => {
    const { text, sessionId, provider, cwd, model, thinking, yolo } = req.body ?? {};
    if (!text || typeof text !== "string") {
        return res.status(400).json({ error: "Missing 'text' field" });
    }
    if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: "Invalid or missing provider field" });
    }
    try {
        const targetProvider = getProviderInstance(provider);
        const result = await targetProvider.prompt(sessionId, text, cwd, model, thinking, yolo);
        res.status(202).json({ ok: true, sessionId: result.sessionId, provider });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        console.error("[prompt] failed:", err.message);
        res.status(statusCode).json({ error: err.message });
    }
});

router.post("/transcribe", async (req, res) => {
    try {
        const pcmData = req.body.audio;
        const text = await transcribeAudio(pcmData);
        res.json({ text });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.post("/interrupt", (req, res) => {
    const { sessionId, provider } = req.body ?? {};
    if (!sessionId || !provider || !SUPPORTED_PROVIDERS.includes(provider)) {
        return res.status(400).json({ error: "Missing or invalid sessionId/provider" });
    }
    
    try {
        const targetProvider = getProviderInstance(provider);
        targetProvider.interrupt(sessionId);
        res.json({ ok: true });
    } catch (err) {
        res.status(err.statusCode || 500).json({ error: err.message });
    }
});

router.get("/status", async (req, res) => {
    const providerName = req.query.agent || req.query.provider;
    const sessionId = req.query.sessionId;
    if (!sessionId || !providerName) return res.status(400).json({ error: "Missing sessionId or provider" });
    
    try {
        const targetProvider = getProviderInstance(providerName);
        const status = targetProvider.getStatus(sessionId);
        let state = status?.state;
        if (!state && typeof targetProvider.getSessionStatus === "function") {
            state = await targetProvider.getSessionStatus(sessionId);
        }
        if (!state) return res.status(404).json({ error: "Session not found" });
        res.json({ state, sessionId, provider: providerName, error: status?.error });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
