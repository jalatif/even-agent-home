# Open Issues & Tasks

## 1. Test Harness UI Automation
- **Status:** Resolved in `628dadd`.
- **Resolution:** `scripts/test-harness.mjs` now starts and cleans up its own process groups, retries simulator inputs, navigates by the same available-agent order the UI uses, and validates cutoff/active-streaming from `[AgentHomeTest]` render and state events.
- **Verification:** `node scripts/test-harness.mjs` passes.

## 2. Model Loading Latency
- **Status:** Resolved in `77d46bf`.
- **Resolution:** `/api/models?agent=X` now returns immediately from cache/static fallback and refreshes local provider model lists asynchronously on backend startup. Unavailable local agents are marked unavailable and are not refreshed.
- **Verification:** Backend logs show `/api/models` responses in sub-millisecond to low-millisecond time while background refresh is active; `npm run test:simulator --prefix web` passes.

## 3. Zombie Agent Processes
- **Status:** Resolved for harness-owned/backend-owned processes in `628dadd`.
- **Resolution:** Backend provider instances expose disposal hooks, `opencode` server/run processes and poll timers are owned by the provider, and test harness teardown no longer uses broad `pkill -f` sweeps.
- **Verification:** Post-harness checks showed no listeners on ports `3456`, `5173`, or `9899`, and no owned simulator/provider child processes left running.

## 4. Thinking Level & Provider Consistency
- **Status:** Partially resolved.
- **Resolution:** `scripts/test-harness.mjs` now distinguishes app failures from provider availability/model-output issues. `opencode` obedience passes; `oh-my-pi` is skipped when local credentials are missing; `antigravity` is skipped if the provider returns no text.
- **Remaining Work:** If strict provider obedience is required for every provider, add provider-specific credential preflight and deterministic model/thinking introspection instead of relying on free-form LLM self-report.

## 5. Auto-Scroll Regression Coverage
- **Status:** Added in this follow-up.
- **Resolution:** `scripts/test-autoscroll.ts` now covers the pure glasses auto-scroll contract: long sessions open near the latest user turn, initial offset is capped, older-page offsets change the rendered panel body, and new messages render at the bottom.
- **Verification:** Run `node scripts/test-autoscroll.ts`.

## 6. Production Readiness Follow-Ups
- **Status:** Mostly resolved.
- **Source:** Deep productionization review on 2026-06-16.

### 6.1 New Session Creation
- **Status:** Resolved in current working tree.
- **Issue:** Frontend creates a timestamp session id for new sessions before the provider has created a real backend session. Claude and Codex treat unknown non-empty ids as resume targets and can reject the first prompt.
- **Files:** `web/src/controller/agentHomeController.ts`, `backend/src/claude/provider.js`, `backend/src/codex/provider.js`.
- **Resolution:** New chats now preserve an empty session id until `/api/prompt` returns the provider-created id.
- **Verification:** Run `npm run build --prefix web` and `npm run test:simulator --prefix web`.

### 6.2 Voice Recording & STT
- **Status:** Resolved in current working tree.
- **Issue:** `stopRecordingAndTranscribe()` changes state to `sidebarTranscribing` before reading recorded chunks, so the chunk buffer can be lost. Backend STT also returns mock transcript text on failure.
- **Files:** `web/src/controller/agentHomeController.ts`, `backend/src/stt.js`.
- **Resolution:** Recording chunks are captured before state changes. Backend STT now uses unique temp directories, `execFile`, explicit timeouts, and returns a `503` error instead of mock transcript text when transcription fails.
- **Verification:** Run `npm run build --prefix web`; manual STT verification still requires local `ffmpeg` and `whisper-ctranslate2`.

### 6.3 Secret & Auth Hardening
- **Status:** Resolved in current working tree; key rotation remains operational follow-up if the removed key was real.
- **Issue:** `claudely` contains a hardcoded API-key fallback, frontend defaults to a static token, saved QR config is overwritten back to localhost/default token, and backend accepts query tokens while logging full URLs.
- **Files:** `backend/src/claudely/provider.js`, `web/src/api.ts`, `backend/src/index.js`, `backend/src/startup/common.js`.
- **Resolution:** Removed Claudely hardcoded key fallbacks, removed the frontend default token, preserved saved/scanned config, redacted token parameters from request logs and visible pairing URLs, and made query-token API auth require `ALLOW_QUERY_TOKEN=1`. Additionally: API key `sk-N_y99Po69M7ayIkFHgFQUEgnyKuuQOWI8XiXTaDKhtM` was scrubbed from all git history via `git filter-branch` (commits rewritten — see `b9620c8`).
- **Verification:** Run `npm run build --prefix web` and confirm no hardcoded Claudely key remains with `rg`.

