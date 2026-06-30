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

// ---- Registry mutation op tests ----

import {
  upsertBackend,
  saveBackend,
  setActiveBackend,
  clearActiveBackend,
  removeBackend,
  getActiveBackend,
  getBackendsList,
  getBackendsCount,
  getBackend,
  MAX_BACKENDS,
} from '../src/backends.ts'

// Helper: hydrate an empty registry into a known cache state for op tests.
async function seedRegistry(backends: Array<Partial<import('../src/backends.ts').Backend>>): Promise<void> {
  __resetBackendsStateForTests()
  installWindow()
  clearBridge()
  await hydrateBackends() // empty
  for (const b of backends) {
    await upsertBackend({
      name: b.name ?? 'B',
      baseUrl: b.baseUrl ?? 'http://x:1',
      token: b.token ?? 't',
      prefs: b.prefs ?? {},
      agentConfigs: b.agentConfigs ?? {},
    })
  }
}

test('upsertBackend: new backend gets an id and is appended', async () => {
  await seedRegistry([])
  const b = await upsertBackend({ name: 'A', baseUrl: 'http://a:1', token: 't', prefs: {}, agentConfigs: {} })
  assert.ok(b.id)
  assert.equal(getBackendsList().length, 1)
})

test('upsertBackend: update existing preserves id', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }])
  const a = getBackendsList()[0]
  const updated = await upsertBackend({ id: a.id, name: 'A2', baseUrl: 'http://a:2', token: 't2', prefs: {}, agentConfigs: {} })
  assert.equal(updated.id, a.id)
  assert.equal(updated.name, 'A2')
  assert.equal(updated.baseUrl, 'http://a:2')
})

test('setActiveBackend: flips active, moves to front of recency, calls hook', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }])
  const [a, b] = getBackendsList()
  let hookCalls = 0
  // Make A active first.
  await setActiveBackend(a.id, () => { hookCalls++ })
  assert.equal(getActiveBackend()?.id, a.id)
  // Switch to B -> hook fires (active changed).
  const changed = await setActiveBackend(b.id, () => { hookCalls++ })
  assert.equal(changed, true)
  assert.equal(getActiveBackend()?.id, b.id)
  // Ordering is STABLE (insertion order) — selecting a backend as active must
  // NOT reorder the list. A is still first even though B is now active.
  assert.equal(getBackendsList()[0].id, a.id, 'list order must not change on active switch')
  assert.equal(getBackendsList()[1].id, b.id)
  // Switch to B again -> no change, hook must NOT fire.
  const changed2 = await setActiveBackend(b.id, () => { hookCalls++ })
  assert.equal(changed2, false)
  // 2 hook calls: A-set (first switch) + B-set. The re-set of B did not add a call.
  assert.equal(hookCalls, 2)
})

test('setActiveBackend: no-op returns false for unknown id', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }])
  const changed = await setActiveBackend('does-not-exist')
  assert.equal(changed, false)
})

test('saveBackend: partial patch merges without clobbering untouched fields', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1', prefs: { yolo: true, debugView: false } }])
  const a = getBackendsList()[0]
  await saveBackend(a.id, { prefs: { yolo: false } })
  const after = getBackend(a.id)!
  assert.equal(after.prefs.yolo, false)
  assert.equal(after.name, 'A', 'untouched name preserved')
  assert.equal(after.baseUrl, 'http://a:1', 'untouched baseUrl preserved')
})

test('saveBackend: no-op for unknown id', async () => {
  await seedRegistry([])
  await saveBackend('nope', { name: 'X' })
  assert.equal(getBackendsList().length, 0)
})

test('removeBackend: non-active removal leaves active unchanged', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }])
  const [a, b] = getBackendsList()
  await setActiveBackend(a.id)
  const res = await removeBackend(b.id)
  assert.equal(res.activeChanged, false)
  assert.equal(getActiveBackend()?.id, a.id)
  assert.equal(getBackendsList().length, 1)
})

test('removeBackend: active removal falls back to most-recent other', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }, { name: 'C', baseUrl: 'http://c:1' }])
  const [a, b, c] = getBackendsList()
  // Recency order: a (most recent), then c, then b.
  await setActiveBackend(a.id)
  await setActiveBackend(b.id)
  await setActiveBackend(c.id)
  await setActiveBackend(a.id) // a most-recent, then c, then b
  // Remove the active 'a' -> fallback should be 'c' (next most recent).
  const res = await removeBackend(a.id)
  assert.equal(res.activeChanged, true)
  assert.equal(res.fallbackId, c.id)
  assert.equal(getActiveBackend()?.id, c.id)
})

