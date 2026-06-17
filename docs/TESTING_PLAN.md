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

## 3. Execution Strategy
1. **App Polish:** ✅ Address any remaining production quality improvements in `web/src/` (e.g., UI layout fixes, scroll physics, removing duplicated imports).
2. **Implement Fuzzer:** ✅ Build `scripts/fuzzy-test.mjs` ported from `even-telegram` but adapted to `even-agent-home`'s `AppState` constraints and invariants (including `scrollOffset` and `available` agent payload structures).
3. **Execute Harnesses:** ✅ Run `npm run test:simulator` explicitly verifying 0 structural failures.
4. **Resolution:** ✅ Address any bugs uncovered during fuzzy/flow execution (e.g. backend crash on multiple `execSync` imports, UI bug with flexbox constraints) and ensure tests pass stably.