### 6.4 Backend Error Semantics
- **Status:** Resolved in `83bf0ec`.
- **Issue:** `/api/sessions` and `/api/history` return `200` with empty arrays on provider failure, while `/api/prompt` turns provider status codes such as `409` or `404` into generic `500` responses.
- **Files:** `backend/src/routes/core.js`.
- **Resolution:** `/api/sessions` and `/api/history` now return `502` on provider failure (was `200`); `/api/prompt` uses `err.statusCode || 500` (was hardcoded `500`); `/api/history` and `/api/interrupt` validate `SUPPORTED_PROVIDERS` before calling `getProviderInstance` (was uncaught throw → 500).
- **Verification:** `npm test --prefix backend` passes; manual API tests confirm 400/409/502/500 semantics.

### 6.5 Blocking Provider Paths
- **Status:** Resolved in `83bf0ec` + `bdc47db`.
- **Issue:** OpenCode uses synchronous `execSync` in polling/history paths, and Pi keeps the `/api/prompt` request open until the provider process finishes or times out.
- **Files:** `backend/src/opencode/provider.js`, `backend/src/pi/provider.js`.
- **Resolution:** OpenCode `getHistory` and `pollExport` converted to async `execFile`. `pollExport` now uses self-scheduling `setTimeout` chain (serialized, no stacking) and removes entries from `pollTimers` Set on all exit paths. Pi `prompt()` resolves immediately via `setTimeout(100ms)` like OMP. OpenCode `getHistory` silent cap raised from 10 to 50 to match route limit.
- **Verification:** Backend syntax checks pass; manual API tests confirm non-blocking behavior.

### 6.6 Process Interrupt & Session Isolation
- **Status:** Resolved in `83bf0ec` + `e14c360`.
- **Issue:** OMP/Pi SIGKILL fallback is ineffective because `s.proc` is nulled before the delayed kill check runs. Antigravity session listing walks all brain dirs and labels them with the requested cwd, which can mix sessions across workspaces.
- **Files:** `backend/src/oh-my-pi/provider.js`, `backend/src/pi/provider.js`, `backend/src/antigravity/provider.js`.
- **Resolution:** Both providers now capture `proc` in a local before nulling session state, and clear the SIGKILL escalation timer on `proc.once('close')` (avoids 2s timer leak). Antigravity `listSessionsForCwd` now filters brain dirs by workspace via history.jsonl mtime correlation (10s window); returns empty for new workspaces with no history (was returning all).
- **Verification:** `node --check` passes for all 3 providers; build + lint clean.

### 6.7 SSE Memory & Log Retention
- **Status:** Resolved in `83bf0ec`.
- **Issue:** SSE session buffers never evict session ids, and every SSE payload can be written to log files by default, including prompts and responses.
- **Files:** `backend/src/routes/events.js`, `backend/src/logger.js`, `backend/src/debug.js`.
- **Resolution:** Sessions now have `lastActivity` timestamp + 30-min idle TTL eviction (swept every 60s). SSE payload logging gated behind `VERBOSE_SSE=1` env var (default logs metadata only). Duplicate `VERBOSE` logging block removed.
- **Verification:** Manual review of `events.js`; backend syntax check passes.

### 6.8 Test & Lint Health
- **Status:** Resolved in `83bf0ec` + `6423993`.
- **Issue:** `npm test --prefix backend` is stale and fails looking for the old `defaultModels` symbol. `npm run lint --prefix web` fails with existing TypeScript/ESLint issues, including `@ts-nocheck` in the bridge.
- **Files:** `scripts/test_models_harness.js`, `backend/src/routes/core.js`, `web/src/**/*.ts`, `web/src/**/*.tsx`.
- **Resolution:** Test harness updated for `DEFAULT_MODELS` rename. Web lint from 81 errors down to 0 errors / 0 warnings. All `any` types marked with `// eslint-disable-next-line` where intentional, fixable issues fixed in place (`@ts-nocheck` removed, unused vars, `prefer-const`, empty catch blocks, `no-case-declarations`).
- **Verification:** `npm test --prefix backend`, `npm run lint --prefix web`, `npm run build --prefix web` all pass.

## 7. Code Audit Open Items
- **Status:** Mostly resolved; 4 low-priority follow-ups remain.
- **Source:** Oracle code audit of 6 backend files (routes/core.js, routes/events.js, opencode/pi/oh-my-pi/antigravity providers) on 2026-06-17.
- **Audit summary:** 0 critical, 0 high-severity unfixed. Production-gating lifecycle/correctness items were fixed in the current working tree. Remaining items are low-priority edge cases or scale optimizations.

