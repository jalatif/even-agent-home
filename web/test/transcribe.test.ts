// Unit tests for the STT override branch in AgentHomeApi.transcribeAudio.
//
// transcribeAudio has two paths:
//   - CUSTOM path: when a global STT Server URL is set, it POSTs a multipart
//     WAV to `${url}/api/transcribe` with NO encryption and NO auth headers
//     (the custom server has no backend token to decrypt the encrypted channel).
//   - DEFAULT path: when blank, it uses the active backend's `/api/transcribe`
//     via the encrypted fetchEncrypted channel (unchanged behavior).
//
// These tests mock globalThis.fetch and assert which path was taken, the URL,
// the body shape, and the presence/absence of the X-AgentHome-Encrypted header.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'

import { registerBridgeStorage } from '../src/storage.ts'
import {
  __resetApiStateForTests,
  hydrateApiConfig,
  AgentHomeApi,
} from '../src/api.ts'
import type { AuthConfig } from '../src/api.ts'
import {
  upsertBackend,
  setActiveBackend,
} from '../src/backends.ts'
import {
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
  crypto: Crypto
  location: { search: string }
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

// Install a window with both localStorage (for backends registry) and the
// Node webcrypto shim (for crypto.ts's window.crypto.subtle calls used by the
// default/encrypted path).
function installWindow(): void {
  const w: MutableWindow = {
    localStorage: makeStorage(),
    crypto: webcrypto as unknown as Crypto,
    location: { search: '' },
  }
  ;(globalThis as { window?: MutableWindow }).window = w
}

function clearBridge() {
  registerBridgeStorage(() => null)
}

// Minimal Response/Body mock for the custom (multipart) path: returns JSON text.
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  const text = JSON.stringify(body)
  return {
    ok,
    status,
    statusText: '',
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
  } as unknown as Response
}

// Record the last fetch invocation so each test can assert on it.
type RecordedCall = { url: string; init: RequestInit }
function recordFetch(responder: (call: RecordedCall) => Response | Promise<Response>) {
  const calls: RecordedCall[] = []
  const fetchFn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString()
    const call: RecordedCall = { url, init }
    calls.push(call)
    return responder(call)
  }) as typeof fetch
  return { fetchFn, calls }
}

test('custom path: posts multipart WAV to ${url}/api/transcribe with no encryption header', async () => {
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()
  await setSttServerUrl('https://stt.example.com')

  const { fetchFn, calls } = recordFetch(() => jsonResponse({ text: 'hello world' }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn
  try {
    const api = new AgentHomeApi({ baseUrl: '', token: '' } as AuthConfig)
    const text = await api.transcribeAudio(new Uint8Array([0, 1, 2, 3]))
    assert.equal(text, 'hello world')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://stt.example.com/api/transcribe')
    assert.equal(calls[0].init.method, 'POST')
    assert.ok(calls[0].init.body instanceof FormData, 'body must be FormData for the custom path')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    assert.equal(headers['X-AgentHome-Encrypted'], undefined, 'custom path must NOT send the encrypted header')
    assert.equal(headers['Authorization'], undefined, 'custom path must NOT send auth headers')
    // The audio part must be a WAV file.
    const part = (calls[0].init.body as FormData).get('audio') as Blob
    assert.ok(part instanceof Blob)
    assert.equal(part.type, 'audio/wav')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('custom path: works even without a configured backend (never touches apiBaseUrl)', async () => {
  // Same as above but explicitly assert that no backend is configured — the
  // custom path must not throw "Agent Home backend is not configured".
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()
  await setSttServerUrl('https://stt.example.com')
  await hydrateApiConfig(true) // no backend registered

  const { fetchFn } = recordFetch(() => jsonResponse({ text: 'ok' }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn
  try {
    const api = new AgentHomeApi({ baseUrl: '', token: '' } as AuthConfig)
    const text = await api.transcribeAudio(new Uint8Array([10, 20]))
    assert.equal(text, 'ok')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('custom path: normalizes trailing slash and /api suffix', async () => {
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()

  for (const input of ['https://stt.example.com/', 'https://stt.example.com/api', 'https://stt.example.com/api/']) {
    __resetSttStateForTests()
    await setSttServerUrl(input)
    const { fetchFn, calls } = recordFetch(() => jsonResponse({ text: 'x' }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchFn
    try {
      const api = new AgentHomeApi({ baseUrl: '', token: '' } as AuthConfig)
      await api.transcribeAudio(new Uint8Array([1]))
      assert.equal(calls[0].url, 'https://stt.example.com/api/transcribe', `input "${input}" must normalize`)
    } finally {
      globalFetch(originalFetch)
    }
  }
})

test('custom path: non-2xx surfaces a readable error', async () => {
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()
  await setSttServerUrl('https://stt.example.com')

  const { fetchFn } = recordFetch(() => jsonResponse({ detail: 'bad audio' }, false, 400))
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn
  try {
    const api = new AgentHomeApi({ baseUrl: '', token: '' } as AuthConfig)
    await assert.rejects(
      () => api.transcribeAudio(new Uint8Array([1])),
      /Custom STT server error 400/
    )
  } finally {
    globalFetch(originalFetch)
  }
})

test('custom path: network failure surfaces a reachability error', async () => {
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()
  await setSttServerUrl('https://stt.example.com')

  const { fetchFn } = recordFetch(() => Promise.reject(new Error('connect ECONNREFUSED')))
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn
  try {
    const api = new AgentHomeApi({ baseUrl: '', token: '' } as AuthConfig)
    await assert.rejects(
      () => api.transcribeAudio(new Uint8Array([1])),
      /Could not reach custom STT server/
    )
  } finally {
    globalFetch(originalFetch)
  }
})

test('default path: uses the backend encrypted channel when STT URL is blank', async () => {
  __resetApiStateForTests()
  __resetSttStateForTests()
  installWindow()
  clearBridge()
  await setSttServerUrl('') // blank → default path
  // Register an active backend so apiBaseUrl resolves.
  const created = await upsertBackend({
    name: 'B',
    baseUrl: 'http://backend.example:8765',
    token: 'tok-default',
    prefs: {},
    agentConfigs: {},
  })
  await setActiveBackend(created.id)
  await hydrateApiConfig(true)

  const { fetchFn, calls } = recordFetch(() => jsonResponse({ text: 'backend-result' }))
  const originalFetch = globalThis.fetch
  globalThis.fetch = fetchFn
  try {
    const api = new AgentHomeApi({
      baseUrl: 'http://backend.example:8765',
      token: 'tok-default',
    } as AuthConfig)
    const text = await api.transcribeAudio(new Uint8Array([5, 6, 7]))
    assert.equal(text, 'backend-result')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://backend.example:8765/api/transcribe')
    // The default path encrypts the body; the outgoing body is the wrapped
    // { encryptedPayload: "..." } JSON, not a FormData and not the raw PCM.
    assert.equal(typeof calls[0].init.body, 'string')
    const bodyStr = calls[0].init.body as string
    assert.ok(bodyStr.startsWith('{"encryptedPayload"'), 'default path must send an encrypted body')
    const headers = (calls[0].init.headers ?? {}) as Record<string, string>
    assert.equal(headers['X-AgentHome-Encrypted'], '1', 'default path must mark the body encrypted')
  } finally {
    globalFetch(originalFetch)
  }
})

// helper to restore fetch (named to avoid shadowing the global `originalFetch`)
function globalFetch(original: typeof fetch) {
  globalThis.fetch = original
}
