# Custom Agent Support — Implementation Plan

> **Status:** Design / not yet implemented
> **Goal:** Let a user add a custom agent (e.g. an OpenAI-compatible local LLM
> server) by dropping a YAML file into a config directory — **without changing
> backend or frontend code** and without writing JavaScript.
> **Scope of v1:** `type: gateway` agents only (OpenAI-compatible SSE streaming).
> The `type: cli` archetype is documented as a future extension.

---

## 1. Why this is feasible (grounded in the current code)

The provider *interface* is uniform and small, and the registration surface is
contained in a single file. Two facts make this low-risk:

1. **The frontend is already data-driven.** `/api/agents` and `/api/models` are
   fetched dynamically; the glasses renderer (`web/src/controller/model.ts`) has
   **zero** provider-name logic. Unknown agents render and function correctly
   with graceful fallbacks (`models[0]` default, end-of-list sort order). No
   frontend change is required for a custom agent to appear and work.

2. **There is a working registry precedent.** `backend/src/expose/registry.js`
   is a clean drop-in adapter registry where each entry is a tiny declarative
   object (`name`, `program`, `buildArgs`, `parseUrl`). This plan mirrors that
   pattern for agents.

The 8 built-in providers collapse into 3 archetypes; **v1 targets archetype #1**
(HTTP gateway), which already has two near-identical implementations:
- **Gateway** (OpenAI-compatible SSE) — `hermes` (`backend/src/hermes/provider.js`),
  `openclaw` (`backend/src/openclaw/provider.js`). Parameterizable by
  `gatewayUrl`, `model`, `apiKey`/env, optional session-list command.
- **CLI** (spawn per prompt, read JSONL events) — `pi`, `oh-my-pi`, `opencode`,
  `antigravity`. Each speaks a *different* JSON event dialect → hard to
  generalize. Out of scope for v1.
- **SDK / app-server** — `claude` (Claude SDK), `codex` (JSON-RPC over WS). Own
  long-lived clients; not config-friendly. Out of scope.

The `gateway` archetype covers the most common real-world use case: point Agent
Home at any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a custom local
server, a remote OpenAI-compatible proxy) with zero code.

---

## 2. The hardcoded chokepoints (all in `backend/src/routes/core.js`)

Every agent is hardcoded in **four synchronized maps** at the top of one file.
A config-file agent must get into all four, but only the first is substantial.

| # | Chokepoint | Location | Must become |
|---|---|---|---|
| **B1** | `providerFactories` map + 8 imports | `core.js:4-11, 26-35` | A loader that builds a factory per config entry, keyed by name. Needs one generic `createGatewayProvider(config, emit)` factory. |
| **B2** | `CLI_BINS` map | `core.js:67-76` | Read `bin` from config (or `null` for "always available"). One line per entry. |
| **B3** | `DEFAULT_MODELS` seed + `MODEL_LIST_ARGS` | `core.js:83-96` | Read `model`/`models` from config into the seed. |
| **B4** | Name-based branches in `refreshModels` / `parseModels` | `core.js:189-192, 214` | Switch on `type`, not provider name. |

What needs **no change** (already dynamic):
- `SUPPORTED_PROVIDERS` (`core.js:60`) — derived from `Object.keys(providerFactories)`.
- `/api/agents` (`core.js:290`) — returns `scanAgentAvailability()`, driven by the maps.
- `getProviderInstance` (`core.js:39-47`) — generic memoized lookup.
- `startModelRefreshAll` (`core.js:271`) — iterates `SUPPORTED_PROVIDERS`.
- The entire frontend agent/model UI.

Frontend special-casing that is **cosmetic-only** (graceful fallback, no change
required): `PREFERRED_DEFAULT_MODEL` (`App.tsx:46`), `PREFERRED_ORDER`
(`App.tsx:578`), model-picker UI suppression (`App.tsx:1074`). A custom agent
just gets `models[0]` as default and sorts to the end of the list.

---

## 3. The provider contract (exact surface)

Every provider factory returns the same ~10-method object. Verified across
`hermes/provider.js:295-298`, `pi/provider.js:799-810`, `codex/provider.js:429-441`.