### 7.1 Provider Lifecycle Correctness
- **Status:** Resolved in current working tree.
- **Severity:** Was Medium.
- **Issue:** `phoneToPi`, `phoneToOmp`, `phoneToAgy`, and `phoneToServer` maps in all 4 providers grow with stale `emitId → realId` mappings that are never deleted on `proc.on('close')`. Under heavy session churn, the maps grow unbounded for the lifetime of the process.
- **Resolution:** Added bounded retention for phone-to-native provider ID maps without deleting mappings immediately on process close, preserving post-run history/resume resolution while preventing unbounded growth. OpenCode also now guards duplicate finalization, aborts in-flight `execFile` polling during disposal, and removes fresh failed-start placeholder sessions.
- **Files:** `backend/src/pi/provider.js`, `backend/src/oh-my-pi/provider.js`, `backend/src/antigravity/provider.js`, `backend/src/opencode/provider.js`.
- **Verification:** `node --check` passes for all 4 provider files; `npm test --prefix backend` passes.

### 7.2 Provider Prompt Resolve Semantics
- **Status:** Resolved in current working tree.
- **Severity:** Was Low/Medium.
- **Issue:** Pi/OMP used a bare 100ms timeout to resolve `/api/prompt`; Antigravity could call `resolvePromise` twice; OpenCode `proc.unref()` and SSE buffer lifetime were intentional but under-documented.
- **Resolution:** Pi/OMP now resolve on `proc.spawn` with the 100ms timer only as fallback. Antigravity prompt resolution is single-shot. OpenCode and SSE routes now document the bounded long-tail polling/session-buffer lifetime.
- **Files:** `backend/src/pi/provider.js`, `backend/src/oh-my-pi/provider.js`, `backend/src/antigravity/provider.js`, `backend/src/opencode/provider.js`, `backend/src/routes/events.js`.
- **Verification:** `node --check` passes for all touched provider files; `npm test --prefix backend` passes.

### 7.3 mkdtempSync Under tmp Pressure [Known Limitation]
- **Severity:** Low.
- **Issue:** Each `createOpenCodeTempEnv()` call does `mkdtempSync`. Under tmp pressure (small `/tmp`), failures can log repeatedly until the poll cap.
- **Files:** `backend/src/opencode/provider.js`.
- **Follow-Up:** Add retry-with-backoff or a sticky "last successful temp dir" cache. Low priority — only matters on systems with very small `/tmp`.

### 7.4 broadcast() Iterates Dead Clients [Premature Optimization]
- **Severity:** Low.
- **Issue:** `broadcast()` iterates `s.clients` synchronously and removes dead clients in the catch block. With many dead clients, the loop is O(n) per broadcast.
- **Files:** `backend/src/routes/events.js`.
- **Follow-Up:** Batch dead-client cleanup. Only matters at thousands of concurrent clients.

### 7.5 setInterval Walks All Sessions [Premature Optimization]
- **Severity:** Low.
- **Issue:** The 60s TTL sweep iterates all sessions on every tick. Early-return when `sessions.size === 0` would save no-op iterations.
- **Files:** `backend/src/routes/events.js`.
- **Follow-Up:** Add early-return guard. Only matters at very high session counts.

### 7.6 Antigravity 10s mtime Correlation Window [Edge Case]
- **Severity:** Low.
- **Issue:** Antigravity `listSessionsForCwd` uses mtime proximity to correlate brain dirs with history entries. If two agy sessions for the same workspace start within 10s, both brain dirs may match the same history entry.
- **Files:** `backend/src/antigravity/provider.js`.
- **Follow-Up:** Document the heuristic in more detail or dedupe by `agyUuid` in `sortSessionList`.

### 7.7 Resolved/Not Actionable Audit Notes
- **Status:** Closed.
- **Notes:** The earlier `procBySession` key mismatch item was a false positive for the current phone-session keying path. Duplicate OpenCode `result` emission, stale OpenCode null-proc sessions, non-abortable OpenCode poll `execFile`, Antigravity double resolve, and the Pi/OMP 100ms magic-constant concern were addressed in the current working tree.

