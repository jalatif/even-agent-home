# Custom Agent Support — Implementation Plan

> **Status:** Design / not yet implemented
> **Goal:** Let a user add a custom agent by editing a config file — **no
> backend or frontend code changes** for the common cases, with a clean code
> escape hatch for the hard ones. A user-facing guide is shipped to
> `~/.agent-home/README.md` on first start (see `docs/custom-agents-guide.md`,
> the source for that seeded file).
>
> **Hard requirements (v1):**
> 1. **Zero-config backward compatibility.** If the user configures nothing,
>    every existing built-in agent continues to work byte-for-byte as today. We
>    seed a template config + guide on first startup so the files exist, but
>    this MUST NOT change behavior.
> 2. **Template-driven for the common cases, code escape hatch for the rest.**
>    Three tiers (below) cover everything from a plain OpenAI endpoint up to
>    architecturally-bespoke CLIs.
> 3. **Backend-only change** — the frontend stays untouched (agents are
>    data-driven via `/api/agents` + `/api/models`).
>
> **Scope of v1 — all three tiers:**
> - **Tier 1 — `type: gateway`** (OpenAI-compatible SSE): declarative, no code.
> - **Tier 2 — `type: cli`** (streaming-JSONL CLI, e.g. `pi`/`oh-my-pi` family):
>   declarative, with an event-schema map.
> - **Tier 3 — `type: module`** (bespoke CLIs, e.g. `opencode`/`antigravity`-class):
>   a JS module escape hatch.
>
> **Why three tiers and not one:** a forensic read of all four built-in CLI
> providers shows they split cleanly into "config-amenable" vs "needs code".
> See §1.

---

## 1. Why three tiers (grounded in the current code)

The 8 built-in providers collapse into **three archetypes** by how config-friendly they are:

| Tier | Archetype | Built-ins | Can a declarative template cover it? |
|---|---|---|---|
| **1. Gateway** | OpenAI-compatible HTTP/SSE | `hermes`, `openclaw` | ✅ Fully — uniform `/v1/chat/completions` + SSE deltas. Parameterize 3 constants. |
| **2. Streaming-JSONL CLI** | spawn a CLI per prompt, read JSONL deltas | `pi`, `oh-my-pi` | ✅ Yes, **with an event-schema map**. These two are ~90% duplicate code differing only in `bin`/`args`/field paths. |
| **3. Bespoke CLI** | daemon+poll / mtime-discovery / SQLite / batched | `opencode`, `antigravity` | ❌ **No.** Architecturally bespoke. Needs a code module. |

### Why Tier 3 genuinely needs code (not a richer template)

A declarative template expresses "spawn a binary, read a stream, map field X to
text_delta." Two built-ins violate that model so fundamentally that no field-map
can describe them:

- **`opencode`** is a three-phase orchestration: spawn a long-lived `serve`
  daemon (free-port allocation + password), spawn a per-prompt `run` client that
  only emits a `step_start` event, then **poll a third command** (`opencode
  export`) every 2s and **reconstruct token deltas by diffing accumulated text
  length**. Session listings come from a **SQLite DB** read directly. A config
  schema rich enough to express "spawn a daemon → spawn a client → poll on a
  timer → detect completion via a field → read listings from SQLite" would just
  be reinventing a programming language.
- **`antigravity`** is batched (stdout only at exit — no streaming), **refuses to
  print its own session UUID** (so the provider discovers it by mtime-based
  filesystem forensics), correlates sessions to cwds by **mtime proximity
  (±10s)** against a separate file, and strips proprietary `<USER_REQUEST>`
  markup. None of that is declaratively expressible.

So v1 ships **all three** `type:`s: gateway and cli are declarative, module is
the escape hatch. A user picks the simplest tier that fits; the loader doesn't
care which — all three merge into `providerFactories` the same additive way.

### Feasibility anchors
1. **The frontend is already data-driven.** `/api/agents` and `/api/models` are
   fetched dynamically; `web/src/controller/model.ts` has zero provider-name
   logic. Unknown agents render/function with graceful fallbacks (`models[0]`
   default, end-of-list sort). No frontend change needed for a custom agent.
2. **There is a working registry precedent.** `backend/src/expose/registry.js`
   is a clean drop-in adapter registry validated at module load — this plan
   mirrors that pattern.

---

## 2. Zero-config backward compatibility (requirement #1)

Enforced structurally, not by convention.

