import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isBackendConfigured, formatModelName, reconcileWrappedUserMessages } = await import('../src/configHelpers.ts')
type ChatMessage = { role: string; text: string }

// These tests pin the predicate that gates the App.tsx agentRefreshNonce bump
// after hydration: the settings agents/models list should only be refreshed
// once a usable backend config (baseUrl + token) exists, otherwise the refresh
// fires with empty config and getAgents() fails silently — the original
// "settings UI empty until Save" bug.

test('isBackendConfigured: false when baseUrl or token missing/blank', () => {
  assert.equal(isBackendConfigured(null), false)
  assert.equal(isBackendConfigured(undefined), false)
  assert.equal(isBackendConfigured({}), false)
  assert.equal(isBackendConfigured({ baseUrl: 'http://x' }), false)
  assert.equal(isBackendConfigured({ token: 't' }), false)
  assert.equal(isBackendConfigured({ baseUrl: '   ', token: 't' }), false)
  assert.equal(isBackendConfigured({ baseUrl: 'http://x', token: '  ' }), false)
})

test('isBackendConfigured: true when both baseUrl and token are non-empty', () => {
  assert.equal(isBackendConfigured({ baseUrl: 'http://backend.test', token: 'tok' }), true)
  assert.equal(isBackendConfigured({ baseUrl: 'http://backend.test', token: 'tok', autoScrollLastExchange: true }), true)
})

test('isBackendConfigured: trims whitespace before checking emptiness', () => {
  // A whitespace-only field must NOT count as configured.
  assert.equal(isBackendConfigured({ baseUrl: '\t\n', token: 'tok' }), false)
  assert.equal(isBackendConfigured({ baseUrl: ' http://x ', token: ' t ' }), true)
})

// formatModelName must strip a trailing @<suffix> BEFORE matching the claude
// pattern, otherwise claude-opus-4-6/7/8@default all collapse to "Opus 4".

test('formatModelName: strips @suffix before matching claude pattern', () => {
  assert.equal(formatModelName('claude-opus-4-8@default'), 'Opus 4.8')
  assert.equal(formatModelName('claude-sonnet-4-6'), 'Sonnet 4.6')
  assert.equal(formatModelName('gemini-3.5-flash'), 'Gemini 3.5 Flash')
})

// ── reconcileWrappedUserMessages ──────────────────────────────────────────
//
// openclaw rewrites a resumed turn's user prompt on disk into a blob:
//   "[Chat messages since your last reply - for context] User: ... Assistant:
//    ... [Current message - respond to this] User: <what you actually typed>"
// The backend poll returns that blob; the controller holds the clean text.
// reconcileWrappedUserMessages substitutes the clean body back in wherever the
// blob's trailing "User: <text>" matches a local optimistic user message.

const WRAP = (clean: string) =>
  `[Chat messages since your last reply - for context] User: Yo Assistant: Yo back [Current message - respond to this] User: ${clean}`

test('reconcileWrappedUserMessages: substitutes clean user text for a wrapped blob at the tail', () => {
  const backend: ChatMessage[] = [
    { role: 'user', text: 'Yo' },
    { role: 'assistant', text: 'Yo back' },
    { role: 'user', text: WRAP('Hi') },
    { role: 'assistant', text: 'the reply' },
  ]
  const local: ChatMessage[] = [
    { role: 'user', text: 'Yo' },
    { role: 'assistant', text: 'Yo back' },
    { role: 'user', text: 'Hi' },
  ]
  const out = reconcileWrappedUserMessages(backend, local)
  assert.equal(out.length, 4, 'count follows the authoritative backend list')
  assert.equal(out[2].role, 'user')
  assert.equal(out[2].text, 'Hi', 'wrapped blob replaced with clean text')
  assert.equal(out[3].text, 'the reply', 'reply untouched')
})

test('reconcileWrappedUserMessages: no substitution when wrapped tail does not match local', () => {
  const backend: ChatMessage[] = [{ role: 'user', text: WRAP('something else') }]
  const local: ChatMessage[] = [{ role: 'user', text: 'Hi' }]
  const out = reconcileWrappedUserMessages(backend, local)
  // No match → return backend unchanged (same reference).
  assert.equal(out, backend)
})

test('reconcileWrappedUserMessages: returns backend unchanged when local has no user messages', () => {
  const backend: ChatMessage[] = [{ role: 'user', text: WRAP('Hi') }]
  const local: ChatMessage[] = [{ role: 'assistant', text: 'x' }]
  assert.equal(reconcileWrappedUserMessages(backend, local), backend)
})

test('reconcileWrappedUserMessages: returns backend unchanged when message is not wrapped', () => {
  const backend: ChatMessage[] = [{ role: 'user', text: 'plain Hi' }]
  const local: ChatMessage[] = [{ role: 'user', text: 'Hi' }]
  assert.equal(reconcileWrappedUserMessages(backend, local), backend)
})

test('reconcileWrappedUserMessages: handles empty input without throwing', () => {
  assert.deepEqual(reconcileWrappedUserMessages([], []), [])
  const backend: ChatMessage[] = [{ role: 'user', text: 'x' }]
  assert.equal(reconcileWrappedUserMessages(backend, []), backend)
})

test('reconcileWrappedUserMessages: substitutes even before the reply is flushed (streaming)', () => {
  // During streaming the reply may not be on disk yet: backend shows
  // [orig, reply, wrapped-Hi] while local holds [orig, reply, Hi].
  const backend: ChatMessage[] = [
    { role: 'user', text: 'orig' },
    { role: 'assistant', text: 'reply' },
    { role: 'user', text: WRAP('Hi') },
  ]
  const local: ChatMessage[] = [
    { role: 'user', text: 'orig' },
    { role: 'assistant', text: 'reply' },
    { role: 'user', text: 'Hi' },
  ]
  const out = reconcileWrappedUserMessages(backend, local)
  assert.equal(out[2].text, 'Hi')
  assert.equal(out.length, 3)
})
