# AgentHome Execution PRD

## Product Overview
AgentHome is a unified AI assistant app for Even Realities G2 glasses. It connects to a self-hosted backend that aggregates multiple AI providers into a single UI, allowing voice-first interaction with continuous sessions. The app supports **multiple saved backends**; one is active at a time (= last connected), and all agent config and app prefs are stored per backend.

## Core Features & Requirements

### 1. Setup & Pairing (Multi-Backend)
- **Phone UI**:
  - A **Backends** section listing all connected backends by name with their URL/port; one is marked `[active]`.
  - **Connect New Backend** modal: name + connection field + token. The connection field accepts either a full `http://host:port?token=...` URL (auto-splits URL and token) or a plain `host:port` with the token entered separately.
  - **Selecting** a non-active backend immediately activates it and re-connects (agents/models/prefs reload for that backend). The active backend's name and URL/port are surfaced in the UI.
  - **Edit** a backend (rename, change URL/port/token). **Remove** a backend (confirm; if it was active, fall back to the most-recent-other backend, else the first remaining, else empty state).
  - **Last-connected backend** is remembered and auto-connected on startup.
  - **Upgrade migration:** an existing single-backend install is auto-imported as one named backend (named after its host), set active, with all agent config + prefs preserved.
  - No QR scanner in the current client: Even Hub plugin WebViews do not expose phone camera capture.
  - STT provider selection is backend-only. The frontend always sends audio to `/api/transcribe`.
  - Per-active-backend: toggles to enable/disable specific agents (agents not available locally are grayed out and disabled); dropdown lists to select the active model for each enabled agent (data sourced from the active backend). Claude defaults to `claude-opus-4-8`; stale saved Claude model IDs that are no longer in the live model list reset to that default.
  - UI styled in dark-mode glassmorphism to match the aesthetic.

### 2. Agent Selection (Glasses)
- **First Screen**: List of enabled agents.
- **Navigation**: Double tap to toggle glasses screen on/off.
- **Selection**: Tap to select an agent, navigating to Session List.

### 3. Session List (Glasses)
- **Content**: 
  - Top item: "Create New Session".
  - Subsequent items: List of existing, non-empty sessions for the selected agent.
- **Navigation**:
  - Tap on item: Open the session.
  - Double tap: Back to Agent Selection screen.

### 4. Session View & Interaction (Glasses)
- **Content**: Scrollable view of previous messages (up to 50).
  - The view automatically pushes messages to the bottom (bounce effect) allowing the user to seamlessly scroll UP through history.
- **Navigation**: Double tap to return to Session List.
- **Interaction (Voice Reply)**:
  - Tap: Start recording audio.
  - Tap: Stop recording.
  - STT Transcription: Audio is transcribed using the configured STT service.
  - Confirmation Screen: Shows transcribed text with options to "Send" or "Cancel".
  - Action: Sending submits the text to the backend; streaming response updates the session view in real-time.

## Backend Requirements
- **Single Service**: Must handle all providers (claude, codex, oh-my-pi, antigravity, pi, opencode, hermes, openclaw) simultaneously.
- **Model Normalization**: Provider adapters must handle backwards-compatible saved model IDs. `pi` normalizes unqualified custom model aliases through `~/.pi/agent/models.json` before invoking the CLI.
- **Error Semantics**: Provider errors must surface through `/api/status.error`, but stale errors must clear after successful later turns. The frontend must not show `Agent Error` for ordinary history-catch-up races.
- **API Endpoints**:
  - `GET /api/agents`: Returns list of available agents and their models.
  - `GET /api/sessions?agent={agent}`: Returns non-empty sessions.
  - `GET /api/history?sessionId={id}`: Returns last 50 messages.
  - `POST /api/prompt`: Accepts audio/text, provider, model, and sessionId.
  - `GET /api/events`: SSE endpoint for response streaming.
  - `POST /api/transcribe`: Accepts audio for STT processing.

## Non-Functional Requirements
- **Latency**: UI transitions must occur within 1s.
- **State Preservation**: Controller must maintain accurate state across SSE reconnects.
- **Hardware Constraints**: Must strictly adhere to Even Hub SDK UI constraints (576x288, byte limits).