### The invariant: built-ins are never touched by the loader
The loader is **purely additive** with a collision guard:
```js
for (const cfg of customConfigs) {
    if (providerFactories[cfg.name]) continue;   // never overwrite (built-in OR duplicate)
    providerFactories[cfg.name] = factoryFor(cfg, emit);   // gateway | cli | module
    CLI_BINS[cfg.name] = cfg.bin ?? null;
    DEFAULT_MODELS[cfg.name] = cfg.models?.length ? cfg.models : (cfg.model ? [cfg.model] : []);
}
```
Every failure mode collapses to "behaves like today":
- **No config file** → `[]` → zero entries added.
- **Unreadable/invalid** → `[]` (errors logged, never thrown).
- **One bad entry** → skipped with a logged error; rest load.
- **Name collides with a built-in** → skipped.

### First-startup seeding (optional, behavior-preserving)
On the **first** load, if no config exists, the loader writes:
1. `~/.agent-home/agents.yaml` — template with **commented-out** example
   entries for all three tiers (parsing yields `[]` → no agents → unchanged
   behavior).
2. `~/.agent-home/README.md` — the user-facing guide (sourced from
   `docs/custom-agents-guide.md` in the repo). This is the file the user opens
   to learn how to fill in the template.

Properties:
- **Idempotent**: `if (!exists)` guard → writes only once; user edits are never clobbered.
- **Opt-out**: `AGENTHOME_AGENTS_NO_SEED=1` skips writing (headless/managed installs).
- **Safe**: the `.agent-home` dir is already used by the project (`stt.js:36`
  uses `~/.agent-home/models`); commented examples → `[]` → zero behavior change.
- The README is static guidance (no executable content) — it can be updated by
  the user or regenerated on demand, but is NOT overwritten once present (same
  idempotent guard) so user notes persist.

### Prove-it test (required)
Seed in a temp home dir → assert merged provider maps contain **exactly** the 8
built-in names and **zero** custom ones. Pins requirement #1 as a regression guard.

---

## 3. The hardcoded chokepoints (all in `backend/src/routes/core.js`)

Line numbers verified against current `main`. A custom agent must get into all
four maps; only the first is substantial.

| # | Chokepoint | Location | Must become |
|---|---|---|---|
| **B1** | `providerFactories` map + 8 imports | `core.js:4-11, 26-35` | A loader that builds a factory per config entry, dispatched by `type` (gateway/cli/module). Three generic factories. |
| **B2** | `CLI_BINS` map | `core.js:67-76` | Read `bin` from config (or `null`). One line per entry. |
| **B3** | `DEFAULT_MODELS` seed | `core.js:87-96` | Read `model`/`models` from config. |
| **B4** | Name-based branch in `refreshModels` | `core.js:214` | Switch on `bin === null`, not provider name. |

No change needed (already dynamic): `SUPPORTED_PROVIDERS` (`core.js:60`, move
after merge), `/api/agents` (`core.js:290`), `getProviderInstance` (`core.js:39-47`),
`startModelRefreshAll` (`core.js:271`), the entire frontend.

Frontend cosmetic-only (no change): `PREFERRED_DEFAULT_MODEL` (`App.tsx:46`),
`PREFERRED_ORDER` (`App.tsx:578`), model-picker suppression (`App.tsx:1074`). A
custom agent gets `models[0]` default and sorts to end of list.

---

## 4. The provider contract (all tiers implement this)

Every factory returns the same ~10-method object (verified across
`hermes/provider.js:295-298`, `pi/provider.js:799-810`, `codex/provider.js:429-441`).

| Method | Signature | Required? |
|---|---|---|
| `prompt` | `async prompt(sessionId, text, cwd, model, thinking, yolo) → {sessionId, provider}` | **Yes** |
| `listSessions` | `listSessions(limit, cwd) → [{id,title,timestamp,cwd,provider,status}]` | **Yes** |
| `getHistory` | `getHistory(sessionId, limit) → [{role, text}]` | **Yes** |
| `getStatus` | `getStatus(sessionId) → {state, provider, error?} \| null` | **Yes** |
| `interrupt` | `interrupt(sessionId) → void` | **Yes** |
| `getSessionStatus` | `getSessionStatus(sessionId) → "busy"\|"idle"` | Optional |
| `getInfo` | `getInfo() → {...}` | Optional |
| `respondPermission` | `respondPermission(sessionId, decision) → void` | No-op stub OK |
| `respondQuestion` | `respondQuestion(sessionId, answer) → void` | No-op stub OK |
| `dispose` | `dispose() → void \| Promise` | Optional |

`emit(sessionId, msg)` vocabulary (fixed): `{type: "user_prompt"|"status"|
"text_delta"|"tool_start"|"tool_end"|"result"|"error", ...}`.

