# Custom Agent Support — Implementation Plan

> **Status:** Design / not yet implemented
> **Goal:** Let a user add a custom agent (e.g. an OpenAI-compatible local LLM
> server) by **filling out a template config file** — no JavaScript, no backend
> or frontend code changes.
>
> **Hard requirements (v1):**
> 1. **Zero-config backward compatibility.** If the user configures nothing,
>    every existing built-in agent continues to work byte-for-byte as today. We
>    may (and will) **seed a template config on first startup** so the file
>    exists with commented examples, but this MUST NOT change behavior.
> 2. **Template-driven, not code-driven.** The user adds an agent by editing a
>      small config file (filling in fields like name / URL / model), never by
>      writing a provider module.
>
> **Scope of v1:** `type: gateway` agents only (OpenAI-compatible SSE streaming).
> The `type: cli` archetype is documented as a future extension. **Backend-only
> change** — the frontend stays untouched.

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
   is a clean drop-in adapter registry validated at module load. This plan
   mirrors that pattern (load → validate at startup → expose helpers).

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
server, a remote OpenAI-compatible proxy) by filling in 3–4 fields.

---

## 2. Zero-config backward compatibility (requirement #1)

This is a hard guarantee, enforced structurally — not just by convention.

### The invariant: built-ins are never touched by the loader

The loader is **purely additive**. Built-in providers are hardcoded in
`core.js` exactly as today; the loader only *adds* new entries to the maps,
guarded by a collision check. Concretely (see §6 for the code):

```js
for (const cfg of customConfigs) {
    if (providerFactories[cfg.name]) continue;   // never overwrite (built-in OR duplicate)
    providerFactories[cfg.name] = () => createGatewayProvider(cfg, emit);
    CLI_BINS[cfg.name] = cfg.bin ?? null;
    DEFAULT_MODELS[cfg.name] = cfg.models?.length ? cfg.models : [cfg.model];
}
```

Failure modes all collapse to "behaves like today":
- **No config file** → loader returns `[]` → zero entries added.
- **Config file missing/unreadable/invalid** → loader returns `[]` (parse
  errors logged, never thrown) → zero entries added.
- **One bad entry** → that entry is skipped with a logged error; the rest load.
- **Name collides with a built-in** (`claude`, `pi`, …) → entry skipped.

So whether the user does nothing, deletes the config, or writes garbage, the 8
built-in agents remain identical to today's behavior.

### First-startup template seeding (optional, behavior-preserving)

On the **first** load, if `~/.agent-home/agents.yaml` (and `.json`) does **not**
exist, the loader writes a **template** file with commented-out example
entries, then reads it back (the commented examples yield zero agents, so
behavior is unchanged). This gives the user an obvious file to edit — they
don't have to discover the path or invent the schema.

```
# ~/.agent-home/agents.yaml   (written automatically on first run)
# ─────────────────────────────────────────────────────────────
# Add OpenAI-compatible agents here. Uncomment an example and fill in
# your values, then restart the backend. Each entry becomes a selectable
# agent in Agent Home, listed by its `name`.
#
# agents:
#   - name: ollama-local
#     type: gateway
#     gatewayUrl: http://127.0.0.1:11434
#     model: llama3.1
#     models: [llama3.1, qwen2.5]
#     apiKey: ""           # leave empty for no-auth local servers
#     bin: null            # null = always available
```

- Seeding is **idempotent**: the `if (!exists)` guard means it only writes once.
  Subsequent edits by the user are never clobbered.