| Method | Signature | Required? |
|---|---|---|
| `prompt` | `async prompt(sessionId, text, cwd, model, thinking, yolo) → {sessionId, provider}` | **Yes** |
| `listSessions` | `listSessions(limit, cwd) → [{id,title,timestamp,cwd,provider,status}]` | **Yes** |
| `getHistory` | `getHistory(sessionId, limit) → [{role, text}]` | **Yes** |
| `getStatus` | `getStatus(sessionId) → {state, provider, error?} \| null` | **Yes** |
| `interrupt` | `interrupt(sessionId) → void` | **Yes** |
| `getSessionStatus` | `getSessionStatus(sessionId) → "busy"\|"idle"` | Optional (fallback if `getStatus` returns null) |
| `getInfo` | `getInfo() → {account, model, version, provider}` | Optional |
| `respondPermission` | `respondPermission(sessionId, decision) → void` | No-op stub OK |
| `respondQuestion` | `respondQuestion(sessionId, answer) → void` | No-op stub OK |
| `dispose` | `dispose() → void \| Promise` | Optional |

**Factory signature:** `createXProvider(emit [, getClient]) → providerObject`, where
`emit(sessionId, msg)` is captured from the caller (`core.js:17-21`).

**Emit event vocabulary** (fixed):
`{type: "user_prompt"|"status"|"text_delta"|"tool_start"|"tool_end"|"result"|"error", ...}`

The `gateway` archetype implements all of these in ~130 lines (see
`hermes/provider.js`, which is the template for the generic factory).

---

## 4. Config schema (`~/.agent-home/agents.yaml`)

YAML is the target format (readable, supports comments). A JSON file
(`agents.json`) is also accepted for users who prefer it / can't easily write
YAML. The loader resolves the first of: `$AGENTHOME_AGENTS_CONFIG` env var,
`~/.agent-home/agents.yaml`, `~/.agent-home/agents.json`. Missing file = no
custom agents (silent no-op, not an error).

```yaml
# ~/.agent-home/agents.yaml
# Add OpenAI-compatible agents. Each becomes a selectable agent in Agent Home,
# listed by its `name`. No backend/frontend code changes required.
agents:
  - name: ollama-local
    type: gateway
    gatewayUrl: http://127.0.0.1:11434       # OpenAI-compatible endpoint
    model: llama3.1                          # default model (sent as `model:` in the request)
    models: [llama3.1, qwen2.5, mistral]     # optional: models offered in the picker
    apiKey: ""                               # optional; many local servers ignore it
    bin: null                                # optional; null = always "available", else `command -v <bin>` gates it

  - name: remote-proxy
    type: gateway
    gatewayUrl: https://my-llm-proxy.example.com
    model: gpt-4o
    models: [gpt-4o, gpt-4o-mini]
    apiKeyEnv: REMOTE_PROXY_KEY              # optional: read key from this env var (never write secrets in YAML)
    bin: null
```

### Field reference

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | Unique agent id. Must match `^[a-z][a-z0-9-]*$` (lowercase, URL-safe). Becomes the `provider` value everywhere. |
| `type` | yes | — | `gateway` (v1). `cli` reserved for future. |
| `gatewayUrl` | yes (gateway) | — | Base URL; `/v1/chat/completions` is appended. |
| `model` | yes (gateway) | — | Default model id sent in the request body. |
| `models` | no | `[model]` | Models shown in the picker. If omitted, `[model]` is used. |
| `apiKey` | no | `""` | Static key (sent as `Authorization: Bearer <key>`). Leave empty for no-auth local servers. |
| `apiKeyEnv` | no | — | Env var name to read the key from (preferred over `apiKey` for secrets). `apiKeyEnv` wins if both set. |
| `bin` | no | `null` | `null` = always available. A string = the agent is "available" only if `command -v <bin>` succeeds (used to probe whether the server is running). |

### Validation rules (enforced at startup)
- `name` unique across the file AND not colliding with a built-in provider name.
- `name` matches `^[a-z][a-z0-9-]*$`.
- `type` is a known archetype (`gateway`).
- `gatewayUrl` parses as `http(s)://host[:port]`.
- On any validation failure: log a clear error, **skip that entry** (don't crash
  the server), and continue loading the rest.

---

## 5. Implementation steps

All changes are backend-only. No frontend edits. Estimated effort: ~1 day.

### Step 1 — Create the generic gateway provider factory
**New file:** `backend/src/providers/gateway.js`

A parameterized version of `createHermesProvider`. It takes a resolved config
object instead of reading module-level constants:

```js
// backend/src/providers/gateway.js
// Generic OpenAI-compatible gateway provider. Parameterized version of the
// hermes/openclaw providers — powers config-file-defined `type: gateway` agents
// so a user can add a local LLM server (Ollama, LM Studio, vLLM, …) with no JS.
export function createGatewayProvider(config, emit) {
    const { name, gatewayUrl, model: defaultModel, apiKey } = config;
    const sessions = new Map();
    // … mirrors hermes/provider.js: prompt() streams SSE from
    // `${gatewayUrl}/v1/chat/completions`, emits text_delta/status/result,
    // getHistory/listSessions/getStatus/interrupt/dispose.
    // Key differences from hermes:
    //   - gatewayUrl, defaultModel, apiKey come from `config`, not module consts
    //   - provider field in returned objects = `name`
    //   - no session-list refresh (gateway agents are stateless from our side;
    //     listSessions returns only in-memory sessions — see "Limitations" §7)
    return { prompt, listSessions, getHistory, getStatus, interrupt,
             getSessionStatus, getInfo, respondPermission, respondQuestion, dispose };
}
```

The body is a near-copy of `hermes/provider.js:8-300` with the three constants
(`GATEWAY_URL`, `MODEL`, `API_KEY`) replaced by `config` reads. This is the
largest single piece of new code, but it's mechanical — the SSE streaming loop,
emit vocabulary, and session Map management are identical to hermes.

### Step 2 — Create the config loader
**New file:** `backend/src/providers/loader.js`

```js
// backend/src/providers/loader.js
// Loads ~/.agent-home/agents.yaml (or .json), validates, and returns a list of
// resolved config objects. Silent no-op if no config file exists.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export function loadCustomAgentConfigs() {
    const candidates = [
        process.env.AGENTHOME_AGENTS_CONFIG,
        path.join(os.homedir(), ".agent-home", "agents.yaml"),
        path.join(os.homedir(), ".agent-home", "agents.json"),
    ].filter(Boolean);

    const configFile = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!configFile) return [];

    let parsed;
    try {
        const raw = fs.readFileSync(configFile, "utf8");
        parsed = configFile.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (e) {
        console.error(`[agents] Failed to parse ${configFile}: ${e.message}`);
        return [];
    }

    const entries = Array.isArray(parsed?.agents) ? parsed.agents : [];
    const BUILTIN = new Set(["claude","codex","opencode","antigravity","oh-my-pi","pi","hermes","openclaw"]);
    const seen = new Set();
    const valid = [];
    for (const entry of entries) {
        // validate name, type, gatewayUrl; skip on failure with a logged error
        // (see validation rules §4). Don't crash the server for one bad entry.
        const resolved = resolveAndValidate(entry, BUILTIN, seen);
        if (resolved) valid.push(resolved);
    }
    return valid;
}
```

**YAML parsing:** ship a tiny inline parser OR add `yaml` as a dependency.
Recommendation: add `yaml` (well-maintained, ~100KB) to `backend/package.json`
rather than hand-rolling a parser — the schema is small but quote/escape edge
cases aren't worth reinventing. A `agents.json` fallback covers users who don't
want the dependency.

### Step 3 — Wire the loader into `core.js` at startup
**Edit:** `backend/src/routes/core.js`

At module load (after the existing `providerFactories` / `CLI_BINS` /
`DEFAULT_MODELS` literals), load custom agents and merge them into the three
maps. The built-ins stay exactly as-is; custom entries are *added*.

```js
// core.js — after the existing hardcoded maps (line ~96)

import { loadCustomAgentConfigs } from "../providers/loader.js";
import { createGatewayProvider } from "../providers/gateway.js";

const customConfigs = loadCustomAgentConfigs();
for (const cfg of customConfigs) {
    if (providerFactories[cfg.name]) continue;            // safety: never overwrite built-ins
    providerFactories[cfg.name] = () => createGatewayProvider(cfg, emit);
    CLI_BINS[cfg.name] = cfg.bin ?? null;
    DEFAULT_MODELS[cfg.name] = cfg.models?.length ? cfg.models : [cfg.model];
}
// SUPPORTED_PROVIDERS (line 60) is derived AFTER this merge if we move its
// definition below the loop, OR we recompute it. Simplest: move the
// `const SUPPORTED_PROVIDERS = Object.keys(providerFactories);` line to AFTER
// the custom-agent merge.
```

Because `SUPPORTED_PROVIDERS`, `/api/agents`, `getProviderInstance`, and
`startModelRefreshAll` all derive from `providerFactories`, a merged entry
**automatically** appears in the agent list, the availability scan, the model
cache seed, and every route's membership check. That's the whole wiring.

### Step 4 — Make `refreshModels` dispatch on `type`, not name
**Edit:** `backend/src/routes/core.js:213-214`

