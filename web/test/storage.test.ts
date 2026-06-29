// Unit tests for the persistent storage layer.
//
// We exercise the production bug fix:
//   1. The storage adapter prefers a registered bridge-backed store
//      (`registerBridgeStorage`) over `window.localStorage` so the phone
//      WebView's reload/clear cycle does not wipe user settings.
//   2. The `localStorage` fallback is used when no bridge is registered,
//      so browser dev still works.
//   3. `hydrateApiConfig` preserves saved fields (yolo, debug, scroll
//      prefs) when the URL carries a deep-link token — URL params only
//      overlay the fields they actually carry.
//   4. The legacy `autoScrollMode` field is migrated into the new
//      `autoScrollLastExchange` + `scrollSpeed` shape on read.

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  registerBridgeStorage,
  resolveStorage,
  storageGet,
  storageSet,
} from '../src/storage.ts'
import {
  hydrateApiConfig,
  setApiConfig,
  saveAgentConfigs,
  getApiConfig,
  refreshActiveConfigView,
  __resetApiStateForTests,
} from '../src/api.ts'
import {
  hydrateBackends,
  upsertBackend,
  setActiveBackend,
  getActiveBackend,
  __resetBackendsStateForTests,
} from '../src/backends.ts'

type WindowStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear(): void
}

type MutableWindow = {
  localStorage: WindowStorage
  location: { search: string; protocol: string; host: string; port: string }
  history?: { replaceState: (state: unknown, title: string, url: string) => void }
}

function makeStorage(): WindowStorage {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
    removeItem: (k: string) => {
      store.delete(k)
    },
    clear: () => {
      store.clear()
    },
  }
}

// Per-test window with a fresh in-memory `localStorage` shim and a
// benign default `location`. `configFromLocation` reads `search` for
// deep-link params; port 80 keeps it a plain non-dev origin.
function installWindow(): WindowStorage {
  const w: MutableWindow = {
    localStorage: makeStorage(),
    location: { search: '', protocol: 'http:', host: 'localhost', port: '80' },
  }
  ;(globalThis as { window?: MutableWindow }).window = w
  return w.localStorage
}

// Disable any bridge registered by a previous test so the localStorage
// fallback is selected. Production code always supplies a real provider
// (or registers one later); in tests we use a `() => null` provider to
// unambiguously pick the fallback.
function clearBridge() {
  registerBridgeStorage(() => null)
}

test('resolveStorage returns the localStorage fallback when no bridge is registered', () => {
  installWindow()
  clearBridge()
  const s = resolveStorage()
  assert.ok(s, 'expected a storage implementation')
})

test('registerBridgeStorage takes priority over localStorage', async () => {
  const local = installWindow()
  const bridgeStore = new Map<string, string>()
  registerBridgeStorage(() => ({
    async getItem(key) {
      return bridgeStore.get(key) ?? null
    },
    async setItem(key, value) {
      bridgeStore.set(key, value)
    },
  }))
  await storageSet('ping', 'pong')
  const v = await storageGet('ping')
  assert.equal(v, 'pong')
  assert.equal(bridgeStore.get('ping'), 'pong')
  // Phone-bug regression: when a bridge is registered we must NOT fall
  // through to `window.localStorage`, because the host app clears WebView
  // localStorage on relaunch and would wipe user settings.
  assert.equal(local.getItem('ping'), null, 'bridge path must not touch localStorage')
})

test('localStorage fallback persists across calls when no bridge is registered', async () => {
  const store = installWindow()
  clearBridge()
  await storageSet('plainKey', 'plainValue')
  assert.equal(store.getItem('plainKey'), 'plainValue')
  assert.equal(await storageGet('plainKey'), 'plainValue')
})

test('hydrateApiConfig layers URL params on top of saved fields', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  // Saved config has every persisted field populated.
  store.setItem(
    'apiConfig',
    JSON.stringify({
      baseUrl: 'http://saved-host:1111',
      token: 'saved-token',
      yolo: true,
      debugView: true,
      autoScrollLastExchange: false,
      scrollSpeed: 'fast',
    }),
  )
  // Simulate a deep link that only carries a new token. The other
  // settings must survive (the saved host is authoritative).
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '?token=fresh-token', protocol: 'http:', host: 'localhost', port: '80' }

  const cfg = await hydrateApiConfig()
  assert.equal(cfg.token, 'fresh-token', 'URL param token should win')
  assert.equal(cfg.baseUrl, 'http://saved-host:1111', 'saved baseUrl preserved')
  assert.equal(cfg.yolo, true, 'saved yolo preserved')
  assert.equal(cfg.debugView, true, 'saved debugView preserved')
  assert.equal(cfg.autoScrollLastExchange, false, 'saved autoScroll preserved')
  assert.equal(cfg.scrollSpeed, 'fast', 'saved scrollSpeed preserved')
})

