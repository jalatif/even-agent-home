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

// ---- Migration + hydration tests ----

import {
  migrateLegacy,
  makeBackendId,
  hydrateBackends,
  __resetBackendsStateForTests,
  getRegistry,
} from '../src/backends.ts'
import { registerBridgeStorage } from '../src/storage.ts'

type WindowStorage = {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
  clear(): void
}
type MutableWindow = { localStorage: WindowStorage }

function makeStorage(): WindowStorage {
  const store = new Map<string, string>()
  return {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => { store.set(k, v) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
  }
}

function installWindow(): WindowStorage {
  const w: MutableWindow = { localStorage: makeStorage() }
  ;(globalThis as { window?: MutableWindow }).window = w
  return w.localStorage
}

function clearBridge() {
  registerBridgeStorage(() => null)
}

test('makeBackendId: returns a non-empty unique-ish string', () => {
  const a = makeBackendId()
  const b = makeBackendId()
  assert.ok(typeof a === 'string' && a.length > 0)
  assert.notEqual(a, b, 'two ids should differ')
})

test('migrateLegacy: usable legacy -> one named backend, set active', () => {
  const reg = migrateLegacy(
    JSON.stringify({
      baseUrl: 'http://192.168.1.5:8765',
      token: 'tok',
      yolo: true,
      debugView: false,
      autoScrollLastExchange: false,
      scrollSpeed: 'fast',
    }),
    JSON.stringify({ claude: { enabled: true, model: 'claude-opus-4-8' } }),
  )
  assert.equal(reg.backends.length, 1)
  const b = reg.backends[0]
  assert.equal(b.baseUrl, 'http://192.168.1.5:8765')
  assert.equal(b.token, 'tok')
  assert.equal(b.name, '192.168.1.5:8765')
  assert.equal(b.prefs.yolo, true)
  assert.equal(b.prefs.scrollSpeed, 'fast')
  assert.deepEqual(b.agentConfigs, { claude: { enabled: true, model: 'claude-opus-4-8' } })
  assert.equal(reg.activeBackendId, b.id)
  assert.deepEqual(reg.recentBackendIds, [b.id])
})

test('migrateLegacy: missing token -> empty registry, no active', () => {
  const reg = migrateLegacy(JSON.stringify({ baseUrl: 'http://x:1', token: '' }), null)
  assert.equal(reg.backends.length, 0)
  assert.equal(reg.activeBackendId, null)
})

test('migrateLegacy: no legacy at all -> empty registry', () => {
  const reg = migrateLegacy(null, null)
  assert.equal(reg.backends.length, 0)
  assert.equal(reg.activeBackendId, null)
})

test('migrateLegacy: corrupt legacy JSON -> empty registry', () => {
  const reg = migrateLegacy('{not json', '{"also not')
  assert.equal(reg.backends.length, 0)
})

test('hydrateBackends: empty store + no legacy -> empty registry', async () => {
  __resetBackendsStateForTests()
  installWindow()
  clearBridge()
  const reg = await hydrateBackends()
  assert.equal(reg.backends.length, 0)
  assert.equal(reg.activeBackendId, null)
})

test('hydrateBackends: migrates legacy into a named backend and persists it', async () => {
  __resetBackendsStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('apiConfig', JSON.stringify({ baseUrl: 'http://h:1', token: 't' }))
  store.setItem('agentConfigs', JSON.stringify({ codex: { enabled: true, model: 'gpt-5.5' } }))

  const reg = await hydrateBackends()
  assert.equal(reg.backends.length, 1)
  assert.equal(reg.backends[0].baseUrl, 'http://h:1')
  assert.equal(reg.activeBackendId, reg.backends[0].id)
  // Persisted under the new key...
  assert.ok(store.getItem('backends'), 'registry should be persisted')
  // ...and legacy keys are LEFT in place (rollback path), untouched.
  assert.ok(store.getItem('apiConfig'))
  assert.ok(store.getItem('agentConfigs'))
})

test('hydrateBackends: idempotent — re-hydrate does not re-migrate or duplicate', async () => {
  __resetBackendsStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('apiConfig', JSON.stringify({ baseUrl: 'http://h:1', token: 't' }))

  const first = await hydrateBackends()
  assert.equal(first.backends.length, 1)
  // Second hydrate without force returns the cache unchanged.
  const second = await hydrateBackends()
  assert.equal(second.backends.length, 1)
  assert.equal(second.backends[0].id, first.backends[0].id)
})

test('hydrateBackends: force=true re-reads after initial empty hydrate', async () => {
  __resetBackendsStateForTests()
  const store = installWindow()
  clearBridge()
  // First hydrate: nothing in storage -> empty.
  let reg = await hydrateBackends()
  assert.equal(reg.backends.length, 0)
  // Later (simulating the EvenHub bridge KV becoming available) the durable
  // store is populated. Without force, the cached empty registry would win and
  // the real connection would never load — the "re-open app lost connection"
  // regression.
  store.setItem('backends', JSON.stringify({
    version: 1,
    backends: [{ id: 'x', name: 'X', baseUrl: 'http://bridge:9', token: 'bt', prefs: {}, agentConfigs: {} }],
    activeBackendId: 'x',
    recentBackendIds: ['x'],
  }))
  reg = await hydrateBackends(true)
  assert.equal(reg.backends.length, 1)
  assert.equal(reg.backends[0].baseUrl, 'http://bridge:9')
  // Non-force returns the cache now.
  assert.equal((await hydrateBackends()).backends[0].baseUrl, 'http://bridge:9')
})

test('getRegistry: returns cache and kicks off async hydrate when not hydrated', async () => {
  __resetBackendsStateForTests()
  installWindow()
  clearBridge()
  // Sync read before hydration returns the empty cache...
  assert.equal(getRegistry().backends.length, 0)
  // ...but a hydration is now in flight; await a microtask tick.
  await new Promise((r) => setTimeout(r, 0))
  // After hydration the cache reflects storage (empty here).
  assert.equal(getRegistry().backends.length, 0)
})
