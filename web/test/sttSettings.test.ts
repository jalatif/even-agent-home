// Unit tests for the global Custom STT Server URL setting.
//
// `sttSettings.ts` is a standalone-KV-key store (not part of the per-backend
// `backends` registry blob) because the custom STT server applies regardless
// of which backend is active. These tests cover the persistence round-trip
// using the same Map-backed fake storage convention as storage.test.ts:
//   1. default is '' before hydration
//   2. setSttServerUrl writes the 'sttServerUrl' key and updates the cache
//   3. hydrateSttServerUrl reads the persisted value back
//   4. force:true re-reads after a direct store mutation
//   5. trimming + clearing-the-key-when-emptied behavior
//   6. __resetSttStateForTests clears the cache so the next hydrate re-reads

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerBridgeStorage, storageGet } from '../src/storage.ts'
import {
  getSttServerUrl,
  hydrateSttServerUrl,
  setSttServerUrl,
  __resetSttStateForTests,
} from '../src/sttSettings.ts'

type WindowStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  clear(): void
}

type MutableWindow = {
  localStorage: WindowStorage
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

function installWindow(): WindowStorage {
  const w: MutableWindow = { localStorage: makeStorage() }
  ;(globalThis as { window?: MutableWindow }).window = w
  return w.localStorage
}

function clearBridge() {
  registerBridgeStorage(() => null)
}

test('getSttServerUrl returns empty string before any hydration', () => {
  __resetSttStateForTests()
  assert.equal(getSttServerUrl(), '')
})

test('setSttServerUrl writes the sttServerUrl key, trims, and updates the cache', async () => {
  __resetSttStateForTests()
  installWindow()
  clearBridge()

  await setSttServerUrl('  https://stt.example.com  ')

  assert.equal(getSttServerUrl(), 'https://stt.example.com')
  assert.equal(await storageGet('sttServerUrl'), 'https://stt.example.com')
})

test('hydrateSttServerUrl reads the persisted value back into the cache', async () => {
  __resetSttStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('sttServerUrl', 'https://persisted.example.com')

  const hydrated = await hydrateSttServerUrl()

  assert.equal(hydrated, 'https://persisted.example.com')
  assert.equal(getSttServerUrl(), 'https://persisted.example.com')
})

test('hydrateSttServerUrl is idempotent (does not re-read without force)', async () => {
  __resetSttStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('sttServerUrl', 'first')

  await hydrateSttServerUrl()
  // Mutate the store AFTER the first hydration. Without force, the cached
  // value must win (the phone hot path reads the cache synchronously).
  store.setItem('sttServerUrl', 'second')
  const v = await hydrateSttServerUrl()
  assert.equal(v, 'first')
  assert.equal(getSttServerUrl(), 'first')
})

test('hydrateSttServerUrl force:true re-reads after a store mutation', async () => {
  __resetSttStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('sttServerUrl', 'first')

  await hydrateSttServerUrl()
  store.setItem('sttServerUrl', 'second')
  const v = await hydrateSttServerUrl(true)
  assert.equal(v, 'second')
  assert.equal(getSttServerUrl(), 'second')
})

test('setSttServerUrl with an empty/blank value clears the key and cache', async () => {
  __resetSttStateForTests()
  const store = installWindow()
  clearBridge()
  store.setItem('sttServerUrl', 'https://was-set.example.com')
  await hydrateSttServerUrl()

  await setSttServerUrl('   ')

  assert.equal(getSttServerUrl(), '')
  // The key is removed (not left as an empty string) so a stale empty string
  // can never mask a future non-empty value during a partial bridge read.
  assert.equal(await storageGet('sttServerUrl'), null)
})

test('__resetSttStateForTests clears the cache so the next hydrate re-reads', async () => {
  const store = installWindow()
  clearBridge()
  await setSttServerUrl('https://cached.example.com')
  assert.equal(getSttServerUrl(), 'https://cached.example.com')

  __resetSttStateForTests()
  assert.equal(getSttServerUrl(), '')

  store.setItem('sttServerUrl', 'https://fresh.example.com')
  const v = await hydrateSttServerUrl()
  assert.equal(v, 'https://fresh.example.com')
})