test('hydrateApiConfig returns empty baseUrl when nothing is persisted', async () => {
  __resetApiStateForTests()
  installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }

  const cfg = await hydrateApiConfig()
  // No saved baseUrl and no ?baseUrl= deep link → baseUrl stays '' so the
  // settings input shows its placeholder hint (http://<BACKEND_SERVER>:<PORT>)
  // and the app shows its "please configure" empty state. Previously this
  // auto-filled from the page origin, but that guessed wrong in dev and was
  // confusing for the common glasses-on-LAN → separate-bridge case.
  assert.equal(cfg.baseUrl, '')
  assert.equal(cfg.token, '')
  assert.equal(cfg.autoScrollLastExchange, true)
  assert.equal(cfg.scrollSpeed, 'medium')
})

test('hydrateApiConfig migrates legacy autoScrollMode into autoScrollLastExchange + scrollSpeed', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem(
    'apiConfig',
    JSON.stringify({
      baseUrl: 'http://x:1',
      token: 't',
      autoScrollMode: 'slow',
    }),
  )
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }

  const cfg = await hydrateApiConfig()
  assert.equal(cfg.autoScrollLastExchange, true)
  assert.equal(cfg.scrollSpeed, 'slow')
  assert.equal('autoScrollMode' in cfg, false, 'legacy field should be stripped')
})

test('hydrateApiConfig force=true re-reads from storage after an initial hydrate', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }

  // First hydration finds nothing → empty defaults. This mirrors the
  // pre-bridge hydration in App.tsx (bridge KV not available yet). Note: the
  // first hydrate runs legacy migration (no `backends` key, no legacy keys) and
  // persists an EMPTY registry under `backends`, so it writes the key.
  let cfg = await hydrateApiConfig()
  assert.equal(cfg.baseUrl, '')
  assert.equal(cfg.token, '')

  // Later (simulating the EvenHub bridge becoming available) the durable
  // store is populated with the real config — now a `backends` registry
  // (single backend, set active), not the legacy `apiConfig` key. Without
  // force, the cached empty registry would win and the real connection
  // settings would never load — exactly the bug where re-opening the app lost
  // the user's connection.
  const backendId = 'b-bridge-1'
  store.setItem(
    'backends',
    JSON.stringify({
      version: 1,
      backends: [
        {
          id: backendId,
          name: 'bridge-host:3456',
          baseUrl: 'http://bridge-host:3456',
          token: 'bridge-token',
          prefs: { yolo: true },
          agentConfigs: {},
        },
      ],
      activeBackendId: backendId,
      recentBackendIds: [backendId],
    }),
  )
  cfg = await hydrateApiConfig(true)
  assert.equal(cfg.baseUrl, 'http://bridge-host:3456', 'forced re-hydrate must re-read storage')
  assert.equal(cfg.token, 'bridge-token')
  assert.equal(cfg.yolo, true)

  // Without force, the second call must return the cache (idempotent).
  const cached = await hydrateApiConfig()
  assert.equal(cached.baseUrl, 'http://bridge-host:3456')
})

// ---- Multi-backend adapter tests: api.ts writes into the ACTIVE backend ----

test('setApiConfig writes connection + prefs into the ACTIVE backend', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }
  // Seed an empty registry, add two backends, make A active.
  await hydrateBackends()
  const a = await upsertBackend({ name: 'A', baseUrl: 'http://a:1', token: 'ta', prefs: {}, agentConfigs: {} })
  const b = await upsertBackend({ name: 'B', baseUrl: 'http://b:1', token: 'tb', prefs: {}, agentConfigs: {} })
  await setActiveBackend(a.id)

  // setApiConfig should land on A, not B and not a global singleton.
  await setApiConfig({ baseUrl: 'http://a-updated:2', token: 'ta2', yolo: true, scrollSpeed: 'fast' })

  const reg = JSON.parse(store.getItem('backends')!) as { backends: { id: string; baseUrl: string; token: string; prefs: { yolo?: boolean; scrollSpeed?: string } }[] }
  const afterA = reg.backends.find((x) => x.id === a.id)!
  const afterB = reg.backends.find((x) => x.id === b.id)!
  assert.equal(afterA.baseUrl, 'http://a-updated:2')
  assert.equal(afterA.token, 'ta2')
  assert.equal(afterA.prefs.yolo, true)
  assert.equal(afterA.prefs.scrollSpeed, 'fast')
  assert.equal(afterB.baseUrl, 'http://b:1', 'non-active backend must be untouched')
})