- Seeding is **opt-out**: `AGENTHOME_AGENTS_NO_SEED=1` skips writing the
  template (for headless/managed installs that don't want files written).
- The `.agent-home` directory is already established in the project (`stt.js:36`
  uses `~/.agent-home/models`), so creating `~/.agent-home/` is consistent.
- The template lists `agents:` as fully commented-out, so parsing it yields
  `agents: []` → no agents added → identical behavior to "no config".

### Prove-it test (required)

A test asserts the zero-config guarantee: run the loader with the template
seeding enabled in a temp home dir, then assert the merged provider maps contain
**exactly** the 8 built-in names and **no** custom ones. This is the regression
guard for requirement #1.

---

## 3. The hardcoded chokepoints (all in `backend/src/routes/core.js`)

Every agent is hardcoded in **four synchronized maps** at the top of one file.
A config-file agent must get into all four, but only the first is substantial.
Line numbers verified against current `main`.

| # | Chokepoint | Location | Must become |
|---|---|---|---|
| **B1** | `providerFactories` map + 8 imports | `core.js:4-11, 26-35` | A loader that builds a factory per config entry, keyed by name. Needs one generic `createGatewayProvider(config, emit)` factory. |
| **B2** | `CLI_BINS` map | `core.js:67-76` | Read `bin` from config (or `null` for "always available"). One line per entry. |
| **B3** | `DEFAULT_MODELS` seed | `core.js:87-96` | Read `model`/`models` from config into the seed. |
| **B4** | Name-based branch in `refreshModels` | `core.js:214` | Switch on `bin === null`, not provider name. |

What needs **no change** (already dynamic):
- `SUPPORTED_PROVIDERS` (`core.js:60`) — derived from `Object.keys(providerFactories)`; just move this line to *after* the custom-agent merge (§6).
- `/api/agents` (`core.js:290`) — returns `scanAgentAvailability()`, driven by the maps.
- `getProviderInstance` (`core.js:39-47`) — generic memoized lookup.
- `startModelRefreshAll` (`core.js:271`) — iterates `SUPPORTED_PROVIDERS`.
- The entire frontend agent/model UI.

Frontend special-casing that is **cosmetic-only** (graceful fallback, no change
required): `PREFERRED_DEFAULT_MODEL` (`App.tsx:46`), `PREFERRED_ORDER`
(`App.tsx:578`), model-picker UI suppression (`App.tsx:1074`). A custom agent
just gets `models[0]` as default and sorts to the end of the list.

---

## 4. The provider contract (exact surface)

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

## 5. Config schema + the template a user fills in

**Location resolution** (first match wins):
1. `$AGENTHOME_AGENTS_CONFIG` env var (absolute path to `.yaml` or `.json`)
2. `~/.agent-home/agents.yaml`
3. `~/.agent-home/agents.json`

If none exists, the loader **seeds** `~/.agent-home/agents.yaml` (the template
in §2) and reads it. Missing/empty = no custom agents (silent no-op, not an error).

### The template — what the user fills in

The user edits **one file** and fills in a handful of fields. Here is the
annotated template (this is what gets seeded, minus the comments):

```yaml
# ~/.agent-home/agents.yaml
agents:
  - name: ollama-local              # required: lowercase, URL-safe id
    type: gateway                   # required: must be 'gateway' (v1)
    gatewayUrl: http://127.0.0.1:11434   # required: OpenAI-compatible base URL
    model: llama3.1                 # required: default model id
    models: [llama3.1, qwen2.5, mistral] # optional: picker list (defaults to [model])
    apiKey: ""                      # optional: static key (Bearer). Empty = no auth.
    apiKeyEnv: REMOTE_PROXY_KEY     # optional: read key from this env var (wins over apiKey)
    bin: null                       # optional: null = always available; 'command -v <bin>' gates it

  - name: remote-proxy
    type: gateway
    gatewayUrl: https://my-llm-proxy.example.com
    model: gpt-4o
    models: [gpt-4o, gpt-4o-mini]
    apiKeyEnv: REMOTE_PROXY_KEY
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
  the server), and continue loading the rest. (Mirrors `expose/registry.js`'s
  validate-at-load approach, but skips-and-continues instead of exiting.)

---

## 6. Implementation steps

All changes are backend-only. No frontend edits.

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
    //     listSessions returns only in-memory sessions — see "Limitations" §8)
    return { prompt, listSessions, getHistory, getStatus, interrupt,
             getSessionStatus, getInfo, respondPermission, respondQuestion, dispose };
}
```

The body is a near-copy of `hermes/provider.js:8-300` with the three constants
(`GATEWAY_URL`, `MODEL`, `API_KEY`) replaced by `config` reads. This is the
largest single piece of new code, but it's mechanical — the SSE streaming loop,
emit vocabulary, and session Map management are identical to hermes.

### Step 2 — Create the config loader + seeder
**New file:** `backend/src/providers/loader.js`

Two responsibilities: **seed** the template on first run (§2), and **load +
validate** entries.

```js
// backend/src/providers/loader.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BUILTIN = new Set(["claude","codex","opencode","antigravity","oh-my-pi","pi","hermes","openclaw"]);
const TEMPLATE = `# ~/.agent-home/agents.yaml
# Add OpenAI-compatible agents here. Uncomment an example, fill in your
# values, and restart the backend. Each entry becomes a selectable agent in
# Agent Home, listed by its 'name'. No code changes required.
#
# agents:
#   - name: ollama-local
#     type: gateway
#     gatewayUrl: http://127.0.0.1:11434
#     model: llama3.1
#     models: [llama3.1, qwen2.5]
#     apiKey: ""        # leave empty for no-auth local servers
#     bin: null         # null = always available
`;

function configCandidates() {
    return [
        process.env.AGENTHOME_AGENTS_CONFIG,
        path.join(os.homedir(), ".agent-home", "agents.yaml"),
        path.join(os.homedir(), ".agent-home", "agents.json"),
    ].filter(Boolean);
}

// Seed the template on first run so the user has a file to edit. Idempotent
// (only writes if no config exists) and opt-out (AGENTHOME_AGENTS_NO_SEED=1).
// Never changes behavior: the template's agents are all commented out → [].
function seedTemplateIfNeeded() {
    if (process.env.AGENTHOME_AGENTS_NO_SEED === "1") return;
    const exists = configCandidates().some((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (exists) return;
    const dir = path.join(os.homedir(), ".agent-home");
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    try { fs.writeFileSync(path.join(dir, "agents.yaml"), TEMPLATE, "utf8"); }
    catch (e) { console.error(`[agents] could not seed template: ${e.message}`); }
}

export function loadCustomAgentConfigs() {
    seedTemplateIfNeeded();
    const candidates = configCandidates();
    const configFile = candidates.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!configFile) return [];

    let parsed;
    try {
        const raw = fs.readFileSync(configFile, "utf8");
        parsed = configFile.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch (e) {
        console.error(`[agents] Failed to parse ${configFile}: ${e.message}`);
        return [];   // fail soft → behaves like "no config" (requirement #1)
    }

    const entries = Array.isArray(parsed?.agents) ? parsed.agents : [];
    const seen = new Set();
    const valid = [];
    for (const entry of entries) {
        // validate name, type, gatewayUrl; skip on failure with a logged error
        // (validation rules §5). Don't crash the server for one bad entry.
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
    if (providerFactories[cfg.name]) continue;            // never overwrite built-ins
    providerFactories[cfg.name] = () => createGatewayProvider(cfg, emit);
    CLI_BINS[cfg.name] = cfg.bin ?? null;
    DEFAULT_MODELS[cfg.name] = cfg.models?.length ? cfg.models : [cfg.model];
}
// Move this derivation to AFTER the loop (currently line 60, before the maps):
//   const SUPPORTED_PROVIDERS = Object.keys(providerFactories);
```

**Sequencing note (verified):** `core.js` is imported by `index.js:4` and the
loader therefore runs at module-load — well before `startModelRefreshAll()`
(`index.js:104`), so custom agents are registered before the first availability
scan and model refresh. No change to `index.js` startup ordering is needed.

Because `SUPPORTED_PROVIDERS`, `/api/agents`, `getProviderInstance`, and
`startModelRefreshAll` all derive from `providerFactories`, a merged entry
**automatically** appears in the agent list, the availability scan, the model
cache seed, and every route's membership check. That's the whole wiring.

### Step 4 — Make `refreshModels` dispatch on `bin`, not name
**Edit:** `backend/src/routes/core.js:214`

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
- `scripts/test-custom-agent-loader.mjs` — unit tests for the loader, including
  the **zero-config guarantee** (required by §2):
  - **[zero-config]** template seeding in a temp home dir → merged maps contain
    exactly the 8 built-in names, no custom ones. (The regression guard for
    requirement #1.)
  - **[no-seed]** `AGENTHOME_AGENTS_NO_SEED=1` writes no file.
  - **[idempotent]** seeding twice doesn't clobber an existing file.
  - valid config (one gateway agent loads), missing file (empty), bad YAML
    (skip all), name collision with built-in (skip), invalid name regex (skip),
    `apiKeyEnv` resolution, `models` defaulting to `[model]`.
- `scripts/test-gateway-provider.mjs` — spin up a mock OpenAI-compatible SSE
  server on a localhost port, point a `type: gateway` config at it, and
  exercise `prompt` → `text_delta` → `result`, `getHistory`, `listSessions`,
  `interrupt`, `dispose`. Proves the generic factory works against a real
  (mocked) endpoint without needing a real LLM.

Run under the existing `npm test --prefix backend` (the runner auto-picks up
new `scripts/test-*.mjs` files).

### Step 6 — Docs
- Add a "Custom Agents" section to `backend/README.md`: the config file location,
  that it's seeded on first run, the schema, and an Ollama walk-through.
- Add a row to the provider table in `README.md` (root) noting custom agents.
- Update `docs/architecture.md`: custom agents are added to `providerFactories`
  at load from `~/.agent-home/agents.yaml`; built-ins untouched.

---

## 7. What does NOT change

- **Frontend** — zero edits. Custom agents appear via `/api/agents` and work
  through the existing data-driven UI.
- **Built-in providers** — untouched. They remain hardcoded; the loader only
  *adds* entries, never overwrites (the `if (providerFactories[cfg.name]) continue`
  guard prevents collisions, and all parse/validate failures return `[]` or skip).
- **`backend/src/index.js`** — untouched. Startup wiring is unchanged; the
  loader runs at `core.js` module-load time, before the server listens.
- **Encryption, STT, SSE event stream, multi-backend registry** — untouched.

---

## 8. Limitations & future extensions

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
  is handled). A file-watcher could be added later. The seeded template
  intentionally documents "restart the backend" in its comments.
- **`thinking` / `yolo` flags** are passed through but ignored by the gateway
  factory (the OpenAI schema has no standard "thinking level"). `prompt()`'s
  `thinking` arg is accepted and discarded, matching hermes.

---

## 9. Risk assessment

- **Zero-config safety is structural (requirement #1).** The loader is purely
  additive with a collision guard, and every failure mode (no file, bad YAML,
  bad entry, collision) collapses to "zero agents added" = today's behavior.
  The zero-config test (§5) pins this as a regression guard.
- **Low risk to built-ins.** The merge is purely additive with a collision
  guard. Built-in providers are never overwritten.
- **Contained blast radius.** All changes are in `core.js` (3 small edits) +
  two new files under `backend/src/providers/`. No existing provider file is
  edited.
- **Graceful degradation.** A malformed config entry is skipped with a logged
  error, not a crash (mirrors `expose/registry.js`'s validation approach).
- **Seeding is safe.** Idempotent, opt-out, and behavior-preserving (commented
  template → zero agents). Worst case it can't write the file (logged, skipped).
- **The generic factory is the only non-trivial code**, and it's a
  parameterized copy of a battle-tested provider (`hermes`), not new logic.

---

## 10. File manifest

| File | Action | Purpose |
|---|---|---|
| `backend/src/providers/gateway.js` | **new** | Generic OpenAI-compatible gateway factory (parameterized hermes) |
| `backend/src/providers/loader.js` | **new** | Template seeder + YAML/JSON config loader + validator |
| `backend/src/routes/core.js` | edit | Merge custom configs into the 3 maps; move `SUPPORTED_PROVIDERS` derivation after the merge; generalize the `refreshModels` static-model branch from name-based to `bin === null` |
| `backend/package.json` | edit | Add `yaml` dependency |
| `scripts/test-custom-agent-loader.mjs` | **new** | Loader tests incl. the zero-config guarantee regression test |
| `scripts/test-gateway-provider.mjs` | **new** | Factory integration test against a mock SSE server |
| `backend/README.md` | edit | Custom Agents section + example |
| `README.md` | edit | Provider table note |
| `docs/architecture.md` | edit | Custom-agent load path note |

**Total:** 4 new files, 5 edits. Zero frontend changes.
