# AgentHome: Project Learnings & Development Guidelines

This document serves as the project-specific memory for `even-agent-home`. It captures critical technical decisions, debugging lessons, and strict protocols that govern the architecture and testing of this application.

## 1. Documentation & Maintenance Protocol

To maintain the integrity of the project, **any architectural, UI, execution plan, testing, or customer-facing README changes MUST synchronously trigger updates across all relevant documentation files:**
- `docs/architecture.md`
- `docs/execution_prd.md`
- `docs/TESTING_PLAN.md`
- `docs/testing_harness.md`
- `docs/ui_invariants.md`
- `web/README.md`

## 2. Testing Philosophy & Harness

- **Structural Invariants:** The `fuzzy-test.mjs` simulator tests are the source of truth for UI transitions. Any new UI logic, state transition, or payload schema change must be explicitly mapped to invariant checks in `checkStructuralInvariants` inside `scripts/fuzzy-test.mjs`.
- **E2E Validation:** The testing harness natively brings up the Vite frontend and Node.js backend to test the full lifecycle. Any code changes must be validated by running:
  ```bash
  npm run test:simulator --prefix web
  ```
  (or simply `npm run test:simulator` from the `web` directory). Code is not considered complete until it passes the default 100 iterations with 0 failures.

## 3. Engineering Lessons & Pitfalls

### Backend & Build Constraints
- **Model Lists Integration:** When adding or updating models for a provider, NEVER guess the available variants. Always fetch the models explicitly from a local source of truth (e.g. `scripts/test-artifacts/models_dump.json`, SQLite, or local CLI output like `codex models`) so the UI accurately represents available endpoints.
- **Duplicate ES Module Imports:** When dynamically testing or running Vite along with a Node.js ES Module backend, duplicated imports (e.g., importing `execSync` twice in `core.js`) will bypass standard static analysis and cause catastrophic Node.js module loader crashes during runtime/test setup. Strict module hygiene is required.
- **Availability Scanning:** The backend determines agent availability by running `command -v <agent-name>`. The frontend state strictly maps this into a `{ id: string, available: boolean }` schema, but processes the active enabled list as an array of strings in `state.agents`.

### UI Rendering & CSS Constraints
- **Hardware-Accurate Line Wrapping (Glasses View):** When sending text chunks to the physical Even Realities G2 display (or its simulator equivalent via `model.ts`), you cannot rely solely on explicit newline characters (`\n`) for layout calculations. A single massive paragraph maps to 1 "line" programmatically but will consume 15+ physical lines on the display (which only fits ~8). If not accurately measured, the display truncates overflowing text from the bottom, causing the UI to anchor to the middle/top of messages instead of the end. You MUST inject a `wrapText(text, maxLen: 64)` algorithm to simulate the hardware word-wrap boundary. By slicing against physical wrapped lines (`visibleLines = wrappedLines.slice(topIndex, bottomIndex)`), the most recent chunk of a massive paragraph reliably anchors to the bottom of the lenses.
- **Simulator Scrollbar Pitfall:** Because the physical G2 glasses only hold 999 bytes per string and lack native view scrolling, text chunks must be strictly bounded. If you pass a chunk that is 7 or 8 lines, it will slightly overflow the display container overlapping the footer. This causes the EvenHub simulator to aggressively render a native green scrollbar at the top of the overflowed chunk. Because manual pagination manages the scroll, this pseudo-scrollbar is visually deceptive and inaccurate. **Always cap `maxLines = 6`** for `panelBody` to fit perfectly, prevent footer overlap, and naturally suppress the buggy simulator scrollbar.
- **Touchpad Scroll Mapping:** Natural scroll mapping on the glasses requires careful inversion. `swipeDown` moves the viewport DOWN, revealing NEWER content below, which means `scrollOffset` should approach `0` (the absolute bottom of the thread). Conversely, `swipeUp` drags the viewport UP, revealing OLDER content, which requires the `scrollOffset` to increase.
- **Simulator UI Thread Freezing (rebuildPageContainer):** Calling `rebuildPageContainer` via the EvenHub SDK triggers a heavy UI rebuild that blocks the Flutter main thread in the Simulator for several seconds. If high-frequency events (like 500ms animation loops, auto-scrolling, or swipe scrolling) trigger full rebuilds, the Simulator will permanently freeze, ignoring all clicks and inputs. **All high-frequency updates MUST use partial rendering** (`enqueueSidebarPanel` mapping to `textContainerUpgrade` in the bridge) to update text in-place without destroying the layout container.
- **Bottom-Anchored Messaging (Chat UI):** 
  - *Anti-Pattern:* Do not use `flex-direction: column-reverse` to force messages to the bottom. It inverses browser scroll events unexpectedly and causes dynamic list elements to clip if they overflow the container top.
  - *Correct Pattern:* Use standard `flex-direction: column` and apply `margin-top: auto` to an empty spacer `div` at the top of the flex container. This naturally pushes all content (like chat bubbles) to the bottom, creates the desired "bounce effect", and allows the native scroll bar to start at the bottom and cleanly scale UP as new items overflow.