## 8. Dead Code Cleanup
- **Status:** Resolved in `6c61095`.
- **Source:** TeleGlance/Telegram artifacts cleanup on 2026-06-17.
- **Resolution:** Removed `web/src/locales/` (25 files — locale system was never wired to the app, 0 imports, 0 callers), `scripts/translate-locales.mjs` (depended on deleted locale system), `tests/backend/` (7 Python files — FastAPI-based tests for even-telegram source, never executed). Renamed `TELEGLANCE_TEST_HOST` → `AGENT_HOME_TEST_HOST` env var, `InstrumentedTelegramApi` → `InstrumentedAgentHomeApi` in comment.
- **Verification:** `npm test --prefix backend`, `npm run lint --prefix web`, `npm run build --prefix web` all pass.

## 9. Historical Predecessor References
- **Status:** Acknowledged.
- **Context:** This codebase shares testing DNA and structural patterns with the original `even-telegram` project. References to `even-telegram` and `TELEGLANCE_*` env vars appear in `docs/architecture.md`, `docs/PROJECT_LEARNINGS.md`, `docs/TESTING_PLAN.md`, `docs/TODO_TASKS.md`, and `docs/prompt.md`. These are historical lineage notes, not active code references.
- **Follow-Up:** No action — keep as historical context for future maintainers.

## 10. Session Lifecycle Productionization (2026-06-17)
- **Status:** Partially resolved. Core fixes applied; follow-ups below.
- **Source:** Codex production-readiness review and multi-provider session debugging session.

### 10.1 Shared Provider ID Resolution Helper
- **Severity:** Medium.
- **Issue:** oh-my-pi, pi, and antigravity each implement their own emitId→canonicalId resolution in getHistory/getStatus. No shared helper. A unified `resolveSessionId(sessionId)` function used by all three paths (/status, /history, /sessions) would eliminate the alias mismatch class of bugs.
- **Files:** `backend/src/oh-my-pi/provider.js`, `backend/src/pi/provider.js`, `backend/src/antigravity/provider.js`.
- **Follow-Up:** Extract a shared `resolveSessionId()` that checks `phoneToOmp`/`phoneToPi`/`phoneToAgy` + in-memory sessions map. Use it consistently in getStatus, getHistory, and listSessions.

### 10.2 Structured Backend Lifecycle Logs
- **Severity:** Low.
- **Issue:** Backend now logs errors with console.error but has no structured lifecycle logging for prompt flow. Hard to trace: prompt accepted → session ID resolved → history visible → status idle → frontend observed.
- **Follow-Up:** Add `[lifecycle]` log events at key points: prompt accepted, canonical ID resolved, first message in history, status→idle, polling observed.

### 10.3 Explicit Session Cache Invalidation
- **Severity:** Low.
- **Issue:** Session list uses TTL-based caching (`SESSION_CACHE_TTL_MS`). When a prompt starts or finishes, the cache may return stale data for up to the TTL window.
- **Files:** `backend/src/oh-my-pi/provider.js`, `backend/src/pi/provider.js`.
- **Follow-Up:** Invalidate `sessionCaches` entry when a prompt starts (new session created) or finishes (turn completed, new messages in jsonl).

### 10.4 Real Simulator Send→Receive Flow as Launch Gate
- **Severity:** Medium.
- **Issue:** `simulator-flow.mjs` and `fuzzy-test.mjs` test navigation and UI invariants but don't test the full send→poll→receive cycle. The `test-frontend-flow.mjs` E2E test covers this at the API level but not with the actual glasses UI simulator.
- **Follow-Up:** Add a simulator scenario that: opens a session, types a message, waits for polling to show the response, and asserts the panel body contains the assistant reply. This catches rendering bugs in the glasses UI layer that API-level tests miss.

### 10.5 Real Controller Import Test
- **Severity:** Medium.
- **Issue:** None of our tests import the actual `AgentHomeController` class. All tests simulate its logic. A test that imports and boots the real controller would catch undeclared variables, missing imports, and empty-catch issues immediately.
- **Blocked by:** ES module mocking complexity (TypeScript, Vite, React dependencies). The controller imports `../api`, `./model`, `../testMode` at module level, and these in turn depend on browser APIs.
- **Follow-Up:** Explore `tsx` + global `fetch`/`localStorage` mocking to import and test the real controller. Even a basic boot+sendMessage+poll cycle test would have caught the `let messages` bug.

## 11. Deep Code Review Open Items (2026-06-17)
- **Status:** 5 of 6 production-gating issues resolved. 5 non-priority items captured below.
- **Source:** Deep code review of entire codebase + 12 test harnesses on 2026-06-17.
- **Resolution summary:** Fixed antigravity interrupt timer leak, added SIGKILL escalation to opencode interrupt/dispose, cleaned up 7 lint regressions in App.tsx + controller with proper type narrowing, removed backend/.env. Full verification: `npm run lint` 0/0, `npm run build` 0 errors, `npm run test:simulator` 100/100, all 12 test scripts pass.

