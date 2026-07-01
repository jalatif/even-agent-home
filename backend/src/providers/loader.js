/**
 * Custom-agent config loader + first-run seeder.
 *
 * Responsibilities:
 *   1. Seed a template config + user guide into ~/.agent-home/ on first start
 *      (idempotent, opt-out, behavior-preserving).
 *   2. Load + validate custom-agent definitions from a YAML or JSON file.
 *   3. Fail soft: any error (missing file, bad YAML, invalid entry) collapses
 *      to "zero agents" so built-ins are never affected (zero-config guarantee).
 *
 * Resolution order (first existing file wins):
 *   1. $AGENTHOME_AGENTS_CONFIG (absolute path to .yaml or .json)
 *   2. ~/.agent-home/agents.yaml
 *   3. ~/.agent-home/agents.json
 *
 * Public API:
 *   loadCustomAgentConfigs()  → ResolvedConfig[]  (call once at core.js load)
 *   factoryForType(cfg, emit) → provider factory fn (gateway | cli | module)
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { createGatewayProvider } from "./gateway.js";
import { createCliProvider } from "./cli.js";
import { createModuleProvider } from "./module.js";

// createRequire lets us synchronously require() the optional `yaml` package
// from ESM. The require is lazy (only invoked when a YAML config is actually
// parsed), so JSON-only users and the seeding path never pay the import cost.
const require = createRequire(import.meta.url);

const BUILTIN = new Set([
    "claude", "codex", "opencode", "antigravity",
    "oh-my-pi", "pi", "hermes", "openclaw",
]);
const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const URL_RE = /^https?:\/\/[^\s]+$/i;

// --------------------------- template + guide -------------------------------

const TEMPLATE_YAML = `# ~/.agent-home/agents.yaml
#
# Add your own agents here. Uncomment one of the examples below, fill in your
# values, and RESTART the backend. Each entry becomes a selectable agent in
# Agent Home, listed by its 'name'. No code changes required for Tier 1 & 2.
#
# Custom agents are ADDITIONS — they never change or break the built-in ones.
# A bad entry is skipped (with a logged message) and the rest still load.
#
# Full guide (all fields, troubleshooting): ~/.agent-home/README.md
# ---------------------------------------------------------------------
#
# Tier 1 — type: gateway  (an OpenAI-compatible server: Ollama, LM Studio, vLLM…)
#
# agents:
#   - name: ollama-local
#     type: gateway
#     gatewayUrl: http://127.0.0.1:11434
#     model: llama3.1
#     models: [llama3.1, qwen2.5, mistral]
#     apiKey: ""            # leave empty for no-auth local servers
#     # apiKeyEnv: MY_KEY   # or read the key from an env var (recommended)
#
# Tier 2 — type: cli  (a command-line tool that streams one JSON object per line)
#
# agents:
#   - name: my-pi-clone
#     type: cli
#     bin: pi
#     args: ["-p", "--mode", "json", "{{text}}"]
#     sessionFlag: ["--session", "{{sessionId}}"]
#     model: llama3.1
#     sessionsDir: "~/.pi/agent/sessions"
#     cwdEncoder: omp-compat
#     events:
#       sessionId: "session.id"
#       textDelta: { type: "message_update", nestedType: "assistantMessageEvent.type", value: "assistantMessageEvent.delta" }
#       thinkingAsText: true
#       resultMarkers: [turn_end, agent_end]
#
# Tier 3 — type: module  (bespoke logic: a JS file you write — the escape hatch)
#
# agents:
#   - name: my-weird-agent
#     type: module
#     module: /home/me/my-agent-provider.js   # exports createProvider(emit, options)
#     options: { bin: mycli }
`;

/**
 * The user-facing README content. In dev (running from the repo), prefer the
 * rich, hand-maintained docs/custom-agents-guide.md. If that isn't found (e.g.
 * an install without docs/), fall back to a compact inline guide so seeding
 * still gives the user something useful.
 */
function readGuideContent() {
    try {
        // backend/src/providers/loader.js → repo root docs/
        const here = path.dirname(fileURLToPath(import.meta.url));
        const guidePath = path.resolve(here, "../../../docs/custom-agents-guide.md");
        const content = fs.readFileSync(guidePath, "utf8");
        if (content && content.trim()) {
            return content;
        }
    } catch {}
    return FALLBACK_README;
}