- **Agent Graying:** Unavailable agents must be presented in the UI but heavily muted/disabled (`opacity: 0.5` or similar glassmorphism dark-theme styling) rather than removed, so the user knows the integration exists but requires local binary installation.

## 4. Environment & Dependencies

- The project shares testing DNA with `even-telegram`, but relies on an entirely different stack (Node.js/Express over Python/FastAPI) to act as a unified proxy. 
- Do not cross-pollinate testing files (like `tests/backend/test_api.py`) from Python projects into this Node.js architecture. Tests should be handled via the E2E fuzzy simulator, or appropriate Node.js test runners.

## 5. Session Status & Animations
- **Syncing External Background Tasks:** If an external CLI starts a generation process asynchronously, the frontend cannot track it simply via the local `openSession()` UI interactions. You must implement a global discovery loop (e.g. `api.getSessions()` on an interval) to locate actively `busy` external sessions and ingest them into local background trackers to ensure notifications trigger accurately on completion.
- **Optimistic Glass UI Rendering (SkipListeners):** Transmitting constant UI updates (like a 150ms Braille spinner loop: `⠋`, `⠙`, etc.) to the physical glasses via `TextContainerUpgrade` is required to animate UI components gracefully. However, tying this to native React `setState` will crater the web dashboard simulator's performance with hyper-aggressive DOM redraws. Always decouple simulator redraws from bridge telemetry by implementing a lightweight `{ skipListeners: true }` rendering strategy that bypasses the DOM but explicitly invokes `bridge.render(model)`.
- **Fuzzy Simulator Telemetry Limits:** When building tight loop animations or async DOM updates (e.g., `this.setState` on an interval), testing telemetry can drop inputs if the async loop falls exactly on the testing boundaries. Always provide sufficient timing headroom in `fuzzy-test.mjs` (like expanding `sleep(ms)` loops) when asserting asynchronous invariant checks against log streams like `input.dispatch`.

### Agent Integration & Lifecycle Pitfalls
- **Opencode Model Provider Prefix Resolution:** Opencode CLI strictly requires models to be fully prefixed (e.g., `litellm/minimax-m3`). Since frontend clients often cache older, unprefixed model names in `localStorage` from earlier backend versions, passing these strings down causes immediate CLI failure. To safely maintain backward compatibility, the backend provider MUST dynamically intercept unprefixed strings and match them against the suffix of locally available endpoints (via `opencode models`) before passing to `--model`.
- **Opencode Process Cleanup:** The Opencode agent CLI manages its own background history execution state, but if it crashes, ends prematurely, or simply finishes successfully, the internal polling `pollExport` might miss the precise `finish === "end-turn"` log condition. To avoid ghost sessions being eternally marked as `busy` in the UI, you MUST aggressively hook the `proc.once("close")` exit event of the CLI process. The exit hook serves as the absolute fallback to override the session state to `idle`, preventing endless frontend loading animations.
- **Opencode Reasoning Level / Variant:** The `--thinking` flag does not pass the level of thinking. To configure the thinking effort for `opencode`, you must pass the level explicitly via the `--variant` flag (e.g. `--variant high`).
- **Antigravity Dead Session Tracking:** Never use `lastEvent.type !== "PLANNER_RESPONSE" && lastEvent.type !== "ERROR"` on historical transcripts to infer a process's `busy` status, because valid turns often end gracefully on non-planner events (e.g., `VIEW_FILE` `status: DONE`). Historical or orphaned background sessions should default to `idle` natively, relying exclusively on active in-memory tracker maps to flag true ongoing execution.

## 6. Frontend Controller State Machine
- **Empty Catch Blocks are Silent Killers:** The polling loop in `agentHomeController.ts` wraps all poll updates in `try {} catch {}` (empty catch). A `ReferenceError` from an undeclared variable silently kills every poll cycle with zero visibility — no console error, no UI feedback, no test failure. Never add empty catches without at minimum logging the error. Consider replacing empty catches with `console.error('[poll]', e)` for diagnostics.
- **Declaration Drops During Refactors:** When extracting sub-values from array destructuring (e.g. changing `let messages = pollResults[1]` to `const statusData = pollResults[0]`), always verify the original `let` declarations are preserved. Dropping the declaration creates an undeclared-variable `ReferenceError` that the empty catch swallows.
- **Never-Shrink Guard Must Use `<` Not `=== 0`:** When backend returns N messages but local has N+1 (new user message not yet in jsonl), `messages.length === 0` won't fire. Use `messages.length < this.state.messages.length` to cover all shrink scenarios.
- **Polling Must Be Tested with Real Backend:** Unit tests of state machine invariants (like `scripts/test-controller-state.mjs`) don't catch undeclared-variable ReferenceErrors because they don't execute the actual polling loop code. The `scripts/test-frontend-flow.mjs` E2E test simulates the polling cycle against a real backend — always run it after controller changes.