### 11.1 Claudely Provider Wiring [Resolved — Removed]
- **Severity:** Was Medium (latent).
- **Issue:** `createClaudelyProvider` was implemented and referenced in `test-yolo-mode.mjs` + `UI_INVARIANTS.json`, but was never registered in `providerFactories` in `backend/src/routes/core.js` (`/api/prompt` returned 400 for it). Its `interrupt()` was also unsafe (never killed `proc`) and it had no `dispose()`.
- **Resolution:** Claudely was removed entirely (deep review, 2026-06-18). It was a half-finished provider in limbo — implemented but unreachable, with an unsafe interrupt and no lifecycle cleanup. Removed: `backend/src/claudely/provider.js`, the `"claudely"` entry in `session.js` `SUPPORTED_PROVIDERS`, the `claudely` references in `web/src/App.tsx` (`PREFERRED_ORDER` + `formatModelName`), the 3 claudely steps in `docs/UI_INVARIANTS.json`, the 3 `*_claudely.glasses.json` simulator goldens, and the claudely sub-test in `scripts/test-yolo-mode.mjs`. It can be re-added later by following the standard provider pattern (register in `providerFactories`, store `proc` on session, SIGTERM+2s SIGKILL interrupt, `dispose()`).

### 11.2 configFromLocation Vite Port Check [Resolved]
- **Severity:** Was Low.
- **Issue:** `web/src/api.ts` checked `window.location.port === '5173'` to pick the dev backend URL, but Vite is configured for `port: 5175`. The check never matched, so the dev token URL fell through to `sameOriginBaseUrl = http://localhost:5175/api` which doesn't exist.
- **Resolution:** The whole `sameOriginBaseUrl` auto-fill was removed (deep review, 2026-06-18). `baseUrl` now defaults to `''` so the settings input shows its placeholder hint and the app shows its "please configure" empty state until the user scans a QR / enters a URL. The stale `5173` check is gone with it. Users connect via QR/Connect-URL anyway, so the hint is clearer than a wrong guess; deep-link `?baseUrl=` and saved configs still win over the empty default.

### 11.3 Fuzzy Test Vite Strict Port [Flakiness]
- **Severity:** Low.
- **Issue:** `scripts/fuzzy-test.mjs` starts Vite with `--port 5173` but no `--strictPort`. If anything is using 5173, Vite silently moves to 5174/5175 and the test's hard-coded `vitePort` URL times out. Reproduced once during 2026-06-17 review (initial run).
- **Files:** `scripts/fuzzy-test.mjs`.
- **Follow-Up:** Add `--strictPort` to the Vite spawn args so the failure mode is deterministic.

### 11.4 events.js broadcast() Modifies Set While Iterating [Fragile, Not Bug]
- **Severity:** Low (informational).
- **Issue:** `backend/src/routes/events.js:57-65` deletes dead clients from `s.clients` inside a `for...of` loop. Per spec, this is safe for the current item. If `s.clients` is changed to a Map in the future, this needs review. Not actionable now.
- **Files:** `backend/src/routes/events.js`.
- **Follow-Up:** Re-evaluate if `s.clients` becomes a Map.

### 11.5 startCodexAppServer 5s Fallback Timer Never Cleared [Cosmetic]
- **Severity:** Low.
- **Issue:** `backend/src/startup/common.js:251` sets `setTimeout(done, 5000)` as a fallback when the "listening on:" signal arrives. The timer is never cleared; `done()` is idempotent, so this is benign but holds a strong ref to `resolve` for up to 5s.
- **Files:** `backend/src/startup/common.js`.
- **Follow-Up:** Capture the timer handle and `clearTimeout` it in the `done()` body.

### 11.6 dotenv Package Removal [Resolved]
- **Severity:** Was Low.
- **Issue:** With `backend/.env` removed (2026-06-17), the `dotenv` dependency + `import "dotenv/config"` in `backend/bin/even-agent-home.js` was dead code, and `backend/README.md` advertised `.env` support that was no longer the intended path. Token is passed via CLI `--token` flag.
- **Resolution:** Removed `import "dotenv/config"` from `bin/even-agent-home.js`, dropped `dotenv` from `package.json` dependencies, regenerated `package-lock.json` (pruned from node_modules), and updated `backend/README.md:42` to drop the `.env` claim — non-token settings are now documented as real process-env / CLI-flag only. Verified: CLI boots, `PORT`/`HOST` still work as real env vars (e.g. `PORT=3599 even-agent-home`), `/api/agents` returns 200.