test('removeBackend: last backend removal yields empty registry, null active', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }])
  const a = getBackendsList()[0]
  await setActiveBackend(a.id)
  const res = await removeBackend(a.id)
  assert.equal(res.activeChanged, true)
  assert.equal(res.fallbackId, null)
  assert.equal(getActiveBackend(), null)
  assert.equal(getBackendsList().length, 0)
})

// ---- clearActiveBackend (Stop) + count/max + stable ordering ----

test('clearActiveBackend: clears active without removing any backend', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }])
  const [a] = getBackendsList()
  await setActiveBackend(a.id)
  assert.equal(getActiveBackend()?.id, a.id)
  // Stop: active is cleared but both backends are still saved.
  const changed = await clearActiveBackend(() => {})
  assert.equal(changed, true)
  assert.equal(getActiveBackend(), null)
  assert.equal(getBackendsList().length, 2, 'backends must NOT be removed on stop')
  // getBackendsCount reflects saved (not active) backends.
  assert.equal(getBackendsCount(), 2)
})

test('clearActiveBackend: returns false when nothing is active', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }])
  // Nothing activated yet -> clear is a no-op.
  const changed = await clearActiveBackend(() => {})
  assert.equal(changed, false)
  assert.equal(getActiveBackend(), null)
})

test('clearActiveBackend then re-select restores the backend as active', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }])
  const [a] = getBackendsList()
  await setActiveBackend(a.id)
  await clearActiveBackend(() => {})
  assert.equal(getActiveBackend(), null)
  // Re-selecting the same backend re-activates it.
  await setActiveBackend(a.id)
  assert.equal(getActiveBackend()?.id, a.id)
})

test('getBackendsCount counts saved backends regardless of active', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }])
  assert.equal(getBackendsCount(), 2)
  await setActiveBackend(getBackendsList()[0].id)
  assert.equal(getBackendsCount(), 2)
  await clearActiveBackend(() => {})
  assert.equal(getBackendsCount(), 2)
})

test('MAX_BACKENDS is 5', () => {
  assert.equal(MAX_BACKENDS, 5)
})

test('upsertBackend rejects a NEW backend beyond MAX_BACKENDS', async () => {
  // The cap must be enforced in the registry, not just in the UI — otherwise
  // the deep-link connect path (and any future programmatic caller) can
  // silently exceed the limit. Editing an existing backend is never capped.
  await seedRegistry([
    { name: 'A', baseUrl: 'http://a:1' },
    { name: 'B', baseUrl: 'http://b:1' },
    { name: 'C', baseUrl: 'http://c:1' },
    { name: 'D', baseUrl: 'http://d:1' },
    { name: 'E', baseUrl: 'http://e:1' },
  ])
  assert.equal(getBackendsCount(), MAX_BACKENDS)

  // A 6th NEW backend must be rejected.
  await assert.rejects(
    upsertBackend({ name: 'F', baseUrl: 'http://f:1', token: 't', prefs: {}, agentConfigs: {} }),
    /maximum of 5 backends/,
  )
  assert.equal(getBackendsCount(), MAX_BACKENDS, 'no backend was added past the cap')

  // Editing an existing backend by id is never capped.
  const [a] = getBackendsList()
  const edited = await upsertBackend({ id: a.id, name: 'A-renamed', baseUrl: 'http://a:2', token: 't', prefs: {}, agentConfigs: {} })
  assert.equal(edited.name, 'A-renamed')
  assert.equal(getBackendsCount(), MAX_BACKENDS, 'edit does not add a backend')
})

test('getBackendsList keeps stable insertion order across active switches', async () => {
  await seedRegistry([{ name: 'A', baseUrl: 'http://a:1' }, { name: 'B', baseUrl: 'http://b:1' }, { name: 'C', baseUrl: 'http://c:1' }])
  const [a, b, c] = getBackendsList()
  // Activate in a non-insertion order; list order must not move.
  await setActiveBackend(c.id)
  await setActiveBackend(a.id)
  await setActiveBackend(b.id)
  const list = getBackendsList().map((x) => x.id)
  assert.deepEqual(list, [a.id, b.id, c.id], 'insertion order must be preserved')
})
