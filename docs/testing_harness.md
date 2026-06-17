# AgentHome Testing Harness

## Overview
The testing harness ensures structural and visual invariants using the Even Hub Simulator (`@evenrealities/evenhub-simulator`). It uses a state-machine driven flow test to simulate sequences of hardware events (`press`, `doublePress`, `swipeUp`, `swipeDown`) and validates the resulting `render` events.

## Methodology
- Uses a simulated bridge connecting the app controller to `evenhub-simulator`.
- Sends inputs sequentially with explicit latency budgets.
- Captures the structured render model (`TextContainerProperty`, `ListContainerProperty`) pushed to the SDK.
- Diff-checks the rendered objects against baseline JSON goldens (no physical image matching required due to simulator limitations, strictly DOM/Render model validation).

## Test Fixtures & Mocking
The harness runs against the unified backend in **fixture mode**:
- `/api/agents` dynamically checks agent binaries and returns `{id, available}` mapped schemas.
- `/api/sessions` returns predefined sessions (ensure no empty sessions are returned).
- `POST /api/prompt` and `POST /api/transcribe` return predictable strings without triggering real STT or LLM latency.

## Execution Flow (The Catalog)

| Step | Interaction | Expected State Transition | Render Validation |
|------|-------------|---------------------------|-------------------|
| 00 | Boot / Start | `loading` | "Starting..." in body |
| 01 | Wait | `sidebar.agents` | List of agents on left |
| 02 | `swipeDown` | `sidebar.agents` | Marker moves to Agent 2 |
| 03 | `press` | `sidebar.sessions` | "Create New Session" at top of list |
| 04 | `swipeDown` | `sidebar.sessions` | Marker moves to an existing session |
| 05 | `press` | `sidebar.messages` | Full width chat view, messages loaded |
| 06 | `swipeUp` | `sidebar.messages` | Older messages page loaded |
| 07 | `press` | `sidebarRecording` | "Recording" footer appears |
| 08 | `audioChunk` | `sidebarRecording` | State accumulates chunks |
| 09 | `press` | `sidebarTranscribing`| "Converting voice..." appears |
| 10 | Wait | `sidebarConfirm` | Transcript text shown with Send/Cancel |
| 11 | `press` | `sidebarSending` -> `sidebar.messages` | Message added, backend called |
| 12 | `doublePress` | `sidebar.sessions` | Returns to session list |
| 13 | `doublePress` | `sidebar.agents` | Returns to agent list |
| 14 | `doublePress` | `asleep` | Screen toggle off |
| 15 | `doublePress` | `sidebar.agents` | Screen toggle on |

## Strict Latency Assertions
The harness validates every action against timing budgets:
- `maxTransitionMs` (1000ms): `press`/`doublePress` to next rendered screen.
- `maxSwipeSelectionMs` (50ms): Swipe action to sidebar marker update.
- `maxSendRoundtripMs` (2000ms): Send confirmation to message appended locally.

## Structural Validation
The testing harness asserts specific state machine invariants on every transition:
- **Layout Compliance**: Rejects titles > 120 bytes, bodies > 999 bytes.
- **Render Typology**: Asserts that `textContainerUpgrade` (via partial render) is emitted instead of `rebuildPageContainer` for rapid state updates (animations, scrolling) to prevent main-thread hangs.
- **Agent Array**: Validates that the loaded agents array maintains specific constraints mapping to the availability status returned by the backend API.
- **Scroll Bounds**: Explicitly validates that `scrollOffset` does not become negative or undefined during manual UI swipes in the `.glasses-messages` layout.

## Execution
Run tests locally without hardware:
```bash
npm run test:simulator --prefix web
```
