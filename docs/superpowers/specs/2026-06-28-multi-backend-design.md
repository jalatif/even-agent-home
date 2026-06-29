# Multi-Backend Support — Design Spec

- **Date:** 2026-06-28
- **Branch:** `feat/multi-backend`
- **Worktree:** `/Users/jalatif-mac-mini/Work/even-agent-home-multi`
- **Status:** Approved design (pending spec review → implementation plan)

## 1. Goal

Let a user connect to **multiple backend endpoints**, each defined by a `url:port` + `token` + a user-chosen **name**. All agent configuration and app-level settings are stored **per backend**. The user selects a backend by name; that backend's connection + agent config + app prefs become active and persist in local storage (the Even Hub bridge KV, with `localStorage` as a dev fallback) — exactly as today, but per backend. The user can edit or remove backends. The last-connected backend is remembered and auto-connected on startup.

## 2. Non-goals (explicit)

- **No change to the glasses/main UI behavior.** The main page and glasses view render whatever the active backend returns. They keep reading `getApi()` / `getApiConfig()` exactly as today.
- **No change to the backend server.** Multi-backend is a client-side (web) concept: the app may be pointed at several backend instances and switch between them.
- **No cross-backend session sharing.** Sessions live on the backend server; switching backend means switching which server's sessions are shown.
- **No QR/camera scanning** (Even Hub plugin WebViews don't expose the phone camera — unchanged from today). Input is via URL/token fields + paste.

## 3. Constraints & risk

This codebase has shipped several startup/storage bugs (all documented in `web/src/api.ts` comments and `docs/PROJECT_LEARNINGS.md`). The four load-bearing invariants that fixed them **must** be preserved:

1. **Boot-after-hydration ordering:** `ctrl.boot()` (which reads `getApiConfig()` → active config) must run **after** the post-bridge force-hydration completes, not concurrently. Otherwise boot sees empty pre-bridge defaults and the app shows "configure backend" even though settings are persisted.
2. **Refresh-nonce gate:** the settings agents/models refresh (dep `agentRefreshNonce`) must only bump its nonce once the active backend is usable (`isBackendConfigured`), else `getAgents()` fails silently and the settings list stays empty until Save.
3. **Bound bridge methods:** the Even Hub SDK storage methods (`getLocalStorage`/`setLocalStorage`) must be called **on the bridge instance** (or `.bind(this)`-ed). Hoisting them off the instance detaches `this` and every read/write silently falls back to `window.localStorage`, which the phone WebView clears on relaunch.
4. **Force-rehydrate after bridge ready:** the second `hydrate...(true)` call must re-read from the bridge KV store even though the pre-bridge read already set the "hydrated" flag — without `force`, the real persisted settings never load and the app loses the connection on reopen.

These invariants are the reason the chosen approach (§5) keeps the `getApi()` / `getApiConfig()` / `getAgentConfigs()` interfaces byte-identical and only swaps the storage substrate.

## 4. Decisions (from brainstorm)

| Decision | Choice |
|---|---|
| Settings scope per backend | **All per-backend** — connection, agent config, AND app prefs (yolo, debug, auto-scroll, scroll speed). Switching backend restores that backend's full preference set. |
| Upgrade migration | **Auto-import** existing single-backend `apiConfig`+`agentConfigs` into one named backend; set active; leave legacy keys in place but never read again. Zero-friction. |
| Connect input | **Both** — a single connection field accepts a full `http://host:port?token=...` URL (auto-splits, reusing `parseConnectionUrl`) **or** plain `host:port`, plus a separate Token field. |
| Storage shape | **One `backends` registry** (single KV key) holding the whole graph. Atomic read/write; matches "as-is but per backend." |
| Backend switching | **Switch = immediate connect.** Selecting a backend in the list activates it and re-boots the controller onto it. |
| Delete behavior | **Confirm + remove.** If it was active → fall back to the most-recent-other backend → first remaining → empty "connect a backend" state if none left. |

## 5. Approach: Registry adapter (chosen)

`api.ts`'s public interface (`getApi`, `getApiConfig`, `getAgentConfigs`, `setApiConfig`, `saveAgentConfigs`, `hydrateApiConfig`, `hydrateAgentConfigs`) is **unchanged**. Internally, the in-memory cache (`currentConfig` / `currentAgentConfigs`) becomes a *view* of the **active backend** inside a new registry. The controller, glasses/main UI, and the existing App.tsx effects keep calling the same functions and therefore keep all four startup/storage invariants intact by construction.

Rejected alternatives:
- **Per-backend `AgentHomeApi` instances on the controller** — forces controller edits everywhere (`getApi()` → `this.api`), more plumbing, higher regression surface.
- **Mirror registry into legacy `apiConfig`/`agentConfigs` keys on switch** — the double-write (registry + legacy) is precisely the partial-failure pattern behind "settings not stored." Also contradicts the "abandon legacy keys" migration decision.

## 6. Data model & storage

### 6.1 Types (`web/src/backends.ts`, new file)

```ts
export interface BackendPrefs {
  yolo?: boolean
  debugView?: boolean
  autoScrollLastExchange?: boolean
  scrollSpeed?: 'slow' | 'medium' | 'fast'
}

export interface Backend {
  id: string                 // stable uuid; never user-editable, never shown raw
  name: string               // user-chosen, editable, shown in UI
  baseUrl: string            // http://host:port
  token: string
  prefs: BackendPrefs
  agentConfigs: Record<string, AgentProviderConfig>  // per-backend
}

export interface BackendRegistry {
  version: 1
  backends: Backend[]
  activeBackendId: string | null  // "last connected"; what we boot onto
  recentBackendIds: string[]      // activation order, most-recent first; drives removeBackend fallback
}
```

`AgentProviderConfig` is imported from `api.ts` (unchanged: `{ enabled, model, thinking? }`).

### 6.2 KV key & persistence

- **Single KV key:** `backends` (JSON `BackendRegistry`), via the existing `storageGet`/`storageSet`/`resolveStorage` in `storage.ts`.
- The legacy keys `apiConfig` and `agentConfigs` are **read only once**, during migration (§6.4), then never touched again by production code. They are intentionally left in storage (harmless) to avoid an extra write and to keep a rollback path.

### 6.3 In-memory cache & hydration discipline (mirrors today's `api.ts`)

```ts
let currentRegistry: BackendRegistry = { version: 1, backends: [], activeBackendId: null, recentBackendIds: [] }
let registryHydrated = false
```

`hydrateBackends(force = false)` follows the **exact** discipline that fixed the existing bugs:

1. If `registryHydrated && !force` → return cache (cheap, the hot-path behavior `getApiConfig()` relies on for sync reads).
2. Else read `storageGet('backends')`; if absent, run **migration** (§6.4) to seed the registry from legacy keys; if no legacy keys, seed an empty registry.
3. Set `registryHydrated = true`; return the cache.

`backends.ts` exports `__resetBackendsStateForTests()` mirroring `api.ts`'s `__resetApiStateForTests()`.

### 6.4 Migration (auto-import, run inside `hydrateBackends` when `backends` key absent)

```
if storageGet('backends') is null:
    legacyCfg  = storageGet('apiConfig')    // may be null
    legacyAgs  = storageGet('agentConfigs') // may be null
    if legacyCfg has a usable baseUrl+token:
        name = host:port derived from legacyCfg.baseUrl   // e.g. "192.168.1.5:8765"
        if name empty/invalid -> name = "Default"
        backend = {
          id: uuid(),
          name,
          baseUrl: legacyCfg.baseUrl,
          token:  legacyCfg.token,
          prefs:  { yolo, debugView, autoScrollLastExchange, scrollSpeed } from legacyCfg,
          agentConfigs: legacyAgs ?? {},
        }
        registry = { version:1, backends:[backend], activeBackendId: backend.id, recentBackendIds:[backend.id] }
    else:
        registry = { version:1, backends:[], activeBackendId: null, recentBackendIds:[] }
    storageSet('backends', JSON.stringify(registry))
```

- **Idempotent:** once `backends` exists, migration never runs again.
- **No legacy writes:** migration only *reads* legacy keys; it never deletes them.
- Layering of URL deep-link params (`?token=`, `?baseUrl=`) is **preserved** at the active-view level (§7.3), not at migration time, so a deep link still refreshes credentials without wiping prefs.

### 6.5 Registry operations (all atomic: mutate cache → persist)

- `getRegistry(): BackendRegistry` — sync read of cache; kicks off async hydrate if not yet hydrated (same lazy pattern as `getApiConfig`).
- `getActiveBackend(): Backend | null`.
- `setActiveBackend(id): Promise<void>` — set `activeBackendId`, call `refreshActiveView()` (§7.1), persist. Atomic in one step.
- `upsertBackend(backend): Promise<Backend>` — insert or update by `id` (regenerates id for new). Returns the stored backend (with id).
- `removeBackend(id): Promise<{ activeChanged: boolean; fallbackId: string | null }>` — remove; if it was active, pick fallback (most-recently-active other backend via a small `recentBackendIds` history, else first remaining, else null) and set active; persist. Returns whether the active backend changed and the new active id.
- `saveBackend(id, patch): Promise<void>` — merge a partial patch (name/baseUrl/token/prefs/agentConfigs) into a backend; persist.
- `getBackendsList(): Backend[]` — ordered list for the UI (active first, then by recency/name).

A short **recency history** `recentBackendIds: string[]` (kept inside the registry object, persisted) records the order backends were activated so `removeBackend`'s fallback is "last used other," not arbitrary.

## 7. `api.ts` becomes the active-view adapter

The public surface stays identical; internals swap source from singleton config → active backend.

### 7.1 Active view

```ts
let currentConfig: AuthConfig = { /* defaults as today */ }
let currentAgentConfigs: Record<string, AgentProviderConfig> = {}
```

`refreshActiveView()` rebuilds these from `getActiveBackend()`:

```
backend = getActiveBackend()
if backend:
    currentConfig = {
      baseUrl: backend.baseUrl,
      token: backend.token,
      yolo: backend.prefs.yolo,
      debugView: backend.prefs.debugView,
      autoScrollLastExchange: backend.prefs.autoScrollLastExchange,
      scrollSpeed: backend.prefs.scrollSpeed,
    }
    currentAgentConfigs = backend.agentConfigs
else:
    currentConfig = { baseUrl:'', token:'', ...defaults }
    currentAgentConfigs = {}
```

- `hydrateApiConfig(force)`  ⇒ `await hydrateBackends(force)`; `refreshActiveView()`; **then** layer URL deep-link params on top (preserving the documented 1/2/3 priority: defaults < persisted active backend < URL params); return `currentConfig`.
- `hydrateAgentConfigs(force)` ⇒ same hydrate; return `currentAgentConfigs`.
- `getApiConfig()` ⇒ if not hydrated, kick off async hydrate (lazy, same as today); return `currentConfig`.
- `getAgentConfigs()` / `getApi()` ⇒ unchanged.
- `setApiConfig(config)` ⇒ if an active backend exists, write `baseUrl/token/prefs` into it via `saveBackend(activeId, {...})`. If **no** active backend exists (e.g., the very first Save before any Connect, or after removing the last backend), it updates only the in-memory `currentConfig` cache and does **not** persist (there is nothing to persist to) — matching today's behavior where an unconfigured app's edits live only until a backend exists. In both cases the in-memory `currentConfig` is updated synchronously first so hot-path reads stay consistent while the bridge write is in flight (same comment/intent as today).
- `saveAgentConfigs(configs)` ⇒ `saveBackend(activeId, { agentConfigs: configs })`.

### 7.2 `AuthConfig` shape

`AuthConfig` stays exactly as today (so App.tsx's `setConfig({...config, baseUrl})` etc. keep compiling). It is now simply the active backend's flattened view.

### 7.3 Deep-link layering (unchanged behavior)

`configFromLocation()` and the `?token=` / `?baseUrl=` overlay logic in `hydrateApiConfig` are kept verbatim. They now layer **on top of the active backend's** persisted fields rather than the legacy singleton. A `?token=` refresh therefore updates the live view and, on the next `setApiConfig`, writes the refreshed token back into the active backend.

## 8. UI design (polished, minimal main-UI change)

Main/glasses UI: **unchanged** (still reads active-backend data via the same calls).

Settings page gains a **Backends** section at the top, above the existing cards.

### 8.1 Backends list (in Settings)

```
┌─ Backends ────────────────────────────────────────────────┐
│  ● Work Laptop    192.168.1.5:8765      [active]  Edit ⋯  │
│  ○ Pi Cluster     10.0.0.4:8766                   Edit ⋯  │
│  ○ Codex Box      192.168.1.20:8765              Edit ⋯  │
│                                                            │
│              [ + Connect New Backend ]                     │
└────────────────────────────────────────────────────────────┘
```

- Active row: filled dot `●` + `[active]` chip; inactive rows: hollow dot `○`.
- **Click a non-active row → immediate switch:** `setActiveBackend(id)` → `controller.boot()` → agents/models/prefs reload for that backend. No confirm step.
- **`⋯` menu per row:** `Edit…` and `Remove…`.
- **Remove…** → confirm dialog; on confirm `removeBackend(id)`; if active changed, controller re-boots onto the fallback (or empty state).
- **`+ Connect New Backend`** opens the Connect modal (§8.2).

Below this section, the existing **Agent Configuration** card and the **app preferences** card (auto-scroll, scroll speed, yolo, debug) remain, but now read/write the **active** backend's slice. **Save Settings** persists in-flight pref edits for the active backend and re-boots.

**Replacement, not addition:** the **existing** "Backend Configuration" card (the standalone *Backend URL* + *Secure Token* input fields at the top of today's Settings) is **replaced** by the Backends section + Connect/Edit modal. Those two fields are removed from the main Settings body so connection config lives only in one place (the modal). The *Backend Setup Instructions* `<details>` block (install/start commands) is kept as-is, directly under the Backends section.

### 8.2 Connect / Edit modal (separate overlay frame)

A centered modal with a backdrop, for focus and polish:

```
┌─────────────── Connect Backend ────────────────┐
│  Name        [ Work Laptop                   ] │
│  Connection  [ http://192.168.1.5:8765?token=abc ]
│              (paste full ?token= URL or host:port) │
│  Token       [ *************************** ]   │
│                                                │
│   [ Test ]      [ Cancel ]      [ Connect ]    │
└────────────────────────────────────────────────┘
```

- **Connection field** accepts either:
  - a full `http://host:port?token=...` URL → auto-split into `baseUrl`+`token` via the existing `parseConnectionUrl` (reused as-is), or
  - a plain `host[:port]` (no scheme) → normalized to `http://host:port` for `baseUrl`; token entered in the Token field.
  - A paste handler (reuse `handleBaseUrlPaste`'s logic) auto-fills the Token field when a full URL is pasted.
  - **Helper note:** `parseConnectionUrl` (in `App.tsx` today) requires a token in the URL and returns null otherwise. The new pure helper `normalizeConnectionInput` (§11.1) **wraps** it: it first tries `parseConnectionUrl`; if that returns null and the input parses as a bare host (with optional `:port`), it returns `{ baseUrl: 'http://'+host, token: '' }`. So `parseConnectionUrl` is reused, not duplicated, and `normalizeConnectionInput` only adds the bare-host branch.
- **Test** — lightweight ping: instantiates `AgentHomeApi` with the staged `{baseUrl,token}` and calls `getAgents()`; shows ✓ reachable / ✗ error inline. Does not persist.
- **Connect** — validates name + baseUrl + token non-empty; `upsertBackend(...)` → `setActiveBackend(newId)` → close modal → `controller.boot()`.
- **Edit** reuses the same modal, prefilled with the backend's current values; Connect becomes **Save** (writes via `saveBackend`, no active switch unless it is the active backend, in which case re-boot to apply).
- Empty state: if the registry has no backends, Settings shows a prominent **"No backends connected — Connect your first backend"** CTA that opens the same modal.

### 8.3 Styling

Reuse the existing dark theme variables (`--text-main`, `--text-muted`, `--border-light`, card/`.config-card` classes). The modal uses a fixed overlay + centered card with the same palette; new CSS scoped under `.backends-list`, `.backend-row`, `.backend-modal`, `.backend-modal-backdrop` in `style.css`.

## 9. Startup flow ("remember last connected")

`activeBackendId` **is** the last-connected backend. Startup in `App.tsx`:

1. Pre-bridge effect: `hydrateApiConfig()` + `hydrateAgentConfigs()` (these now hydrate the registry first), `setConfig`/`setAgentConfigs` from result.
2. Bridge ready: `registerBridgeStorage(...)` (unchanged bound-methods contract) → `hydrateApiConfig(true)` + `hydrateAgentConfigs(true)` (force re-reads registry from bridge KV) → set state → `(ctrl as any).bridge = bridge` → `setController(ctrl)` → `ctrl.subscribe(...)` → **`ctrl.boot()`** (reads active backend's config) → if `isBackendConfigured(hydratedConfig)` bump `agentRefreshNonce`.
3. If `activeBackendId` points at a configured backend → boot onto it automatically (satisfies "remember last connected and connect on startup").
4. If registry empty → glasses show the "please configure" empty state; Settings opens to the Backends empty CTA.

This preserves invariants §3.1, §3.2, §3.4 byte-for-byte (same call ordering, same force re-hydrate, same nonce gate now re-sourced through `isBackendConfigured` of the active view).

## 10. Switch atomicity (the one new risk)

When switching backend, `activeBackendId` must flip **before** the active view propagates, so App's auto-persist effect (`setApiConfig(config)` on `config` change) writes the *new* view to the *new* active backend, never the old view onto the new one. `setActiveBackend` is atomic (set active → `refreshActiveView()` → persist in one synchronous-to-cache step). A switch itself produces no net write (the view written back equals what was just read), but we still unit-test the ordering to be safe (§11).

## 11. Testing plan (detailed)

Follows the repo's established **pure-helpers-extracted** pattern (like `configHelpers.ts`) so logic is unit-testable without React (the repo has no React testing infra). All unit tests are `node:test` + `node:assert/strict`, runnable via `npm run test:unit` (web).

### 11.1 New pure helpers → new tests

Extract decision/parsing logic from UI into pure functions in `backends.ts` and test them directly:

| Function (pure) | Tests |
|---|---|
| `migrateLegacy(legacyCfg, legacyAgs): BackendRegistry` | (a) usable legacy → one backend, name = host:port, prefs+agentConfigs carried, active set; (b) unusable legacy (missing token) → empty registry, active null; (c) no legacy → empty registry; (d) idempotent shape (stable fields). |
| `nameFromBaseUrl(url): string` | host:port extraction; empty/weird input → `"Default"`. |
| `normalizeConnectionInput(raw): { baseUrl, token } \| null` | full `?token=` URL → split; plain `host:port` → `http://host:port`, token `''`; garbage → null. |
| `pickFallbackBackend(registry, removedId): string \| null` | active removed → most-recent-other; non-active removed → active unchanged; last backend removed → null. |
| `applyDeepLink(saved, location): AuthConfig` | `?token=` refreshes token only; `?baseUrl=` overrides; empty search → unchanged; mirrors existing `hydrateApiConfig` layering tests. |

### 11.2 Registry lifecycle tests (`test/backends.test.ts`, new)

Mirror the structure of `test/storage.test.ts`. Each test installs a fresh in-memory `window.localStorage` shim and clears any registered bridge.

1. **`hydrateBackends` returns empty registry when nothing persisted and no legacy.**
2. **Migration auto-imports legacy `apiConfig`+`agentConfigs`** into one named backend, set active; legacy keys still present; re-hydrate does not re-migrate (idempotent).
3. **`force=true` re-reads registry after initial hydrate** (mirrors the "re-open app lost connection" regression test): first hydrate empty, then populate `backends` in the store, `force` re-hydrate returns it; non-force returns cache.
4. **Bridge-backed registry takes priority over `localStorage`** and must NOT touch `localStorage` (the phone WebView clear-on-relaunch regression).
5. **`setActiveBackend` is atomic:** flips `activeBackendId`, propagates to active view, persists — in one step; `getActiveBackend()` immediately reflects it; the active view's `baseUrl`/`token` match.
6. **Switch atomicity (§10):** after `setActiveBackend(B)` while the App auto-persist effect "writes back" the now-current view, the write lands on backend B (verified by reading B's stored fields), never on the previously-active A.
7. **`upsertBackend`** inserts new (generates id) and updates existing (preserves id).
8. **`removeBackend` fallback chain:** active removed → fallback = most-recent-other (uses recency history); updates `activeBackendId`; last backend removed → `activeBackendId` null, `getBackendsList()` empty.
9. **`saveBackend` partial patch** merges prefs/agentConfigs without clobbering untouched fields.
10. **Recency history** records activation order; used by `removeBackend` fallback.

### 11.3 Adapter tests (extend `test/storage.test.ts` or `test/api-adapter.test.ts`)

Verify `api.ts` still behaves as before, now sourced from the registry:

1. `setApiConfig` writes into the **active** backend's `baseUrl/token/prefs`, not a global singleton.
2. `saveAgentConfigs` writes into the active backend's `agentConfigs`.
3. `getApiConfig()` reflects the active backend after a switch.
4. **Regression guard:** the existing `hydrateApiConfig` layering + migration tests still pass (interface unchanged). If kept in `storage.test.ts`, they must continue green; new registry-sourced assertions are added alongside.
5. `__resetApiStateForTests` + `__resetBackendsStateForTests` restore a clean slate.

### 11.4 Unchanged-interface regression guards

- `test/configHelpers.test.ts`: `isBackendConfigured` unchanged → still green (it now just runs against the active view's `{baseUrl,token}`, same predicate).
- `test/controller.test.ts`: `boot()` no-fetch-before-config, doublePress exit, etc. → still green, because the controller's calls to `getApiConfig`/`getApi` are unchanged. The "no fetch before config" test is the key guard that the boot-after-hydration ordering survives.

### 11.5 E2E / simulator validation

Per `PROJECT_LEARNINGS §2`:

1. **`npm run test:unit`** (web) — all unit tests green, including the new `test/backends.test.ts`.
2. **`npm run test:simulator`** (`scripts/fuzzy-test.mjs`) — default 100 iterations, 0 failures. The fuzzy harness exercises UI transitions; since glasses/main UI is unchanged, golden transitions must still pass. Any new structural invariant (e.g., "settings shows the active backend name in the header") is added to `checkStructuralInvariants`.
3. **Manual happy-path checklist** (documented in `docs/TESTING_PLAN.md`):
   - Fresh install (no keys): empty state → connect a backend → agents load → send a message.
   - Upgrade from existing single-backend install: existing config appears as one named backend, auto-selected, agents load with no Save click.
   - Connect a 2nd backend via URL paste (auto-split) → switch to it → its agents load.
   - Edit a backend's token → Save → messages still work.
   - Remove the active backend → app falls back to the other backend and re-boots.
   - Remove the last backend → empty state.
   - Restart the app → last-connected backend auto-connects.

### 11.6 New invariant: refresh-nonce gate under multi-backend

Add a test mirroring the original "settings UI empty until Save" fix: after a backend switch with a *configured* backend, the refresh nonce bumps (settings list populates); after switching to an *unconfigured* state (empty registry), it does **not** bump (no silent-failing refresh).

## 12. Files changed

**New:**
- `web/src/backends.ts` — registry types, hydration, ops, migration, pure helpers.
- `web/test/backends.test.ts` — registry lifecycle + pure-helper tests (§11.1, §11.2).

Decision on adapter tests (§11.3): **extend `test/storage.test.ts`** rather than add a separate `api-adapter.test.ts`. The existing `storage.test.ts` already covers `hydrateApiConfig` layering + `force` semantics; the registry-sourced assertions are the same behaviors re-sourced, so co-locating them keeps one file for "the api/storage contract" and avoids duplicating the `installWindow`/`clearBridge` harness.

**Modified:**
- `web/src/api.ts` — internals become active-view adapter; public interface unchanged.
- `web/src/App.tsx` — add Backends section + Connect/Edit modal + switch/remove handlers; keep existing effects/ ordering.
- `web/src/style.css` — `.backends-list`, `.backend-row`, `.backend-modal*` styles.
- `web/src/configHelpers.ts` — unchanged (active-view predicate already works); possibly add `isBackendConfigured` reuse doc.

**Docs (per `PROJECT_LEARNINGS §1`, all updated together):**
- `docs/architecture.md` — §Pairing/Boot: multi-backend registry; active backend = last connected.
- `docs/execution_prd.md` — multi-backend feature scope.
- `docs/TESTING_PLAN.md` — §11 testing plan + manual checklist.
- `docs/testing_harness.md` — note new `test/backends.test.ts` in unit suite.
- `docs/ui_invariants.md` — Backends section + active-backend chip invariant.
- `web/README.md` — multi-backend connect/switch/edit/remove usage.

## 13. Rollout / ordering of implementation

1. `backends.ts` + pure helpers + migration (with `test/backends.test.ts`).
2. `api.ts` adapter swap (keep `test/storage.test.ts` + `test/configHelpers.test.ts` green).
3. `App.tsx` Backends section + modal + handlers.
4. `style.css` polish.
5. Docs sweep (§12).
6. `npm run test:unit` + `npm run test:simulator` green.

## 14. Open questions

None blocking. All brainstorm decisions are captured in §4.