const FALLBACK_README = `# Agent Home — Custom Agents Guide

Add your own agents by editing \`~/.agent-home/agents.yaml\`. Three tiers:

1. **type: gateway** — an OpenAI-compatible server (Ollama, LM Studio, vLLM…).
   4 fields: name, gatewayUrl, model, (optional) apiKey/apiKeyEnv. No code.
2. **type: cli** — a CLI that streams JSON lines. Declare \`bin\`, \`args\`, and an
   \`events\` map (which JSON fields = session id / token delta / completion).
3. **type: module** — a JS file you write that exports \`createProvider(emit, options)\`.
   The escape hatch for tools too bespoke to describe (daemons, polling, SQLite…).

Restart the backend after editing. Custom agents are additions only; they never
change or break the built-ins. A bad entry is skipped (logged) and the rest load.

See the commented examples in \`agents.yaml\` for each tier. The full field
reference is in the repo at docs/custom-agents-guide.md.
`;

// ------------------------------- seeding ------------------------------------

function configCandidates() {
    return [
        process.env.AGENTHOME_AGENTS_CONFIG,
        path.join(os.homedir(), ".agent-home", "agents.yaml"),
        path.join(os.homedir(), ".agent-home", "agents.json"),
    ].filter(Boolean);
}

function fileExists(p) {
    try { return fs.existsSync(p); } catch { return false; }
}

/**
 * Seed the template config + README on first run so the user has files to edit.
 * Idempotent (only writes if NO config exists) and opt-out via
 * AGENTHOME_AGENTS_NO_SEED=1. Never changes behavior: the template's agents are
 * all commented out → parses to {agents: []} → zero agents loaded.
 */
function seedIfNeeded() {
    if (process.env.AGENTHOME_AGENTS_NO_SEED === "1") return;
    const configExists = configCandidates().some(fileExists);
    if (configExists) return;

    const dir = path.join(os.homedir(), ".agent-home");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try {
        const cfgPath = path.join(dir, "agents.yaml");
        // Don't clobber if it appeared between the check and now (race-safe).
        if (!fileExists(cfgPath)) fs.writeFileSync(cfgPath, TEMPLATE_YAML, "utf8");
    } catch (e) {
        console.error(`[agents] could not seed agents.yaml: ${e.message}`);
    }
    try {
        const readmePath = path.join(dir, "README.md");
        if (!fileExists(readmePath)) fs.writeFileSync(readmePath, readGuideContent(), "utf8");
    } catch (e) {
        console.error(`[agents] could not seed README.md: ${e.message}`);
    }
}

// ------------------------------- parsing ------------------------------------

function parseYaml(text) {
    // Lazy require so the dependency is only loaded when a YAML config is used.
    // Tests that only exercise JSON / seeding never pay the import cost.
    const YAML = require("yaml");
    return YAML.parse(text);
}

function parseConfigFile(configFile) {
    const raw = fs.readFileSync(configFile, "utf8");
    if (configFile.endsWith(".json")) return JSON.parse(raw);
    return parseYaml(raw);
}

// ------------------------------ validation ----------------------------------

function fail(entry, message) {
    const label = (entry && typeof entry.name === "string") ? entry.name : JSON.stringify(entry?.name);
    console.error(`[agents] skipping custom agent "${label}": ${message}`);
    return null;
}

function asArray(v) {
    return Array.isArray(v) ? v : null;
}

/**
 * Validate + normalize one entry. Returns a resolved config object or null
 * (null = skip with a logged error, never throw). Normalization:
 *   - expands ~ in path-like string fields
 *   - coerces models to an array
 *   - defaults models to [model]
 */
