import { test } from 'node:test'
import assert from 'node:assert/strict'

const { isBackendConfigured } = await import('../src/configHelpers.ts')

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
