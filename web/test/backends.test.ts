// Unit tests for the multi-backend registry and its pure helpers.
//
// The registry is the load-bearing layer for the four documented
// startup/storage invariants (boot-after-hydration ordering, refresh-nonce
// gate, bound bridge methods, force-rehydrate). We test the pure helpers
// first (no storage, no React), then the registry lifecycle in later tasks.

import { test } from 'node:test'
import assert from 'node:assert/strict'

const {
  normalizeConnectionInput,
  nameFromBaseUrl,
  pickFallbackBackend,
} = await import('../src/backends.ts')

test('normalizeConnectionInput: full ?token= URL splits into baseUrl + token', () => {
  const out = normalizeConnectionInput('http://192.168.1.5:8765?token=abc123')
  assert.deepEqual(out, { baseUrl: 'http://192.168.1.5:8765', token: 'abc123' })
})

test('normalizeConnectionInput: https URL preserves scheme', () => {
  const out = normalizeConnectionInput('https://box.example:8443?token=t')
  assert.deepEqual(out, { baseUrl: 'https://box.example:8443', token: 't' })
})

test('normalizeConnectionInput: bare host:port normalizes to http:// + empty token', () => {
  const out = normalizeConnectionInput('10.0.0.4:8766')
  assert.deepEqual(out, { baseUrl: 'http://10.0.0.4:8766', token: '' })
})

test('normalizeConnectionInput: bare host without port works', () => {
  const out = normalizeConnectionInput('localhost')
  assert.deepEqual(out, { baseUrl: 'http://localhost', token: '' })
})

test('normalizeConnectionInput: empty / whitespace returns null', () => {
  assert.equal(normalizeConnectionInput(''), null)
  assert.equal(normalizeConnectionInput('   '), null)
})

test('normalizeConnectionInput: prose / path-bearing input returns null', () => {
  // Should not silently turn a sentence into a baseUrl.
  assert.equal(normalizeConnectionInput('my backend at home'), null)
  assert.equal(normalizeConnectionInput('http://x/api/foo'), null)
  assert.equal(normalizeConnectionInput('not a url at all!'), null)
})

test('nameFromBaseUrl: returns host:port for a normal baseUrl', () => {
  assert.equal(nameFromBaseUrl('http://192.168.1.5:8765'), '192.168.1.5:8765')
  // Non-default port preserved (default ports like https:443 are dropped by URL,
  // which is correct; backends always use explicit ports here).
  assert.equal(nameFromBaseUrl('https://box.example:8443'), 'box.example:8443')
})

test('nameFromBaseUrl: returns "Default" for empty/unparseable input', () => {
  assert.equal(nameFromBaseUrl(''), 'Default')
  assert.equal(nameFromBaseUrl('   '), 'Default')
  assert.equal(nameFromBaseUrl('not a url'), 'Default')
})

test('pickFallbackBackend: most-recent other backend wins', () => {
  const registry = {
    version: 1 as const,
    backends: [
      { id: 'a', name: 'A', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
      { id: 'b', name: 'B', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
      { id: 'c', name: 'C', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
    ],
    activeBackendId: 'a',
    recentBackendIds: ['a', 'c', 'b'],
  }
  // removing active 'a' -> next most recent still-present is 'c'
  assert.equal(pickFallbackBackend(registry, 'a'), 'c')
})

test('pickFallbackBackend: skips removed id even if it is first in recency', () => {
  const registry = {
    version: 1 as const,
    backends: [
      { id: 'a', name: 'A', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
      { id: 'b', name: 'B', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
    ],
    activeBackendId: 'a',
    recentBackendIds: ['a', 'b'],
  }
  assert.equal(pickFallbackBackend(registry, 'a'), 'b')
})

test('pickFallbackBackend: returns null when no backends remain', () => {
  const registry = {
    version: 1 as const,
    backends: [
      { id: 'a', name: 'A', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
    ],
    activeBackendId: 'a',
    recentBackendIds: ['a'],
  }
  assert.equal(pickFallbackBackend(registry, 'a'), null)
})

test('pickFallbackBackend: falls back to first remaining when recency empty', () => {
  const registry = {
    version: 1 as const,
    backends: [
      { id: 'a', name: 'A', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
      { id: 'b', name: 'B', baseUrl: '', token: '', prefs: {}, agentConfigs: {} },
    ],
    activeBackendId: 'a',
    recentBackendIds: ['a'], // b not in recency
  }
  assert.equal(pickFallbackBackend(registry, 'a'), 'b')
})