The current branch forces the static-model path for `hermes`/`openclaw` by name:
```js
if (bin === null || provider === "hermes" || provider === "openclaw") { /* static */ }
```
Generalize to "any provider with `bin === null` uses static models":
```js
if (bin === null) { /* static: cached.models = DEFAULT_MODELS[provider] */ }
```
This already covers hermes/openclaw (their `CLI_BINS` entry is `null`) and any
custom gateway agent with `bin: null`. The `provider === "hermes" || …` clause
becomes redundant and is removed. No behavior change for built-ins.

### Step 5 — Tests
**New files:**
- `scripts/test-custom-agent-loader.mjs` — unit tests for the loader: valid
  config, missing file (empty), bad YAML (skip), name collision with built-in
  (skip), invalid name regex (skip), `apiKeyEnv` resolution.
- Extend `scripts/test-provider-contracts.mjs` (or a new
  `scripts/test-gateway-provider.mjs`) — spin up a mock OpenAI-compatible SSE
  server on a localhost port, point a `type: gateway` config at it, and exercise
  `prompt` → `text_delta` → `result`, `getHistory`, `listSessions`, `interrupt`,
  `dispose`. This proves the generic factory works against a real (mocked)
  endpoint without needing a real LLM.

Run under the existing `npm test --prefix backend` (the runner auto-picks up
new `scripts/test-*.mjs` files).

### Step 6 — Docs
- Add a "Custom Agents" section to `backend/README.md` (the config file
  location, schema, and an Ollama example).
- Add a row to the provider table in `README.md` (root) noting custom agents.

---

## 6. What does NOT change

- **Frontend** — zero edits. Custom agents appear via `/api/agents` and work
  through the existing data-driven UI.
- **Built-in providers** — untouched. They remain hardcoded; the loader only
  *adds* entries, never overwrites (the `if (providerFactories[cfg.name]) continue`
  guard prevents collisions).
- **`backend/src/index.js`** — untouched. Startup wiring is unchanged; the
  loader runs at `core.js` module-load time.
- **Encryption, STT, SSE event stream, multi-backend registry** — untouched.

---

## 7. Limitations & future extensions

- **No persistent session history for gateway agents (v1).** The generic
  factory holds sessions in-memory only; `listSessions` returns just the
  sessions active in this backend process. On backend restart, prior
  conversations are gone (the LLM server may retain them, but we don't read
  them back). This matches `hermes` today. To add persistence later, the
  factory would need a session-list command or a transcript dir like openclaw's
  — that's a per-server detail, not generically solvable.
- **`type: cli` (future).** The spawn-a-CLI archetype (`pi`, `oh-my-pi`, …) is
  harder because each CLI speaks a different JSON event dialect. A future
  `type: cli` could support a declared event-schema mapping, but it's
  substantially more work and lower-value than the gateway type.
- **No hot-reload (v1).** The config is read once at startup. Changing
  `agents.yaml` requires a backend restart (consistent with how openclaw config
  is handled). A file-watcher could be added later.
- **`thinking` / `yolo` flags** are passed through but ignored by the gateway
  factory (the OpenAI schema has no standard "thinking level"). `prompt()`'s
  `thinking` arg is accepted and discarded, matching hermes.

---

## 8. Risk assessment

- **Low risk to built-ins.** The merge is purely additive with a collision
  guard. Built-in providers are never overwritten; if the loader fails or the
  config file is absent, behavior is identical to today.
- **Contained blast radius.** All changes are in `core.js` + two new files
  under `backend/src/providers/`. No existing provider file is edited.
- **Graceful degradation.** A malformed config entry is skipped with a logged
  error, not a crash (mirrors `expose/registry.js`'s validation approach).
- **The generic factory is the only non-trivial code**, and it's a
  parameterized copy of a battle-tested provider (`hermes`), not new logic.

---

## 9. File manifest

| File | Action | Purpose |
|---|---|---|
| `backend/src/providers/gateway.js` | **new** | Generic OpenAI-compatible gateway factory (parameterized hermes) |
| `backend/src/providers/loader.js` | **new** | YAML/JSON config loader + validator |
| `backend/src/routes/core.js` | edit | Merge custom configs into the 3 maps; move `SUPPORTED_PROVIDERS` derivation after the merge; generalize the `refreshModels` static-model branch from name-based to `bin === null` |
| `backend/package.json` | edit | Add `yaml` dependency |
| `scripts/test-custom-agent-loader.mjs` | **new** | Loader unit tests |
| `scripts/test-gateway-provider.mjs` | **new** | Factory integration test against a mock SSE server |
| `backend/README.md` | edit | Custom Agents section + example |
| `README.md` | edit | Provider table note |

**Total:** 4 new files, 4 edits. Zero frontend changes.
