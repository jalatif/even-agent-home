/**
 * Pure helpers for backend-config decisions, extracted so they can be unit
 * tested without a React component harness (the repo has no React testing
 * infrastructure). Keep these free of side effects and React imports.
 */

export interface BackendConfigFields {
  baseUrl?: string
  token?: string
}

/**
 * Returns true when a backend config has both a non-empty baseUrl and token.
 * Used by App.tsx to decide whether to refresh the settings agents/models list
 * after hydration: if there's no usable config, the refresh would fail
 * silently (getAgents throws) and there's nothing to populate, so we skip the
 * nonce bump and wait for the user to Save settings.
 */
export function isBackendConfigured(config: BackendConfigFields | null | undefined): boolean {
  if (!config) return false
  return Boolean(config.baseUrl?.trim() && config.token?.trim())
}

/**
 * Render a backend model id as a human-friendly display name.
 *
 * Strips a trailing `@<suffix>` (a dated/default qualifier some providers need
 * on the wire, e.g. antigravity's `claude-opus-4-8@default`) BEFORE matching
 * the claude name pattern. Without this, the claude regex's `(?:-.*)?` tail
 * swallowed the minor version together with `@default`, collapsing
 * `claude-opus-4-6/7/8@default` to all display as "Opus 4". The underlying id
 * is still used as the <option value>; this is display-only.
 */
export function formatModelName(m: string): string {
  if (m === '') return 'Default'

  const display = m.split('@')[0]

  // Modern claude model names (claude-opus-4-5, claude-sonnet-4-6, …).
  if (display.startsWith('claude-')) {
    const match = display.match(/^claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?(?:-.*)?$/i);
    if (match) {
      const type = match[1].charAt(0).toUpperCase() + match[1].slice(1);
      const major = match[2];
      const minor = match[3];
      return `${type} ${major}${minor ? `.${minor}` : ''}`;
    }
  }

  if (display.startsWith('gpt-4o')) return 'GPT-4o'
  if (display === 'gpt-4-turbo') return 'GPT-4 Turbo'
  if (display === 'gpt-4') return 'GPT-4'
  return display.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

/**
 * Reconcile backend-poll history with the local optimistic messages so the
 * user always sees the clean text they typed, never a provider-rewritten blob.
 *
 * When openclaw resumes a session that already has history, it wraps the new
 * user prompt on disk as:
 *   "[Chat messages since your last reply - for context] User: ... Assistant:
 *    ... [Current message - respond to this] User: <what you actually typed>"
 * The backend poll therefore returns that whole blob as the user message,
 * while the controller holds the clean optimistic text. Without reconciliation
 * the poll's blind replace swaps the clean message for the blob — the user's
 * message looks mangled or "gone" once the reply lands.
 *
 * Strategy: align the two lists from the end (newest first, since the turn in
 * flight is always the tail). Where a local user message has a clean body that
 * appears as the trailing "User: <text>" of a wrapped backend user message,
 * substitute the clean body into the backend list. We only ever rewrite a
 * wrapped blob to its clean form — we never invent or drop messages — so the
 * total count and order follow the (authoritative) backend list.
 */
export interface ChatMessage {
  role: string
  text: string
}

const WRAPPED_USER_RE = /\[Current message(?:[^\]]*)?\]\s*User:\s*(.*)$/s

export function reconcileWrappedUserMessages(
  backend: ChatMessage[],
  local: ChatMessage[],
): ChatMessage[] {
  if (!backend.length || !local.length) return backend

  // Walk both lists from the end. The optimistic user message is the most
  // recent local user message; match it against the most recent backend user
  // message that is a wrapped blob.
  let li = local.length - 1
  let bi = backend.length - 1
  const result = backend.map((m) => ({ ...m }))
  let changed = false

  while (li >= 0 && bi >= 0) {
    const lMsg = local[li]
    const bMsg = result[bi]
    if (lMsg.role !== 'user' || bMsg.role !== 'user') {
      // Keep the lists roughly aligned: advance whichever side isn't a user msg.
      if (lMsg.role !== 'user') li--
      else bi--
      continue
    }
    const match = bMsg.text.match(WRAPPED_USER_RE)
    if (match) {
      const clean = match[1].trim()
      // Only substitute when the wrapped tail actually equals the local clean
      // text — guards against coincidental "[Current message]" strings.
      if (clean && clean === lMsg.text.trim()) {
        result[bi] = { role: 'user', text: lMsg.text }
        changed = true
      }
    }
    li--
    bi--
  }
  return changed ? result : backend
}