function resolveEntry(entry, seen) {
    if (!entry || typeof entry !== "object") {
        return fail(entry, "entry is not an object");
    }
    const name = entry.name;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
        return fail(entry, `name "${name}" must match ${NAME_RE} (lowercase, start with a letter)`);
    }
    if (BUILTIN.has(name)) {
        return fail(entry, `name "${name}" collides with a built-in agent`);
    }
    if (seen.has(name)) {
        return fail(entry, `name "${name}" is defined more than once`);
    }

    const type = entry.type;
    if (type !== "gateway" && type !== "cli" && type !== "module") {
        return fail(entry, `type "${type}" must be one of: gateway, cli, module`);
    }

    const expand = (s) => (typeof s === "string" ? s.replace(/^~(?=$|\/|\\)/, os.homedir()) : s);
    const resolved = { name, type, raw: entry };

    if (type === "gateway") {
        const gatewayUrl = expand(entry.gatewayUrl);
        if (typeof gatewayUrl !== "string" || !URL_RE.test(gatewayUrl)) {
            return fail(entry, `gatewayUrl "${gatewayUrl}" must be an http(s):// URL`);
        }
        if (typeof entry.model !== "string" || !entry.model.trim()) {
            return fail(entry, "gateway requires a non-empty 'model'");
        }
        resolved.gatewayUrl = gatewayUrl;
        resolved.model = entry.model;
        resolved.apiKey = typeof entry.apiKey === "string" ? entry.apiKey : "";
        if (typeof entry.apiKeyEnv === "string" && entry.apiKeyEnv.trim()) resolved.apiKeyEnv = entry.apiKeyEnv;
    } else if (type === "cli") {
        if (typeof entry.bin !== "string" || !entry.bin.trim()) {
            return fail(entry, "cli requires a non-empty 'bin'");
        }
        if (!Array.isArray(entry.args)) {
            return fail(entry, "cli requires an 'args' array (use {{text}} for the prompt)");
        }
        if (!entry.events || typeof entry.events !== "object") {
            return fail(entry, "cli requires an 'events' map (at minimum textDelta or resultMarkers)");
        }
        resolved.bin = entry.bin;
        resolved.args = entry.args;
        if (Array.isArray(entry.sessionFlag)) resolved.sessionFlag = entry.sessionFlag;
        if (Array.isArray(entry.thinkingFlag)) resolved.thinkingFlag = entry.thinkingFlag;
        resolved.model = typeof entry.model === "string" ? entry.model : name;
        resolved.events = entry.events;
        if (typeof entry.sessionsDir === "string") resolved.sessionsDir = expand(entry.sessionsDir);
        if (typeof entry.cwdEncoder === "string") resolved.cwdEncoder = entry.cwdEncoder;
        if (entry.env && typeof entry.env === "object") resolved.env = entry.env;
        if (entry.detached === false) resolved.detached = false;
        if (entry.suppressColor === false) resolved.suppressColor = false;
        if (typeof entry.timeoutMs === "number") resolved.timeoutMs = entry.timeoutMs;
    } else { // module
        const modulePath = expand(entry.module);
        if (typeof modulePath !== "string" || !modulePath.trim()) {
            return fail(entry, "module requires a 'module' path (absolute path or package)");
        }
        resolved.module = modulePath;
        if (entry.options && typeof entry.options === "object") resolved.options = entry.options;
        resolved.model = typeof entry.model === "string" ? entry.model : name;
    }

    // Shared: models picker + bin availability gate.
    const models = asArray(entry.models);
    resolved.models = models && models.length ? models.map(String) : (resolved.model ? [resolved.model] : []);
    if (entry.bin != null && typeof entry.bin === "string") resolved.bin = entry.bin;
    resolved.binGate = entry.bin != null ? entry.bin : null; // null = always available

    seen.add(name);
    return resolved;
}

// ------------------------------- public API ---------------------------------

/**
 * Load + validate all custom-agent configs. Returns [] when there is no config
 * file or every entry is invalid. NEVER throws (zero-config guarantee).
 */
export function loadCustomAgentConfigs() {
    try {
        seedIfNeeded();
        const configFile = configCandidates().find(fileExists);
        if (!configFile) return [];

        let parsed;
        try {
            parsed = parseConfigFile(configFile);
        } catch (e) {
            console.error(`[agents] failed to parse ${configFile}: ${e.message}`);
            return [];
        }

        const entries = (parsed && Array.isArray(parsed.agents)) ? parsed.agents : [];
        const seen = new Set();
        const valid = [];
        for (const entry of entries) {
            const resolved = resolveEntry(entry, seen);
            if (resolved) valid.push(resolved);
        }
        return valid;
    } catch (e) {
        // Defensive: any unexpected error must not crash the server.
        console.error(`[agents] loader error (continuing with no custom agents): ${e.message}`);
        return [];
    }
}

/**
 * Build a provider factory for a resolved config, dispatched by `type`.
 * Returns a `() => Provider` (gateway/cli) or an async `() => Promise<Provider>`
 * (module — dynamic import). core.js's getProviderInstance memoizes the result.
 */
export function factoryForType(cfg, emit) {
    if (cfg.type === "gateway") return () => createGatewayProvider(cfg, emit);
    if (cfg.type === "cli") return () => createCliProvider(cfg, emit);
    if (cfg.type === "module") return () => createModuleProvider(cfg, emit);
    // Unreachable: validation rejects unknown types. Defensive no-op factory.
    return () => {
        throw new Error(`Custom agent "${cfg.name}": unknown type "${cfg.type}"`);
    };
}

/** Exported for tests: the set of reserved (built-in) agent names. */
export function getBuiltinAgentNames() {
    return new Set(BUILTIN);
}