test('switch atomicity: after setActiveBackend, setApiConfig write-back lands on the NEW active backend', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }
  await hydrateBackends()
  const a = await upsertBackend({ name: 'A', baseUrl: 'http://a:1', token: 'ta', prefs: {}, agentConfigs: {} })
  const b = await upsertBackend({ name: 'B', baseUrl: 'http://b:1', token: 'tb', prefs: {}, agentConfigs: {} })
  await setActiveBackend(a.id)
  // Switch to B, then refresh the view (mirrors what App does on switch).
  await setActiveBackend(b.id)
  refreshActiveConfigView()
  assert.equal(getActiveBackend()!.id, b.id)

  // An auto-persist write-back (App's config effect) now lands on B.
  await setApiConfig({ baseUrl: 'http://b-updated:9', token: 'tb9' })

  const reg = JSON.parse(store.getItem('backends')!) as { backends: { id: string; baseUrl: string }[] }
  assert.equal(reg.backends.find((x) => x.id === b.id)!.baseUrl, 'http://b-updated:9')
  assert.equal(reg.backends.find((x) => x.id === a.id)!.baseUrl, 'http://a:1', 'A untouched by the post-switch write')
})

test('saveAgentConfigs writes into the ACTIVE backend', async () => {
  __resetApiStateForTests()
  installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }
  await hydrateBackends()
  const a = await upsertBackend({ name: 'A', baseUrl: 'http://a:1', token: 'ta', prefs: {}, agentConfigs: {} })
  await setActiveBackend(a.id)
  await saveAgentConfigs({ claude: { enabled: true, model: 'claude-opus-4-8' } })
  const active = getActiveBackend()!
  assert.deepEqual(active.agentConfigs, { claude: { enabled: true, model: 'claude-opus-4-8' } })
})

test('getApiConfig reflects the active backend after a switch', async () => {
  __resetApiStateForTests()
  installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  win.location = { search: '', protocol: 'http:', host: 'localhost', port: '80' }
  await hydrateBackends()
  const a = await upsertBackend({ name: 'A', baseUrl: 'http://a:1', token: 'ta', prefs: { yolo: true }, agentConfigs: {} })
  const b = await upsertBackend({ name: 'B', baseUrl: 'http://b:1', token: 'tb', prefs: { yolo: false }, agentConfigs: {} })
  await setActiveBackend(a.id)
  refreshActiveConfigView()
  await hydrateApiConfig(true)
  assert.equal(getApiConfig().baseUrl, 'http://a:1')
  assert.equal(getApiConfig().yolo, true)
  await setActiveBackend(b.id)
  refreshActiveConfigView()
  await hydrateApiConfig(true)
  assert.equal(getApiConfig().baseUrl, 'http://b:1')
  assert.equal(getApiConfig().yolo, false)
})

test('hydrateApiConfig deep-link connect: ?baseUrl=+?token= with no active backend auto-creates one', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
  const win = (globalThis as { window: MutableWindow }).window!
  // Deep link carries both baseUrl and token; storage has no backends.
  win.location = { search: '?baseUrl=http://dl-host:3456&token=dl-token', protocol: 'http:', host: 'localhost', port: '5173' }

  const cfg = await hydrateApiConfig()
  // A backend was created and made active from the deep link.
  assert.equal(cfg.baseUrl, 'http://dl-host:3456')
  assert.equal(cfg.token, 'dl-token')
  assert.ok(getActiveBackend(), 'an active backend should exist after deep-link connect')
  assert.equal(getActiveBackend()!.baseUrl, 'http://dl-host:3456')
  // Persisted to the registry as the single, active backend.
  const reg = JSON.parse(store.getItem('backends')!) as { backends: { id: string; baseUrl: string }[]; activeBackendId: string }
  assert.equal(reg.backends.length, 1)
  assert.equal(reg.backends[0]!.baseUrl, 'http://dl-host:3456')
  assert.equal(reg.activeBackendId, reg.backends[0]!.id)
})
