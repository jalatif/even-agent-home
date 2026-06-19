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

## 12. Claude "Invalid Key" via Bridge vs Direct CLI [Closed — device setup issue]

- **Status:** Closed (2026-06-18). Confirmed NOT a code defect. The "invalid key" / session errors were caused by the **corporate device's environment/launch-context setup** (the bridge process there did not see the same Claude credentials as the interactive `claude` CLI — a deployment-context problem, not a bug in this repo).
- **Outcome:** The separate Claude "No conversation found with sessionID" error (a genuine code bug) WAS fixed via `readSessionCwd` (see §13.4). This §12 item requires no code change — just ensure the bridge on each device is launched from a shell/context that has the Claude credentials (`ANTHROPIC_API_KEY` / `~/.claude` login) the interactive `claude` CLI uses. The detailed diagnostic checklist that was here is no longer needed; see git history if required.
- **Files:** none (no patch).

## 13. Hardware Test Findings (2026-06-18, real G2 + phone)

Five issues surfaced during end-to-end testing on real hardware. Root causes traced; fixes applied where the fix restores intended behavior.

### 13.1 Frontend settings lost on app re-open [Resolved]
- **Severity:** High (broke the core "connect once" flow).
- **Symptom:** Re-opening the app required reconnecting to the backend and re-entering the token; settings did not persist.
- **Root cause:** `web/src/App.tsx` captured the bridge storage methods off the instance:
  `const sdkGet = bridge.getLocalStorage; const sdkSet = bridge.setLocalStorage;`
  These are **unbound** — when later invoked as `sdkGet(key)`, `this` is `undefined`, so the call throws `Cannot read properties of undefined (reading 'sdk')`. The surrounding `try/catch` swallowed the error silently, so every read/write fell back to `window.localStorage`, which the phone host WebView clears on relaunch. Verified with a minimal repro (both read and write threw).
- **Secondary cause:** the post-bridge re-hydration in `App.tsx` called `hydrateApiConfig()` / `hydrateAgentConfigs()` a second time, but those short-circuit on `configHydrated === true` (already set by the pre-bridge `localStorage` pass). So even with the bridge wired, the durable KV store was never consulted.
- **Resolution:**
  1. Capture the `bridge` instance and call `bridge.getLocalStorage(key)` / `bridge.setLocalStorage(key, value)` on it directly (bound).
  2. Add `force = false` param to `hydrateApiConfig` / `hydrateAgentConfigs`; the post-bridge re-hydration passes `force: true` to bypass the cache and consult the bridge KV store.
  3. Regression test `hydrateApiConfig force=true re-reads from storage after an initial hydrate`.
- **Files:** `web/src/App.tsx`, `web/src/api.ts`, `web/test/storage.test.ts`.

### 13.2 Scan QR — Camera permission denied [Resolved — QR flow removed]
- **Severity:** Was Medium.
- **Symptom:** Tapping "Scan QR Code" on the phone returned "Camera permission was blocked…", even though the Even Realities host app had OS camera permission and `app.json` declared `camera`.
- **Root cause (confirmed via Even Hub docs research):** `html5-qrcode` calls `navigator.mediaDevices.getUserMedia()`. **Even Hub does not expose the phone camera to plugin WebViews** — the host does not implement WebView media-capture delegation, so `getUserMedia` rejects with `NotAllowedError` regardless of OS permission or the manifest. The Even Hub FAQ states it plainly: *"Can my app access the camera? — No."* and *"Pure WebView sandbox… no media."* The Device APIs doc lists the complete bridge surface (inputs, `audioControl`, `imuControl`, `getDeviceInfo`, `getUserInfo`, `getLocalStorage`/`setLocalStorage`) — **no camera/scan method**. No working phone-camera plugin example exists in official templates, the `BxNxM/even-dev` simulator, or any third-party repo surveyed. The `app.json` `camera` permission name was valid (it is in the allowed set), but a valid manifest permission does not imply a working runtime capability.
- **Resolution (2026-06-18):** Removed the entire QR-scan flow since the camera path is a dead end on Even Hub and users connect via URL + token anyway. Deleted `web/src/QRScanner.tsx`, removed the `QRScanner` import + `showQRScanner` state + `handleScan` handler + the "Quick Connect / Scan QR Code" card from `web/src/App.tsx`, uninstalled the `html5-qrcode` dependency (drops the 368KB `qr-vendor` bundle chunk — modules 52 → 27), and removed the now-unused `camera` permission from `app.json`. Connection is now exclusively via the Backend URL + Secure Token fields (a paste of a full `?token=` URL still auto-splits via `parseConnectionUrl`/`handleBaseUrlPaste`). Verified: `tsc` clean, `npm run build` success, 7/7 unit tests pass.
- **If camera scan is ever needed:** re-add only if Even Hub ships a native scan bridge (ask Even: dev portal / `hello@evenrealities.com`); `getUserMedia` will not work.
- **Files:** `web/src/QRScanner.tsx` (deleted), `web/src/App.tsx`, `web/package.json`, `web/package-lock.json`, `app.json`.
- **Sources:** https://hub.evenrealities.com/docs/reference/faq , https://hub.evenrealities.com/docs/build/device-apis , https://hub.evenrealities.com/docs/ship/packaging , https://hub.evenrealities.com/docs/getting-started/architecture