**All three tiers produce this contract.** Tier 1 & 2 generate it from a
template via a generic factory; Tier 3 generates it from the user's JS module.

---

## 5. The three tiers — config schema

**Location resolution** (first match wins): `$AGENTHOME_AGENTS_CONFIG` env var →
`~/.agent-home/agents.yaml` → `~/.agent-home/agents.json`. If none exists, the
loader seeds `agents.yaml` + `README.md` (§2) and reads it back.

### Shared fields (all tiers)

| Field | Required | Default | Notes |
|---|---|---|---|
| `name` | yes | — | Unique id. `^[a-z][a-z0-9-]*$`. Becomes the `provider` value everywhere. |
| `type` | yes | — | `gateway` \| `cli` \| `module`. |
| `model` | yes (gateway/cli) | — | Default model id. |
| `models` | no | `[model]` | Picker list. |
| `bin` | no | `null` | `null` = always available; else `command -v <bin>` gates availability. |

### Tier 1 — `type: gateway` (OpenAI-compatible HTTP/SSE)

| Field | Required | Default | Notes |
|---|---|---|---|
| `gatewayUrl` | yes | — | Base URL; `/v1/chat/completions` is appended. |
| `apiKey` | no | `""` | Static key (`Authorization: Bearer <key>`). Empty = no auth. |
| `apiKeyEnv` | no | — | Env var to read the key from (wins over `apiKey`). |

```yaml
agents:
  - name: ollama-local
    type: gateway
    gatewayUrl: http://127.0.0.1:11434
    model: llama3.1
    models: [llama3.1, qwen2.5, mistral]
    apiKey: ""
```

### Tier 2 — `type: cli` (streaming-JSONL CLI)

For a CLI spawned per-prompt that streams JSONL events. You declare **how to
invoke it** AND **an event-schema map** telling the adapter which JSON fields
mean what (because every CLI names them differently — `pi` uses
`message_update.assistantMessageEvent.delta`; another CLI might use
`{type:"delta", text}`).

| Field | Required | Notes |
|---|---|---|
| `bin` | yes | The command to run (e.g. `pi`). |
| `args` | yes | Arg template with placeholders: `{{text}}`, `{{sessionId}}`, `{{model}}`, `{{thinking}}`, `{{yolo}}`. |
| `events` | yes | The event-schema map (below). |
| `cwdEncoder` | no | `omp-compat` to replicate omp/pi's session-dir naming; else plain. |
| `sessionsDir` | no | Where transcripts live, for listing/history (`~/.pi/agent/sessions`). |
| `env` | no | Extra env vars merged into the subprocess. |

**The `events` map** — the field paths that make Tier 2 declarative:

| Key | Meaning | Example (pi dialect) |
|---|---|---|
| `sessionId` | JSON path to the session id | `session.id` |
| `textDelta.type` | outer event type carrying a token | `message_update` |
| `textDelta.value` | JSON path to the delta string inside that event | `assistantMessageEvent.delta` |
| `textDelta.nestedType` | optional inner `.type` to match (e.g. `text_delta` vs `thinking_delta`) | `assistantMessageEvent.type` |
| `thinkingAsText` | emit thinking deltas as `text_delta` too | `true` |
| `toolStart` / `toolEnd` | event markers for tool boundaries | `{type: tooluse_start}` / `{type: message_end, role: toolResult}` |
| `resultMarkers` | event types that signal completion | `[turn_end, agent_end]` |

```yaml
agents:
  - name: my-pi-clone
    type: cli
    bin: pi
    args: ["-p", "--mode", "json", "--provider", "litellm", "{{text}}"]
    sessionFlag: ["--session", "{{sessionId}}"]
    sessionsDir: "~/.pi/agent/sessions"
    cwdEncoder: omp-compat
    events:
      sessionId: "session.id"
      textDelta: { type: "message_update", nestedType: "assistantMessageEvent.type", value: "assistantMessageEvent.delta" }
      thinkingAsText: true
      resultMarkers: [turn_end, agent_end]
    model: llama3.1
```

### Tier 3 — `type: module` (bespoke code escape hatch)

For CLIs that can't be templated (daemon+poll, mtime discovery, SQLite,
batched output, custom markup). A JS module implements the §4 contract.

| Field | Required | Notes |
|---|---|---|
| `module` | yes | Absolute path or package name. Loaded via dynamic `import()`. |
| `options` | no | Arbitrary object passed as the 2nd arg to the factory. |

