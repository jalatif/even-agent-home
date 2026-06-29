# AgentHome UI Invariants

This document outlines the strict UI rendering and layout invariants for the AgentHome glasses app, required for Even Hub SDK compliance and structural validation.

## 1. Layout Contract
The display is constrained to `576x288` pixels. Container limits are strict:

| Region         | Container               | Byte Limit | Visible Rows       | Purpose & Layout |
|----------------|-------------------------|------------|--------------------|------------------|
| `title`        | `TextContainerProperty` | 120        | 1-2                | Top bar, full width |
| `sidebar`      | `TextContainerProperty` | 999        | ~7                 | Left sidebar (focus: panel) |
| `sidebarList`  | `ListContainerProperty` | n/a        | ~7                 | Left sidebar (focus: sidebar) |
| `panelBody`    | `TextContainerProperty` | 999        | up to 12 compact   | Main content area |
| `panelFooter`  | `TextContainerProperty` | 120        | 1-2                | Bottom controls guide |

## 2. Container ID Contract
Container IDs must be globally unique across all element types in a render frame to prevent silent drops by the firmware.

| ID | Container         | Type | Active Condition |
|----|-------------------|------|------------------|
| 1  | `title`           | Text | Always |
| 4  | `footer`          | Text | Always |
| 5  | `sidebarText`     | Text | Active when `focus === 'panel'` |
| 6  | `panelBody`       | Text | Always |
| 8  | `sidebarList`     | List | Active when `focus === 'sidebar'` |

**Constraint**: If ID 8 (List) is rendered and active, ID 5 (Text) must NOT be present in the `textObject` array with sidebar content, and vice versa.

## 3. Screen State Invariants

### Agent Selection (`sidebar.agents`)
- **Focus**: `sidebar`
- **sidebarList**: Contains enabled agents (claude, codex, oh-my-pi, etc.). Marker matches `selectedAgentIndex`.
- **panelBody**: Empty or contains brief description of the highlighted agent.
- **panelFooter**: `Swipe agent | Press open | Double click sleep`

### Session List (`sidebar.sessions`)
- **Focus**: `sidebar`
- **sidebarList**: 
  - Index 0: `Create New Session`
  - Index 1..N: Non-empty session titles.
- **panelBody**: Contains summary of the selected session, or "Start a new conversation" if Index 0.
- **panelFooter**: `Swipe session | Press open | Double click back`

### Session View (`sidebar.messages`)
- **Focus**: `panel`
- **Layout**: Full width (sidebar hidden/empty) or right-panel dominant.
- **panelBody**: Contains concatenated messages. Byte size strictly <= 999. Because the physical G2 display truncates text from the bottom if it exceeds its physical rendering capacity, text **MUST be manually line-wrapped to ~64 characters** and sliced to a strict maximum of **6 logical lines**. Bounding the output to 6 lines guarantees the chunk safely fits the physical hardware window without colliding with the footer, and perfectly suppresses the deceptive EvenHub simulator native scrollbar (which triggers on 7-8 lines due to minor overflow). Messages in the frontend web UI are anchored to the bottom using `margin-top: auto` allowing the scrollbar to bounce at the bottom and natively scale UP.
- **panelFooter**: Shows the current input/turn state. `Agent is working ...`
  appears only while backend status is busy. `Waiting for input | Agent Error`
  appears only for a real provider/status error or timeout; do not synthesize an
  error while local optimistic messages temporarily outnumber backend history.

### Recording (`sidebarRecording`)
- **Focus**: `panel`
- **panelBody**: Preserves last message view, overlaying recording status if necessary.
- **panelFooter**: `Click stop | Double click cancel`

### Transcribing (`sidebarTranscribing`)
- **Focus**: `panel`
- **panelBody**: "Converting voice..."
- **panelFooter**: (Empty or "Please wait")

### Confirm (`sidebarConfirm`)
- **Focus**: `messages`
- **panelBody**: Contains the transcribed text, followed by `> Send` and `  Cancel`.
- **panelFooter**: `Swipe select | Press confirm`

## 4. Rendering Invariants
- **Partial vs. Full Rendering**: `rebuildPageContainer` is slow and blocks the Flutter main thread for several seconds in the EvenHub Simulator. **It MUST ONLY be used for full screen transitions** (e.g., from `sidebar.agents` to `sidebar.sessions`). High-frequency events (like 500ms animation loops for busy sessions, auto-scrolling updates, or manual swipe scrolling) MUST use `enqueueSidebarPanel` (which maps to `textContainerUpgrade`). Falling back to `rebuildPageContainer` for high-frequency events will permanently hang the simulator UI thread and cause all hardware inputs to be ignored.

## 5. Input Coalescing Invariants
- Duplicate `press` within 90ms must be suppressed.
- `press` within 30ms of `doublePress` must be suppressed.
- Rapid `swipeUp/swipeDown` (<30ms apart) must be suppressed to prevent overshoot.

## 6. Phone Settings Invariants (Multi-Backend)
These concern the phone (React DOM) Settings UI, not the glasses render model.

- **Backends section is present** at the top of Settings, listing every
  connected backend by name + URL/port. Exactly one row is the **active**
  backend, shown with a filled dot `●` and an `[active]` chip; inactive rows use
  a hollow dot `○`.
- **Active backend drives all other settings.** The Agent Configuration card
  and the app-preferences card (auto-scroll, scroll speed, yolo, debug) always
  reflect the **active** backend's stored slice; switching backends must
  re-populate these before the user can edit them.
- **No standalone Backend URL/Token fields** outside the Connect/Edit modal.
  Connection config lives only in the modal (the legacy "Backend Configuration"
  card is removed).
- **Connect/Edit modal** is a single centered overlay with Name + Connection +
  Token fields and `[Test] [Cancel] [Connect/Save]` actions. The Connection
  field accepts a full `?token=` URL (auto-split) **or** plain `host:port`.
- **Empty state:** if the registry has no backends, Settings shows a prominent
  "No backends connected — Connect your first backend" CTA and the glasses show
  the "please configure" empty state.
- **Switch atomicity:** selecting a non-active backend immediately activates it
  and re-boots the controller; there is no separate confirm step and no
  half-applied state (the active view never lags behind `activeBackendId`).