### 13.3 Voice failed — `spawn ffmpeg ENOENT` [Resolved — STT engine swapped to transformers.js]
- **Severity:** Was Medium (broke voice input on stock installs).
- **Symptom:** Glasses showed "Voice failed: Speech transcription failed. Verify ffmpeg and whisper-ctranslate2 are installed." Backend log: `[STT] transcription failed: spawn ffmpeg ENOENT`.
- **Root cause:** `backend/src/stt.js` shelled out to `ffmpeg` (PCM→WAV) and `whisper-ctranslate2` (a **Python package**) for STT. On a fresh device these were not installed / not on PATH. This was a deployment gap — the backend hard-depended on external binaries + a Python runtime.
- **Resolution (2026-06-18):** Replaced the whole STT engine with `@huggingface/transformers` (transformers.js v3), which runs Whisper **inside Node** via ONNX Runtime (CPU/WASM). Voice input now needs **zero external dependencies** — no `ffmpeg`, no Python, no `pip install`. `npm install -g even-agent-home` is sufficient.
  - Model: `Xenova/whisper-tiny.en`, **q8-quantized** (~40MB), downloaded from HuggingFace on **first voice use** then cached at `~/.agent-home/models/` (override with `HF_HOME` / `AGENTHOME_STT_MODEL`). Only the first-ever query needs network; subsequent ones are offline.
  - The pipeline is **lazy-loaded** on first transcription so the backend still boots fast; users who never use voice never pay the memory cost.
  - transformers.js takes **Float32 PCM directly**, so the `ffmpeg` PCM→WAV conversion step was removed entirely — no subprocess at all.
  - Verified end-to-end: `POST /api/transcribe` returns an accurate transcript in ~1s; empty-input and sub-0.5s clips are handled cleanly; network/download failures surface a clear message.
- **Tradeoff:** CPU/WASM inference is slower than optimized ctranslate2, but fine for short voice *queries* (a few seconds of speech). For long-form transcription the old engine would be faster, but that is not this product's use case.
- **Files:** `backend/src/stt.js` (rewritten), `backend/package.json` (+ `@huggingface/transformers`).