## 7. Backend Session Status & ID Mapping
- **getHistory Must Resolve EmitID → OMP Session ID:** New sessions use emitIds (e.g. `oh-my-pi-1781...`) while jsonl files store omp session IDs (e.g. `019ed47e-...`). `getHistory` must check `phoneToOmp`/`phoneToPi` mappings before comparing against jsonl headers, otherwise history always returns empty for new or resumed sessions.
- **Resume Sessions Need ompSessionId:** When resuming an external session (not in in-memory Map), `session.ompSessionId` is null. Without it, `--resume` is never passed to omp/pi, creating a new session instead of appending to the existing one. Fix: set `session.ompSessionId = phoneSessionId` when `!existing && phoneSessionId`.
- **Status Route Must Propagate Error Field:** `/api/status` constructs its own response from `getStatus()` return values but was stripping the `error` field. All status responses must include `error` for frontend error display.

## 8. YOLO Mode & Permission Architecture
- **YOLO Mode is a Single Global Setting:** Stored in `apiConfig.yolo` (not per-agent `agentConfigs`). Applies to ALL agents uniformly. Default disabled. Frontend reads via `getApiConfig().yolo` and passes to every `api.prompt()` call.
- **Permission Mode Mapping:** yolo=true maps to CLI `--dangerously-skip-permissions` (claudely/opencode/antigravity), `--auto-approve` (oh-my-pi), `permissionMode: "bypassPermissions"` (claude SDK), auto-approval in `handleServerRequest` (codex). yolo=false/undefined removes all permissive flags.

## 9. Polling Loop Anti-Patterns
- **Declaration Drops During Refactors (CRITICAL):** The most expensive bug in this session — changing `let messages = pollResults[1]` to `const statusData = pollResults[0]` in commit `5a68d17` dropped the `let messages` declaration. Every 2s poll cycle threw `ReferenceError`, caught by empty `catch{}`, silently killing ALL state updates for 6 commits until discovered by Codex. Symptom: streaming never updated, thinking never cleared, messages never appeared. Root cause found by another agent reviewing the code, not by any test.
- **Empty catches must always log:** All 6 catch blocks now include `console.error` with context prefix. The original bug would have been immediately visible as `[poll:task] oh-my-pi 019ed... ReferenceError: messages is not defined`.
- **Never-Shrink Guard Must Use `<` Not `=== 0`:** When backend returns N messages but local has N+1 (new user message not yet in jsonl), `messages.length === 0` won't fire. Must use `messages.length < this.state.messages.length` to cover all shrink scenarios.
- **Prompt Returns EmitId, History Needs OmpId:** The most subtle race: `/prompt` returns emitId (`oh-my-pi-123`) before omp emits the real session ID. Polling with emitId before `phoneToOmp` is populated means status works (in-memory session) but history returns empty (jsonl has omp ID). Fix: wait up to 3s for real session ID from omp stdout, resolve with canonical ID.

## 10. Test Strategy Gaps We Fixed
- **Provider Contracts Must Be Tested Cross-Provider:** `test-provider-contracts.mjs` runs the same 4 invariants (unknown ID no-throw, prompt ID resolvable, idle+content coincide, sessions list IDs work) against every active provider. Catches ID alias mismatches and null-deref bugs.
- **Controller Races Need Timing Chaos Tests:** `test-controller-races.mjs` simulates 6 exact race conditions (idle before history, history shrinks, status throws, ID changes, partial text, N empty polls) against the same polling logic the controller uses.
- **E2E Flow Test Must Simulate Controller, Not Just API:** `test-frontend-flow.mjs` simulates the full controller send→poll→update cycle, not just endpoint pings. Catches sessionId capture, message preservation, and resume correctness.
- **Polling Integration Test Exercises Real pollResults Consumption:** `test-polling-controller.mjs` Test 2 directly calls `pollResults[1].history.filter()` — would throw ReferenceError if `let messages` is missing. This is the closest we got to catching the original bug.
- **Still Missing: Real Controller Import Test:** None of our tests import the actual `AgentHomeController` class. All simulate its logic. A test that imports and boots the real controller (with mocked API) would catch undeclared variables and empty-catch issues immediately. Module mocking complexity (TypeScript, Vite, ES modules) blocked this.

## 11. Error Visibility & Timeout Safeguards
- **Polling Detects Failed Silent Turns:** When `isThinking` transitions to false but no assistant reply arrived and no backend error was reported, the polling loop now sets `agentError = 'No response from agent'`. Previously this was invisible.
- **Turn Timeout Prevents Infinite Spinner:** A 5-minute timer starts when sending a message. If `isThinking` is still true after timeout, sets `agentError = 'Agent timed out'` and clears thinking. Timer is cleared when polling detects turn completion.
- **Glasses Footer Shows Errors:** `panelFooter` shows `Waiting for input | Agent Error` when `agentError` is set, making failures visible on the glasses without navigation.
