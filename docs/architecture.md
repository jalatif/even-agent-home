# AgentHome Architecture

## Overview
AgentHome is an Even Realities G2 glasses application that unifies access to multiple AI agents (claude, codex, oh-my-pi, antigravity, pi, opencode, hermes, claudely) through a single backend service. It allows users to browse agents, create new sessions, resume existing sessions, and send voice-transcribed messages directly from the glasses.

## Architecture Components

### 1. Glasses Frontend (Even Realities SDK)
- **Framework**: React / Vite (following Even-Telegram structure).
- **Target Environments**:
  - Glasses UI: Renders `screenModel` using `@evenrealities/even_hub_sdk`. Uses `rebuildPageContainer` for full screen transitions and `textContainerUpgrade` (via `enqueueSidebarPanel`) for high-frequency partial renders (animations, scrolling) to prevent main-thread UI freezing.
  - Phone UI: React DOM application for initial pairing, configuration, and agent toggle settings.
- **State Management**: Shared controller maintaining finite state machine for screens (Pairing, Agent Selection, Session List, Chat/Message View, Recording, Transcribing, Confirmation).
- **Network**: Connects to the single unified backend over HTTP/SSE. Stores pairing details (URL, Secure Token) in phone `localStorage`.

### 2. Unified Backend Service
- **Framework**: Node.js (Express / Fastify) or Python (FastAPI), acting as a unified proxy and session manager.
- **Provider Adapters**: Extends the `agent-home` provider pattern but manages all providers in a single server instance.
  - Implements uniform interfaces: `listSessions`, `getHistory`, `prompt`, `getStatus`, `getModels`.
- **Session Management**: 
  - Keeps track of `phoneSessionId -> providerSessionId` mappings for all providers.
  - Filters out empty sessions.
- **STT Service**: Exposes an endpoint for speech-to-text processing (using local Whisper or delegating to the provided STT override URL).
- **Streaming**: Exposes unified SSE (Server-Sent Events) endpoint for real-time `text_delta`, `tool_start`, `tool_end`, and `result` streams.

## Data Flow

1. **Pairing**: Phone UI prompts for Backend URL and Secure Token. Phone establishes SSE connection.
2. **Boot**: Phone UI fetches available agents and their supported models from Backend. Backend performs an availability scan (`command -v`) to return `{ id, available }` for each agent.
3. **Agent Selection (Glasses)**: User selects an agent -> Frontend requests `listSessions(provider)` -> displays New Session + recent sessions. Unavailable agents are displayed but visually grayed out on the Phone UI and disabled.
4. **Session View (Glasses)**: User selects session -> Frontend requests `getHistory(sessionId)` -> populates up to 50 messages.
5. **Message Send (Glasses)**:
   - Tap -> Start recording audio.
   - Tap -> Stop recording -> send audio chunks to STT endpoint.
   - Transcribed text shown for confirmation.
   - Tap -> send to Backend (`POST /api/prompt` with provider, sessionId, text).
   - Frontend listens to SSE for `text_delta` and updates `screenModel`.

## Security
- **Authentication**: `X-AgentHome-Auth` header with encrypted payload containing the secure token.
- **Credentials**: Stored only in phone `localStorage`, never sent unencrypted.