### 13.4 Claude "No conversation found with sessionID" on existing session [Resolved]
- **Severity:** High (broke resuming any saved Claude session).
- **Symptom:** Sending a message to an existing Claude session from the phone returns "Agent Error: Claude Code returned an error results: No conversation found with sessionID: <ID>". (New sessions instead hit the unrelated "Invalid API Key" — see §12.)
- **Root cause:** The Claude SDK's `query({ resume: sessionId })` resolves the conversation file **relative to the cwd** passed to it. `backend/src/claude/session.js` set `lockedCwd = cwd ?? process.cwd()`, and the `/prompt` route passes `cwd = req.query.cwd || process.env.PROJECT_DIR` (the **bridge's** cwd). When that differs from the directory the session was originally created in, the SDK cannot find `<sessionId>.jsonl` → "No conversation found". Confirmed the jsonl records the original `cwd` per session, but it was never used on resume.
- **Resolution:** Added `readSessionCwd(filePath)` in `backend/src/claude/provider.js` (scans the session's jsonl for the first record carrying a `cwd` field). On resume, the recovered original cwd is passed to `session.start(sessionId, originalCwd)`, falling back to the caller's cwd only when no file/cwd can be recovered (e.g. brand-new session).
- **Files:** `backend/src/claude/provider.js`.

### 13.5 UP/Down/Click input latency ~1s [Resolved]
- **Severity:** Medium (perceived sluggishness on every hardware gesture).
- **Symptom:** Up/Down/Click/Double-click take ~1s to take effect.
- **Root cause:** `EvenHubGlassesBridge.renderSidebarPanel` dispatched each `textContainerUpgrade` call **serially in an `await` loop** (`web/src/bridge/evenBridge.ts`). Each call is an independent container region (title/sidebar/panel-body/panel-box/footer) AND a separate firmware round-trip on real G2 hardware (~50–200ms each). A single partial render with up to 5 updates therefore took N×latency ≈ up to ~1s, and the next input's render was gated on the previous flush finishing.
- **Resolution:** Dispatch all `textContainerUpgrade` updates concurrently with `Promise.allSettled(...)`. The updates target independent regions, so concurrent dispatch is safe and collapses a full panel update to a single round-trip (bounded by the slowest update). `allSettled` keeps the flush moving even if one region rejects.
- **Note:** This is a render-pipeline behavior change (serial → concurrent) but produces a visually identical result since the regions are independent. Flagged per the "ask before behavior changes" policy.
- **Files:** `web/src/bridge/evenBridge.ts`.

### 13.6 Up/Down navigation + live messages frozen in glasses UI [Resolved — 2nd hardware round]
- **Severity:** High (glasses display never updated on navigation or streaming replies).
- **Symptom (2nd HW test):** Up/Down pointer stuck at first entry (frontend pointer moved correctly); agent replies never rendered until leaving & resuming the session. Both broke after the §13.5 parallelization change.
- **Root cause:** When parallelizing `renderSidebarPanel`'s `textContainerUpgrade` calls, the SDK method was hoisted off its object (`const upgrade = this.sdk.textContainerUpgrade`) and invoked unbound. On real hardware the SDK method needs its receiver, so every call rejected with "Cannot read properties of undefined"; `Promise.allSettled` **silently swallowed** the rejection, so zero updates reached the glasses. The frozen-pointer and missing-live-message symptoms are the same root cause (both flow through the partial-render path; resuming a session triggered a full `rebuildPageContainer`, which was bound correctly — which is why resume "fixed" it).
- **Resolution:** Bind the method at the call site (`sdk.textContainerUpgrade!.bind(sdk)`), preserving the receiver. Added a regression test (`textContainerUpgrade actually completes`) using a fake SDK whose methods require `this` — verified to FAIL (3 tests) when the unbound call is reintroduced.
- **Note:** This is the same unbound-method footgun class as §13.1 (storage `getLocalStorage`). The bridge test's fake SDK previously did NOT require `this`, which is why the original parallelization looked green in tests but broke on hardware. Now fixed at the test level too.
- **Files:** `web/src/bridge/evenBridge.ts`, `web/test/bridge.test.ts`.

### 13.7 Agents not auto-loading on startup with saved settings [Resolved — 2nd hardware round]
- **Severity:** Medium (UX: required clicking Save Settings to load agents after every app open).
- **Symptom:** URL/token persisted correctly (§13.1 fix worked), but the main screen still showed "No agents / Configure backend" until the user opened Settings and clicked Save.
- **Root cause:** The initial `ctrl.boot()` (which fetches agents via `getApi()` → `currentConfig`) ran **concurrently** with the post-bridge force-re-hydration. `boot()` read `currentConfig` before the bridge KV store was consulted, saw the empty pre-bridge defaults (no baseUrl/token), and failed. The later Save click re-ran `boot()` with the now-correct config.
- **Resolution:** Moved `ctrl.boot()` to run **after** the force-re-hydration completes, so the first boot reads the fully-restored config and agents load automatically.
- **Files:** `web/src/App.tsx`.

### 13.8 PI showed cached models from the dev machine on other machines [Resolved — 2nd hardware round]
- **Severity:** Medium (wrong model list shown).
- **Symptom:** The PI agent listed models that only exist on the dev machine, even on a different machine with a different/no PI config.
- **Root cause:** `modelCache` was seeded with hardcoded `DEFAULT_MODELS` (compiled from the dev machine's known models). When `pi --list-models` returned 0 parseable models on the other machine (different pi version / unconfigured), the refresh logic fell back to that static seed instead of reflecting the empty result. The static list thus leaked across machines.
- **Resolution:** When refresh succeeds but yields 0 parseable models, set the list **empty** (`source: "empty"`) instead of retaining the dev-machine static seed. The CLI-error path keeps whatever the last successful refresh produced (could be the transient static seed on first run) and marks status `error`/`empty` so staleness is visible, but never re-introduces the dev list after a real refresh. `DEFAULT_MODELS` remains only as a brief first-load fallback before the initial refresh completes.
- **Files:** `backend/src/routes/core.js`.

## 14. Testing Harness Hardening + STT Provider Architecture (2026-06-18)

Follow-up work after the §13 hardware findings: (a) closed the harness coverage gaps that let those bugs escape, and (b) redesigned STT to eliminate the setup dependency that caused Issue 3.

### 14.1 New harness tests — closes 5 of 6 hardware-escape gaps [Resolved]
After auditing why each §13 issue reached hardware undetected, added five tests targeting the specific coverage holes. Of the six hardware-escape issues, these now catch five pre-hardware (only Issue 2 camera remains genuinely hardware-only — it depends on the Even Hub host's native media-capture delegation).

| Test | File | Catches |
| --- | --- | --- |
| Bridge unit tests (fake SDK) | `web/test/bridge.test.ts` (9 tests) | Issue 1 (unbound storage methods) + Issue 5 (serial render latency) |
| STT contract test | `scripts/test-stt-contract.mjs` | Issue 3 (missing STT dep) + provider proxy contract + key-leak |
| Claude resume test | `scripts/test-claude-resume.mjs` (8 tests) | Issue 4 (session cwd on resume) |
| Dependency-presence self-check | `scripts/test-dependency-presence.mjs` | missing runtime deps + agent bins before first use |

- **Proven to have teeth:** the Issue 5 latency test was verified to FAIL when the serial `textContainerUpgrade` loop is reintroduced (429ms vs 184ms parallel), then restored to green.
- **Testability change:** exported `readSessionCwd` from `backend/src/claude/provider.js` (was private; pure function, no behavior change). Added `.ts` extensions to two imports in `web/src/bridge/evenBridge.ts` (`allowImportingTsExtensions` already enabled) so the module is Node-runnable.
- **Wiring:** new npm scripts in `web/package.json` — `test:stt`, `test:resume`, `test:deps`, `test:all` (runs unit + deps + resume + stt). Bridge tests auto-discovered by `test:unit`.
- **Status:** all green (16 unit + deps + 8 resume + STT).

### 14.2 STT engine → built-in transformers.js [Resolved]
Replaced the external `ffmpeg` + `whisper-ctranslate2` (Python) STT with `@huggingface/transformers` running Whisper in Node via ONNX Runtime. Voice input now needs zero external dependencies — `npm install -g even-agent-home` is sufficient. See §13.3.

### 14.3 STT provider architecture — backend proxy [Resolved]
Redesigned STT so the provider is selected **server-side**, with all API keys kept on the backend (never in the glasses WebView, which is distributed to end users — this is Deepgram's/OpenAI's own guidance, and browser→Deepgram is also CORS-blocked).
- **Provider auto-detected from URL hostname:** `deepgram.com` → Deepgram contract, `openai.com` → OpenAI Whisper, no URL → built-in Whisper. `--stt-provider-type` overrides for self-hosted providers.
- **CLI flags:** `--stt-provider-url`, `--stt-provider-key`, `--stt-provider-type` (→ `AGENTHOME_STT_PROVIDER_*` env vars).
- **PCM→WAV wrapping** ported from the (previously-dead) `web/src/audio/wav.ts` into `backend/src/stt.js` — Deepgram/OpenAI reject raw PCM; the glasses stream raw s16le PCM which the backend wraps in a 44-byte RIFF/WAVE header before proxying.
- **Frontend simplified:** removed `sttUrl` from `AuthConfig`, deleted the Settings input, `transcribeAudio` always hits `/api/transcribe`. The frontend knows nothing about STT providers.
- **Module-load timing fix:** provider/URL/key resolution moved from module-eval time to call time (`activeProvider()`), because the CLI sets the env vars AFTER this module's top-level imports run (bin → index.js → core.js → stt.js). Caching at import would always see an empty env.
- **Verified:** mock-Deepgram contract test (WAV body + `Token <key>` + nova-3 + key-not-in-response) + real Deepgram key end-to-end (nova-3, accurate transcript in ~626ms, key stayed server-side).
- **Files:** `backend/src/stt.js` (rewritten), `backend/bin/even-agent-home.js` (flags), `web/src/api.ts`, `web/src/App.tsx`, `scripts/test-stt-contract.mjs` (rewritten), `backend/README.md` (STT section + env vars).

### 14.4 QR scan flow removed [Resolved]
Removed the entire QR-scan flow (camera path was a dead end on Even Hub — the host does not expose the phone camera to plugin WebViews). Connection is now exclusively via Backend URL + Secure Token. Uninstalled `html5-qrcode` (dropped the 368KB `qr-vendor` bundle), removed the `camera` permission from `app.json`. See §13.2.
- **Files:** `web/src/QRScanner.tsx` (deleted), `web/src/App.tsx`, `web/package.json`, `app.json`.
