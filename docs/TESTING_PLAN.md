# Testing Plan: Even Agent Home

## 1. Objective
To ensure complete correctness, stability, and UI responsiveness of the Agent Home application across the Even Hub architecture. This testing plan aims to establish absolute confidence in the implementation by deploying automated validation mechanisms mirroring the comprehensive tests found in the `even-telegram` reference app.

## 2. Testing Layers

### A. Deterministic Flow Testing (`simulator-flow.mjs`)
The existing flow test needs to be expanded to validate:
- **Corner Cases in Session Management:** Ensure new session generation vs resuming existing sessions route properly.
- **Micro-Interactions:** Validate specific scroll incrementation, list wraparounds, and boundary limits.
- **Provider Switching:** Verify that switching between agents (e.g., Claude to Codex) loads the correct localized sessions correctly.

### B. Fuzzy Testing (`fuzzy-test.mjs`)
We will introduce an automated fuzzer that injects continuous streams of native inputs (`swipeUp`, `swipeDown`, `press`, `doublePress`) to validate:
- **State Machine Invariants:** Every UI transition must map to a permitted directed edge.
- **App Crash Resilience:** Ensure that unbounded scrolling, rapid double-clicks, or out-of-order microphone events do not crash the VM.
- **Rendering Correctness:** Verify `evenBridge.ts` container upgrades correctly parse truncated texts and boundaries regardless of chaotic input.

### C. Performance & Latency Assertions
Both test harnesses will track and assert against strict performance budgets for production readiness:
- **Input Dispatch:** < 50ms
- **State Transition Calculation:** < 10ms
- **Native Render Payload Construction:** < 50ms
- **Backend Fetch Times:** < 300ms for routine session/model lookups.

### D. Provider Lifecycle Regression Testing
Provider integrations need targeted backend tests in addition to simulator
navigation:
- `scripts/test-polling-controller.mjs` validates real `/api/prompt` ->
  `/api/status` + `/api/history` polling behavior and guards the "idle before
  history caught up" race from becoming a false `Agent Error`.
- `scripts/test-provider-contracts.mjs` validates prompt/session/status/history
  contracts across providers when local credentials and binaries are available.
- `scripts/test_models_harness.js` validates static model fallbacks against the
  recorded source-of-truth model dump.
- For `pi`, add or run a focused spawn-argument probe when changing model
  selection; unqualified saved aliases must resolve through
  `~/.pi/agent/models.json`.

### E. Multi-Backend Registry Testing (`web/test/backends.test.ts`)
Multi-backend support introduces a per-backend registry (`backends.ts`) that
the existing `api.ts` adapts to. Because the four documented startup/storage
invariants (boot-after-hydration ordering, refresh-nonce gate, bound bridge
methods, force-rehydrate after bridge ready) all flow through this layer, it
gets its own unit suite following the pure-helpers-extracted pattern.

**Pure-helper tests** (`migrateLegacy`, `nameFromBaseUrl`, `normalizeConnectionInput`,
`pickFallbackBackend`, `applyDeepLink`):
- Migration: usable legacy `apiConfig`+`agentConfigs` → one named backend set
  active (prefs + agent configs carried); unusable/missing legacy → empty
  registry; idempotent (re-hydrate never re-migrates).
- Connection parsing: full `?token=` URL auto-splits; plain `host:port`
  normalizes to `http://host:port` with empty token; garbage → null.
- Fallback selection on remove: active removed → most-recent-other; non-active
  removed → active unchanged; last backend removed → null.

**Registry lifecycle tests:**
- `force=true` re-reads registry after an initial empty hydrate (the
  "re-open app lost connection" regression, re-sourced).
- Bridge-backed registry takes priority over `localStorage` and must not touch
  `localStorage` (phone WebView clear-on-relaunch regression).
- `setActiveBackend` is atomic: flips `activeBackendId`, propagates to the
  active view, persists in one step; the App auto-persist effect's write-back
  lands on the **new** active backend, never the previous one (switch atomicity).
- `upsertBackend`/`removeBackend`/`saveBackend` semantics, including the
  recency-history-driven fallback chain.
- The existing `test/storage.test.ts` and `test/configHelpers.test.ts` stay
  green (interface unchanged) — this itself is the regression guard that the
  four startup/storage invariants survive the registry swap.

**Refresh-nonce gate under multi-backend (new invariant):** after a switch to a
*configured* backend the settings refresh nonce bumps (list populates without
Save); after switching to an *unconfigured* state (empty registry) it does
**not** bump (no silent-failing refresh).

### F. Manual Happy-Path Checklist (Multi-Backend)
Run before tagging a release:
1. Fresh install (no keys): empty state → connect a backend → agents load →
   send a message.
2. Upgrade from an existing single-backend install: existing config appears as
   one named backend, auto-selected, agents load with **no Save click**
   (migration + boot-after-hydration ordering).
3. Connect a 2nd backend via URL paste (auto-split) → switch to it → its agents
   load; switching back restores the first backend's agent config + prefs.
4. Edit a backend's token → Save → messages still work.
5. Remove the active backend → app falls back to the other backend and
   re-boots; remove the last backend → empty state.
6. Restart the app → the last-connected backend auto-connects on startup.

## 3. Execution Strategy
1. **App Polish:** ✅ Address any remaining production quality improvements in `web/src/` (e.g., UI layout fixes, scroll physics, removing duplicated imports).
2. **Implement Fuzzer:** ✅ Build `scripts/fuzzy-test.mjs` ported from `even-telegram` but adapted to `even-agent-home`'s `AppState` constraints and invariants (including `scrollOffset` and `available` agent payload structures).
3. **Execute Harnesses:** ✅ Run `npm run test:simulator` explicitly verifying 0 structural failures.
4. **Provider Regression Pass:** ✅ For provider/model/polling changes, run
   `npm run build --prefix web`, `npm run test:unit --prefix web`,
   `node scripts/test_models_harness.js`, and
   `node scripts/test-polling-controller.mjs`.
5. **Resolution:** ✅ Address any bugs uncovered during fuzzy/flow/provider execution (e.g. backend crash on multiple `execSync` imports, UI bug with flexbox constraints, false transient `Agent Error`, stale saved model IDs) and ensure tests pass stably.
