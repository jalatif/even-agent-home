# AgentHome Architecture

## Overview
AgentHome is an Even Realities G2 glasses application that unifies access to multiple AI agents (claude, codex, oh-my-pi, antigravity, pi, opencode, hermes, openclaw) through a single backend service. It allows users to browse agents, create new sessions, resume existing sessions, and send voice-transcribed messages directly from the glasses.

## Architecture Components

### 1. Glasses Frontend (Even Realities SDK)
- **Framework**: React / Vite (following Even-Telegram structure).
- **Target Environments**:
  - Glasses UI: Renders `screenModel` using `@evenrealities/even_hub_sdk`. Uses `rebuildPageContainer` for full screen transitions and `textContainerUpgrade` (via `enqueueSidebarPanel`) for high-frequency partial renders (animations, scrolling) to prevent main-thread UI freezing.
  - Phone UI: React DOM application for initial pairing, configuration, and agent toggle settings.
- **State Management**: Shared controller maintaining finite state machine for screens (Pairing, Agent Selection, Session List, Chat/Message View, Recording, Transcribing, Confirmation).
- **Network**: Connects to one backend at a time over HTTP/SSE, but supports **multiple saved backends**. The phone UI maintains a registry of backends (each a name + URL/port + token + per-backend agent config + per-backend app prefs) persisted in the Even Hub bridge storage API (`localStorage` is only a dev fallback). One backend is **active** at a time (= the last connected); the app boots onto it automatically on startup. The glasses/main UI always renders the active backend's data and is unaware of the registry. See `docs/superpowers/specs/2026-06-28-multi-backend-design.md`.

### 2. Unified Backend Service
- **Framework**: Node.js / Express, acting as a unified proxy and session manager.
- **Provider Adapters**: Extends the `agent-home` provider pattern but manages all providers in a single server instance.
  - Implements uniform interfaces: `listSessions`, `getHistory`, `prompt`, `getStatus`, `getModels`.
  - **Custom agents (config-file-defined)**: in addition to the 8 hardcoded built-ins, the backend loads user-defined agents from `~/.agent-home/agents.yaml` (or `.json`, or `$AGENTHOME_AGENTS_CONFIG`) at `core.js` module-load, via `backend/src/providers/loader.js`. On first start it seeds a commented template + a user guide (`docs/custom-agents-guide.md` → `~/.agent-home/README.md`); both are idempotent and opt-out (`AGENTHOME_AGENTS_NO_SEED=1`). Three tiers: `type: gateway` (OpenAI-compatible SSE, parameterized `hermes`), `type: cli` (streaming-JSONL CLI driven by an `events` schema map, generalizes `pi`/`oh-my-pi`), and `type: module` (a dynamic-`import()` escape hatch for bespoke CLIs like `opencode`/`antigravity` that a template can't describe). The merge is purely additive with a collision guard and fail-softs to zero agents on any error, so built-ins are never affected (zero-config guarantee). `getProviderInstance` is async to support the module tier's dynamic import. See `docs/custom-agent-support.md` (design) and `docs/custom-agents-guide.md` (user guide).
  - **openclaw is transcript-based**: unlike the CLI-resume providers (codex, claude, pi, …), openclaw has no `--resume` flag. Session history is reconstructed from per-session `.jsonl` transcripts on disk (`mergeHistoryWithTranscript` merges the on-disk transcript with the in-memory current turn, deduping by `role|text`). When openclaw resumes a session with prior context it rewrites the user's new prompt on disk into a wrapped `[Chat messages since your last reply - for context] … [Current message] User: <clean>` blob; the controller's `reconcileWrappedUserMessages` (`web/src/configHelpers.ts`) substitutes the clean user text back in so the glasses show what the user actually typed.
- **Session Management**: 
  - Keeps track of `phoneSessionId -> providerSessionId` mappings for all providers.
  - Filters out empty sessions.
- **STT Service**: Exposes `/api/transcribe`. Built-in Whisper runs in Node via `@huggingface/transformers` by default; optional Deepgram/OpenAI Whisper proxy providers are selected server-side with backend CLI flags/env vars so provider API keys never reach the glasses client. The frontend can **optionally override** this with a global **Custom STT Server URL** setting (`sttServerUrl`, standalone KV key — not per-backend, stored in `web/src/sttSettings.ts`): when set, `AgentHomeApi.transcribeAudio` posts a multipart WAV directly to `${url}/api/transcribe` with **no encryption/auth** (the custom server has no backend token to decrypt the encrypted channel), instead of the backend's encrypted PCM-array channel. Blank = use the backend as above, unchanged. See `docs/custom-stt-server.md`.
- **Streaming**: Exposes unified SSE (Server-Sent Events) endpoint for real-time `text_delta`, `tool_start`, `tool_end`, and `result` streams.
- **Model Resolution**: `/api/models` returns cached model lists while provider refreshes happen asynchronously. The `pi` provider normalizes unqualified client aliases through `~/.pi/agent/models.json` before spawning the CLI, avoiding accidental built-in provider credential paths.

## Data Flow

1. **Pairing / Backends**: Phone UI manages a **registry of backends**, each added via a Connect modal (name + URL/port + token; pasting the full backend `?token=` connect URL auto-splits URL and token). All agent config and app prefs are stored **per backend**. The user selects one backend as active; the app connects to it over HTTP/SSE. The last-connected backend is remembered and auto-connected on startup. The registry is capped at **`MAX_BACKENDS = 5`** backends (enforced in `upsertBackend`, surfaced in the UI as `n/5`); editing an existing backend is never capped. QR/camera scanning is not supported because Even Hub plugin WebViews do not expose phone camera APIs. Existing single-backend installs are auto-imported into the registry on upgrade (one named backend, set active).
2. **Boot**: Phone UI fetches available agents and their supported models from Backend. Backend performs an availability scan (`command -v`) to return `{ id, available }` for each agent.
3. **Agent Selection (Glasses)**: User selects an agent -> Frontend requests `listSessions(provider)` -> displays New Session + recent sessions. Unavailable agents are displayed but visually grayed out on the Phone UI and disabled.
4. **Session View (Glasses)**: User selects session -> Frontend requests `getHistory(sessionId)` -> populates up to 50 messages.
5. **Message Send (Glasses)**:
   - Tap -> Start recording audio.
   - Tap -> Stop recording -> send audio chunks to STT endpoint.
   - Transcribed text shown for confirmation.
   - Tap -> send to Backend (`POST /api/prompt` with provider, sessionId, text).
   - Frontend listens to SSE for `text_delta` and updates `screenModel`.
6. **Status/Error Polling**: The controller polls `/api/status` and `/api/history` for active/background sessions. Provider-reported errors surface in the glasses footer; the controller does not synthesize a transient error while backend history is merely catching up to optimistic local messages.

## Security
- **Authentication**: `X-AgentHome-Auth` header with encrypted payload containing the secure token.
- **Credentials**: The active backend's URL/token are stored in Even Hub bridge storage (inside the `backends` registry; `localStorage` is a dev fallback). Agent/STT/provider secrets remain on the backend. Encrypted request/response bodies use the bridge token-derived AES-GCM wire format.