```yaml
agents:
  - name: my-weird-agent
    type: module
    module: /home/me/my-agent-provider.js
    options: { bin: mycli, pollMs: 2000 }
```

The module:
```js
// /home/me/my-agent-provider.js
export function createProvider(emit, options) {
  return { prompt, listSessions, getHistory, getStatus, interrupt,
           respondPermission() {}, respondQuestion() {}, dispose() {} }
}
```
(See `docs/custom-agents-guide.md` §Tier 3 for a complete worked example,
including the prompt you can paste into an AI coding agent to generate the
module for your CLI.)

### Validation rules (all tiers, at startup)
- `name` unique across the file AND not colliding with a built-in.
- `name` matches `^[a-z][a-z0-9-]*$`.
- `type` ∈ {`gateway`, `cli`, `module`}.
- Tier-specific requirements (`gatewayUrl`; `bin`+`args`+`events`; `module`).
- On failure: log a clear error, **skip that entry** (don't crash), continue.

---

## 6. Implementation steps (backend-only)

### Step 1 — Three generic factories
**New files:**
- `backend/src/providers/gateway.js` — parameterized `createHermesProvider`
  (reads `config.gatewayUrl/model/apiKey`). Near-copy of `hermes/provider.js:8-300`.
- `backend/src/providers/cli.js` — the new generic JSONL-CLI adapter. Spawns
  `config.bin` with templated `config.args`, line-buffers stdout, parses each
  line as JSON, and uses `config.events` to emit `text_delta`/`result`/etc. This
  is the generalization of `pi/provider.js`'s streaming loop; the bespoke pi bits
  (process-group kill, fork-prompt suppression, alias normalization) become
  config-driven toggles OR are documented as "module-tier if you need them."
- `backend/src/providers/module.js` — `createModuleProvider(config, emit)`:
  `await import(pathToFileURL(config.module))` → call `mod.createProvider(emit,
  config.options)`. Validates the returned object has the required methods.

### Step 2 — Config loader + seeder (incl. the guide)
**New file:** `backend/src/providers/loader.js`
- `seedIfNeeded()`: writes `~/.agent-home/agents.yaml` (commented examples) +
  `~/.agent-home/README.md` (the guide — content from
  `docs/custom-agents-guide.md`, bundled at build time or read from a known
  path). Idempotent + opt-out.
- `loadCustomAgentConfigs()`: resolve file → parse YAML/JSON → validate each
  entry → return resolved configs. Fail-soft to `[]`.

**README bundling:** the guide text is maintained in
`docs/custom-agents-guide.md` (a first-class repo doc, reviewed/edited in place).
At seed time the loader reads it from a path resolved relative to the backend
root (`path.resolve(__dirname, "../../docs/custom-agents-guide.md")` in src, or a
copy baked next to the build output). If the source guide isn't found at seed
time (e.g. installed without the docs/ dir), the loader writes a minimal inline
fallback README so the feature still degrades gracefully.

### Step 3 — Wire into `core.js`
**Edit:** `backend/src/routes/core.js` — after the hardcoded maps (~line 96):
```js
import { loadCustomAgentConfigs } from "../providers/loader.js";
const customConfigs = loadCustomAgentConfigs();
for (const cfg of customConfigs) {
    if (providerFactories[cfg.name]) continue;
    providerFactories[cfg.name] = factoryForType(cfg, emit);   // gateway | cli | module
    CLI_BINS[cfg.name] = cfg.bin ?? null;
    DEFAULT_MODELS[cfg.name] = cfg.models?.length ? cfg.models : (cfg.model ? [cfg.model] : []);
}
// move `const SUPPORTED_PROVIDERS = Object.keys(providerFactories)` to after the loop
```
`factoryForType(cfg, emit)` dispatches: `gateway` → `createGatewayProvider`,
`cli` → `createCliProvider`, `module` → `createModuleProvider`.

**Sequencing (verified):** `core.js` is imported by `index.js:4`, so the loader
runs at module-load — before `startModelRefreshAll()` (`index.js:104`). No
`index.js` change needed.

### Step 4 — Generalize `refreshModels`
**Edit:** `core.js:214` — `if (bin === null || provider === "hermes" || provider === "openclaw")`
→ `if (bin === null)`. Covers all custom entries with `bin: null` (gateway always;
cli/module often). No behavior change for built-ins.

### Step 5 — Tests
**New files:**
- `scripts/test-custom-agent-loader.mjs` — **[zero-config]** seeding → exactly 8
  built-ins, 0 custom; **[no-seed]** `AGENTHOME_AGENTS_NO_SEED=1`; **[idempotent]**
  seeding twice doesn't clobber; valid/missing/bad-YAML/collision/regex-skip;
  `events` resolution for Tier 2; `module` path resolution for Tier 3.
- `scripts/test-gateway-provider.mjs` — Tier 1 vs a mock OpenAI SSE server.
- `scripts/test-cli-provider.mjs` — Tier 2 vs a tiny mock JSONL-streaming CLI
  (a node script that emits `{type:"session",id}` then `{type:"message_update",
  assistantMessageEvent:{type:"text_delta",delta:"hi"}}` then `{type:"turn_end"}`),
  asserting the adapter emits the right `text_delta`/`result`.
- `scripts/test-module-provider.mjs` — Tier 3: a fixture `.js` module exporting
  `createProvider`, asserting `import()` + dispatch works.

Run via `npm test --prefix backend`.

### Step 6 — Docs
- Seed the user-facing guide → `~/.agent-home/README.md` (source:
  `docs/custom-agents-guide.md`).
- Add a "Custom Agents" section to `backend/README.md`; provider-table note in
  root `README.md`; `docs/architecture.md` note on the load path.

---

## 7. What does NOT change
- **Frontend** — zero edits. Custom agents appear via `/api/agents` and work through the existing data-driven UI.
- **Built-in providers** — untouched. Loader is purely additive; collisions skipped; failures fail-soft to `[]`.
- **`backend/src/index.js`** — untouched. Loader runs at `core.js` module-load.
- **Encryption, STT, SSE event stream, multi-backend registry** — untouched.

---

## 8. Limitations & future extensions
- **Tier 2 covers the pi/oh-my-pi family**, not opencode/antigravity. Those
  architectural patterns (daemon+poll, mtime forensics, SQLite, batched) are
  Tier 3 (module) by design — forcing them into a template would leak badly.
- **No persistent session history for Tier 1 (v1).** In-memory only; matches
  `hermes`. Tier 2 can declare `sessionsDir` for transcript-based listing/history
  (like pi). Tier 3 does whatever the module implements.
- **No hot-reload (v1).** Config read once at startup; restart to apply. The
  seeded guide says so explicitly.
- **`thinking`/`yolo`** are passed through; Tier 1 ignores them (no OpenAI
  standard). Tier 2 may declare `thinkingFlag`/`yoloFlag` templates. Tier 3 does
  whatever the module wants.

---

## 9. Risk assessment
- **Zero-config safety is structural.** Additive + collision guard + fail-soft;
  zero-config test pins it.
- **Contained blast radius.** `core.js` (3 small edits) + 4 new files under
  `backend/src/providers/`. No existing provider file edited.
- **Graceful degradation.** Bad entry → logged + skipped (mirrors
  `expose/registry.js`).
- **Seeding is safe.** Idempotent, opt-out, behavior-preserving. README is static
  guidance, never overwritten after first write.
- **Generic factories are parameterized copies** of battle-tested providers
  (hermes for Tier 1, pi for Tier 2), not new logic.

---

## 10. File manifest

| File | Action | Purpose |
|---|---|---|
| `backend/src/providers/gateway.js` | **new** | Tier 1: OpenAI-compatible gateway factory (parameterized hermes) |
| `backend/src/providers/cli.js` | **new** | Tier 2: streaming-JSONL CLI factory driven by an `events` map |
| `backend/src/providers/module.js` | **new** | Tier 3: dynamic-import escape hatch for bespoke providers |
| `backend/src/providers/loader.js` | **new** | Template+guide seeder, YAML/JSON loader, validator |
| `backend/src/routes/core.js` | edit | Merge configs into the 3 maps; move `SUPPORTED_PROVIDERS` after merge; generalize `refreshModels` branch |
| `backend/package.json` | edit | Add `yaml` dependency |
| `scripts/test-custom-agent-loader.mjs` | **new** | Loader tests incl. zero-config regression |
| `scripts/test-gateway-provider.mjs` | **new** | Tier 1 vs mock SSE server |
| `scripts/test-cli-provider.mjs` | **new** | Tier 2 vs mock JSONL CLI |
| `scripts/test-module-provider.mjs` | **new** | Tier 3 module dispatch |
| `docs/custom-agents-guide.md` | **new** | User-facing guide (seeded to `~/.agent-home/README.md`) |
| `backend/README.md` | edit | Custom Agents section + example |
| `README.md` | edit | Provider table note |
| `docs/architecture.md` | edit | Custom-agent load path note |

**Total:** 8 new files, 5 edits. Zero frontend changes.
