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
  __resetApiStateForTests,
} from '../src/api.ts'

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
