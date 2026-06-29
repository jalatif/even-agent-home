# Multi-Backend Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user connect to multiple named backends, each with its own connection (url:port + token), agent config, and app prefs, with one backend active at a time (last-connected, auto-connected on startup).

**Architecture:** Add a single `backends` KV registry (`web/src/backends.ts`). Make `api.ts` a thin **active-view adapter** over it — `getApi()`/`getApiConfig()`/`getAgentConfigs()` keep their exact signatures so the controller and glasses/main UI are unchanged; they now read the active backend's slice. The Settings UI gains a Backends section + Connect/Edit modal. This preserves the four documented startup/storage invariants (boot-after-hydration ordering, refresh-nonce gate, bound bridge methods, force-rehydrate) by construction.

**Tech Stack:** TypeScript, React 19, Vite 8, `node:test` + `node:assert/strict` for unit tests, the Even Hub SDK glasses simulator (`scripts/fuzzy-test.mjs`) for E2E.

**Worktree:** `/Users/jalatif-mac-mini/Work/even-agent-home-multi` (branch `feat/multi-backend`). The original checkout at `/Users/jalatif-mac-mini/Work/even-agent-home` is dirty and must NOT be touched.

**Reference spec:** `docs/superpowers/specs/2026-06-28-multi-backend-design.md`.

**Testing commands** (run from `web/` unless noted):
- Unit: `npm run test:unit` (runs `node --experimental-strip-types --test test/**/*.test.ts`)
- Lint/types: `npm run build` (`tsc -b && vite build`)
- Simulator E2E: `npm run test:simulator` (from `web/`; runs `node ../scripts/fuzzy-test.mjs`)

---

## File Structure

**New files:**
- `web/src/backends.ts` — registry types, hydration, ops, migration, pure helpers. The only module that reads/writes the `backends` KV key.
- `web/test/backends.test.ts` — registry lifecycle + pure-helper tests (node:test).

**Modified files:**
- `web/src/api.ts` — internals become the active-view adapter; public interface unchanged.
- `web/src/App.tsx` — Backends section + Connect/Edit modal + switch/remove handlers; replace the legacy Backend Configuration card.
- `web/src/style.css` — `.backends-list`, `.backend-row`, `.backend-modal*` styles.

**Files intentionally NOT modified:** `storage.ts`, `configHelpers.ts`, `controller/agentHomeController.ts`, `controller/model.ts`, `bridge/evenBridge.ts`. Their interfaces are preserved; the controller keeps calling `getApi()`/`getApiConfig()`.

---

## Task 1: Pure helpers for connection parsing and naming

**Files:**
- Create: `web/src/backends.ts`
- Test: `web/test/backends.test.ts`

These pure functions have no storage or React deps, so we build and test them first. They are reused by the registry (Task 3) and the UI (Task 6).

- [ ] **Step 1: Create `backends.ts` with the pure helpers**

Create `web/src/backends.ts`:

```ts
/**
 * Multi-backend registry: persistent store of one or more named backends
 * (each a url:port + token + per-backend agent config + per-backend app
 * prefs), with exactly one backend active at a time. The active backend is
 * the "last connected"; the app boots onto it on startup.
 *
 * `api.ts` adapts this registry: its public surface (getApi, getApiConfig,
 * getAgentConfigs) keeps its signature but reads the active backend's slice
 * via refreshActiveView(). The controller and glasses/main UI are unchanged.
 *
 * Persistent layout: a single KV key `backends` holding a BackendRegistry.
 * The legacy `apiConfig`/`agentConfigs` keys are read ONCE during migration,
 * then never touched again (left in place as a rollback path).
 */
import { storageGet, storageSet } from './storage.ts'
import type { AgentProviderConfig } from './api.ts'

export interface BackendPrefs {
  yolo?: boolean
  debugView?: boolean
  autoScrollLastExchange?: boolean
  scrollSpeed?: 'slow' | 'medium' | 'fast'
}

export interface Backend {
  id: string                 // stable uuid; never user-editable
  name: string               // user-chosen, editable, shown in UI
  baseUrl: string            // http://host:port
  token: string
  prefs: BackendPrefs
  agentConfigs: Record<string, AgentProviderConfig>
}

export interface BackendRegistry {
  version: 1
  backends: Backend[]
  activeBackendId: string | null
  recentBackendIds: string[]  // most-recent first; drives removeBackend fallback
}

/** Initial empty registry used as the in-memory cache seed. */
function emptyRegistry(): BackendRegistry {
  return { version: 1, backends: [], activeBackendId: null, recentBackendIds: [] }
}

// ---- Pure helpers (no storage, no side effects) ----

/**
 * Parse a connection input that may be either:
 *   - a full `http(s)://host:port?token=...` URL (auto-split via the same
 *     rule parseConnectionUrl uses in App.tsx), or
 *   - a plain `host` or `host:port` (no scheme), normalized to
 *     `http://host:port` with an empty token (filled by a separate field).
 * Returns null for inputs that are neither a recognizable connection URL nor
 * a bare host.
 */
export function normalizeConnectionInput(raw: string): { baseUrl: string; token: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  // Full URL with scheme + optional ?token=
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      const token = parsed.searchParams.get('token') ?? ''
      const baseUrl = `${parsed.protocol}//${parsed.host}`
      return { baseUrl, token }
    } catch {
      return null
    }
  }

  // Bare host or host:port (no scheme). Reject anything with a path/query/space
  // to avoid silently turning prose into a bogus baseUrl.
  if (/^[\w.-]+(:\d+)?$/.test(trimmed)) {
    return { baseUrl: `http://${trimmed}`, token: '' }
  }

  return null
}

/**
 * Derive a human-friendly backend name from a baseUrl for the migration path
 * (where there is no user-chosen name yet). Returns the host:port; falls back
 * to "Default" for anything unparseable.
 */
export function nameFromBaseUrl(baseUrl: string): string {
  const trimmed = (baseUrl ?? '').trim()
  if (!trimmed) return 'Default'
  try {
    const parsed = new URL(trimmed)
    const host = parsed.host // host:port (omits port if default for scheme)
    return host || 'Default'
  } catch {
    return 'Default'
  }
}

/**
 * Pick the fallback active backend id when `removedId` is removed from the
 * registry. Order: the most-recently-active OTHER backend (first id in
 * recentBackendIds that is not removedId and still exists), else the first
 * remaining backend by list order, else null.
 */
export function pickFallbackBackend(
  registry: BackendRegistry,
  removedId: string,
): string | null {
  const remainingIds = new Set(registry.backends.map((b) => b.id))
  for (const id of registry.recentBackendIds) {
    if (id !== removedId && remainingIds.has(id)) return id
  }
  const firstRemaining = registry.backends.find((b) => b.id !== removedId)
  return firstRemaining ? firstRemaining.id : null
}
```

- [ ] **Step 2: Write the failing tests for the pure helpers**

Create `web/test/backends.test.ts`:

```ts
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
  const out = normalizeConnectionInput('https://box.example:443?token=t')
  assert.deepEqual(out, { baseUrl: 'https://box.example:443', token: 't' })
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
  assert.equal(nameFromBaseUrl('https://box.example:443'), 'box.example:443')
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
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run test:unit --prefix web/test/backends.test.ts` — but the npm script globs all test files, so run the whole unit suite:

Run: `npm run test:unit` (from `web/`)

Expected: the new `backends.test.ts` tests PASS (the helpers are fully implemented in Step 1). All previously-existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/backends.ts web/test/backends.test.ts
git commit -m "feat(backends): add pure connection/naming helpers for multi-backend"
```

---

## Task 2: Registry hydration, migration, and reset

Add the registry cache, `hydrateBackends(force)`, legacy migration, and the test reset. This mirrors `api.ts`'s `hydrateApiConfig(force)` discipline exactly (the `force:true` post-bridge re-read is what fixes the "re-open app lost connection" bug).

**Files:**
- Modify: `web/src/backends.ts`
- Test: `web/test/backends.test.ts`

- [ ] **Step 1: Add the migration function to `backends.ts`**

Append to `web/src/backends.ts` (below the pure helpers, above any future ops):

```ts
// ---- Migration from the legacy single-backend keys ----

/**
 * Migrate a legacy single-backend install into a registry with one backend.
 * Reads (never writes) the legacy `apiConfig`/`agentConfigs` keys. Returns an
 * empty registry when the legacy config is absent or unusable (no token).
 * Idempotent in spirit: callers only run this when the `backends` key is
 * absent, so it runs at most once per install.
 *
 * Accepts the raw stored strings (not pre-parsed) so it can be unit-tested
 * without touching storage; production passes storageGet('apiConfig') etc.
 */
export function migrateLegacy(
  legacyApiConfigRaw: string | null,
  legacyAgentConfigsRaw: string | null,
): BackendRegistry {
  let legacy: { baseUrl?: string; token?: string; yolo?: boolean; debugView?: boolean; autoScrollLastExchange?: boolean; scrollSpeed?: 'slow' | 'medium' | 'fast' } = {}
  if (legacyApiConfigRaw) {
    try {
      legacy = JSON.parse(legacyApiConfigRaw)
    } catch {
      legacy = {}
    }
  }

  const baseUrl = (legacy.baseUrl ?? '').trim()
  const token = (legacy.token ?? '').trim()
  if (!baseUrl || !token) {
    return emptyRegistry()
  }

  let agentConfigs: Record<string, AgentProviderConfig> = {}
  if (legacyAgentConfigsRaw) {
    try {
      agentConfigs = JSON.parse(legacyAgentConfigsRaw)
    } catch {
      agentConfigs = {}
    }
  }

  const id = makeBackendId()
  const backend: Backend = {
    id,
    name: nameFromBaseUrl(baseUrl),
    baseUrl,
    token,
    prefs: {
      yolo: legacy.yolo,
      debugView: legacy.debugView,
      autoScrollLastExchange: legacy.autoScrollLastExchange,
      scrollSpeed: legacy.scrollSpeed,
    },
    agentConfigs,
  }
  return {
    version: 1,
    backends: [backend],
    activeBackendId: id,
    recentBackendIds: [id],
  }
}

/** Generate a stable-ish unique id for a backend. */
export function makeBackendId(): string {
  // crypto.randomUUID is available in the phone WebView and in Node 20+.
  // Fall back to a timestamp+random string for very old environments.
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
```

- [ ] **Step 2: Add the in-memory cache + hydration + reset to `backends.ts`**

Append to `web/src/backends.ts`:

```ts
// ---- In-memory cache + hydration ----

const BACKENDS_KEY = 'backends'

let currentRegistry: BackendRegistry = emptyRegistry()
let registryHydrated = false

/**
 * Reset the in-memory cache to the empty default and clear the hydrated flag.
 * Used by tests; production code never calls this. Mirrors api.ts's
 * __resetApiStateForTests.
 */
export function __resetBackendsStateForTests(): void {
  currentRegistry = emptyRegistry()
  registryHydrated = false
}

/**
 * Read the registry from the persistent store and seed the in-memory cache.
 *
 * Mirrors hydrateApiConfig's discipline (the fix for the "re-open app lost
 * connection" bug):
 *   - First call hydrates from storage and sets the flag.
 *   - Pass `force: true` to bypass the flag and re-read. This is needed after
 *     the EvenHub bridge becomes available: the first (pre-bridge) hydration
 *     reads the localStorage fallback and sets the flag, so without force the
 *     post-bridge re-hydration would never consult the durable bridge KV.
 *
 * If the `backends` key is absent, run legacy migration (read-only over the
 * old apiConfig/agentConfigs keys) to seed the registry, then persist it.
 */
export async function hydrateBackends(force = false): Promise<BackendRegistry> {
  if (registryHydrated && !force) return currentRegistry

  let registry: BackendRegistry | null = null
  const raw = await storageGet(BACKENDS_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as BackendRegistry
      if (parsed && parsed.version === 1 && Array.isArray(parsed.backends)) {
        registry = parsed
      }
    } catch (e) {
      console.warn('[backends] failed to parse backends registry from storage', e)
    }
  }

  if (!registry) {
    // First launch on this build (or corrupt registry): migrate from legacy
    // single-backend keys. Read-only over the legacy keys; we then persist the
    // new registry so migration never runs again.
    const [legacyApi, legacyAgs] = await Promise.all([
      storageGet('apiConfig'),
      storageGet('agentConfigs'),
    ])
    registry = migrateLegacy(legacyApi, legacyAgs)
    try {
      await storageSet(BACKENDS_KEY, JSON.stringify(registry))
    } catch (e) {
      console.warn('[backends] failed to persist migrated registry', e)
    }
  }

  currentRegistry = registry
  registryHydrated = true
  return currentRegistry
}

/** Synchronous read of the cached registry. Kicks off an async hydrate if the
 *  cache has not been hydrated yet (same lazy pattern as api.ts getApiConfig). */
export function getRegistry(): BackendRegistry {
  if (!registryHydrated) {
    void hydrateBackends()
  }
  return currentRegistry
}

/** Read accessor for tests/introspection (does not trigger hydration). */
export function peekRegistry(): BackendRegistry {
  return currentRegistry
}

/** True once hydrateBackends has completed at least once. */
export function isRegistryHydrated(): boolean {
  return registryHydrated
}
```

- [ ] **Step 3: Write the failing tests for migration + hydration**

Append to `web/test/backends.test.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit` (from `web/`)

Expected: all `backends.test.ts` tests PASS (migration + hydration + reset are fully implemented). All previously-existing tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/backends.ts web/test/backends.test.ts
git commit -m "feat(backends): add registry hydration + legacy migration"
```

---

## Task 3: Registry mutation ops (upsert / setActive / remove / save)

These mutate the cached registry and persist. `setActiveBackend` is the load-bearing one: it must be atomic (flip active → touch recency → refresh the api.ts view → persist) so the App auto-persist effect's write-back lands on the new active backend.

**Files:**
- Modify: `web/src/backends.ts`
- Test: `web/test/backends.test.ts`

- [ ] **Step 1: Add the registry ops to `backends.ts`**

Append to `web/src/backends.ts`:

```ts
// ---- Registry mutation ops ----

/** Persist the current cache to storage. */
async function persist(): Promise<void> {
  try {
    await storageSet(BACKENDS_KEY, JSON.stringify(currentRegistry))
  } catch (e) {
    console.warn('[backends] failed to persist registry', e)
  }
}

/** Find a backend by id (from the cache). */
export function getBackend(id: string): Backend | undefined {
  return currentRegistry.backends.find((b) => b.id === id)
}

/** The active backend, or null when none is active. */
export function getActiveBackend(): Backend | null {
  if (!currentRegistry.activeBackendId) return null
  return getBackend(currentRegistry.activeBackendId) ?? null
}

/** Ordered list for the UI: active first, then the rest by recency then list order. */
export function getBackendsList(): Backend[] {
  const ids = new Set<string>()
  const out: Backend[] = []
  const pushIfPresent = (id: string | null) => {
    if (id && !ids.has(id)) {
      const b = getBackend(id)
      if (b) { out.push(b); ids.add(id) }
    }
  }
  pushIfPresent(currentRegistry.activeBackendId)
  for (const id of currentRegistry.recentBackendIds) pushIfPresent(id)
  for (const b of currentRegistry.backends) pushIfPresent(b.id)
  return out
}

/**
 * Insert or update a backend by id. For a new backend (no id / id not found),
 * a fresh id is generated and the backend is appended. Returns the stored
 * backend (with its id). Does NOT change which backend is active.
 */
export async function upsertBackend(input: Omit<Backend, 'id'> & { id?: string }): Promise<Backend> {
  const existing = input.id ? getBackend(input.id) : undefined
  let stored: Backend
  if (existing) {
    stored = { ...existing, ...input, id: existing.id }
    currentRegistry = {
      ...currentRegistry,
      backends: currentRegistry.backends.map((b) => (b.id === existing.id ? stored : b)),
    }
  } else {
    stored = { ...input, id: makeBackendId() }
    currentRegistry = { ...currentRegistry, backends: [...currentRegistry.backends, stored] }
  }
  await persist()
  return stored
}

/**
 * Merge a partial patch into one backend (e.g. editing name/url/token/prefs or
 * replacing its agentConfigs). No-op if the id is not found. Used by api.ts
 * to write connection/prefs/agentConfigs back into the ACTIVE backend.
 */
export async function saveBackend(id: string, patch: Partial<Omit<Backend, 'id'>>): Promise<void> {
  const existing = getBackend(id)
  if (!existing) return
  const updated: Backend = { ...existing, ...patch, id }
  currentRegistry = {
    ...currentRegistry,
    backends: currentRegistry.backends.map((b) => (b.id === id ? updated : b)),
  }
  await persist()
}

/**
 * Atomically set the active backend:
 *   1. flip activeBackendId,
 *   2. move it to the front of recentBackendIds,
 *   3. refresh the api.ts active view,
 *   4. persist.
 * The refresh (step 3) is invoked via the optional hook so backends.ts stays
 * free of an import cycle with api.ts. No-op if the id is not found.
 *
 * Returns true if the active backend actually changed.
 */
export async function setActiveBackend(
  id: string,
  onActiveChanged?: () => void,
): Promise<boolean> {
  const target = getBackend(id)
  if (!target) return false
  const changed = currentRegistry.activeBackendId !== id
  // Recency: most-recent first, dedupe the newly-active id.
  const recentBackendIds = [id, ...currentRegistry.recentBackendIds.filter((x) => x !== id)]
  currentRegistry = {
    ...currentRegistry,
    activeBackendId: id,
    recentBackendIds,
  }
  if (changed && onActiveChanged) onActiveChanged()
  await persist()
  return changed
}

/**
 * Remove a backend. If it was active, fall back to the most-recent-other
 * backend (else first remaining, else null) and refresh the api.ts view via
 * the hook. Returns whether the active backend changed and the new active id.
 */
export async function removeBackend(
  id: string,
  onActiveChanged?: () => void,
): Promise<{ activeChanged: boolean; fallbackId: string | null }> {
  const wasActive = currentRegistry.activeBackendId === id
  const remaining = currentRegistry.backends.filter((b) => b.id !== id)
  let activeBackendId = currentRegistry.activeBackendId
  if (wasActive) {
    activeBackendId = pickFallbackBackend(currentRegistry, id)
  }
  const recentBackendIds = currentRegistry.recentBackendIds.filter((x) => x !== id)
  const activeChanged = wasActive && activeBackendId !== id
  currentRegistry = {
    ...currentRegistry,
    backends: remaining,
    activeBackendId,
    recentBackendIds,
  }
  if (activeChanged && onActiveChanged) onActiveChanged()
  await persist()
  return { activeChanged, fallbackId: activeBackendId }
}
```

- [ ] **Step 2: Write the failing tests for the registry ops**

Append to `web/test/backends.test.ts`:

```ts
import {
  upsertBackend,
  saveBackend,
  setActiveBackend,
  removeBackend,
  getActiveBackend,
  getBackendsList,
  getBackend,
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
  assert.equal(getBackendsList()[0].id, b.id, 'active backend should be first in list')
  // Switch to B again -> no change, hook must NOT fire.
  const changed2 = await setActiveBackend(b.id, () => { hookCalls++ })
  assert.equal(changed2, false)
  // 2 hook calls: A-set (first switch) + B-set. The re-set of B and the
  // initial A set count as changes; re-setting A again would too. We assert
  // the re-set of B did not add a call.
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
```

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npm run test:unit` (from `web/`)

Expected: all `backends.test.ts` tests PASS. All previously-existing tests still PASS.

- [ ] **Step 4: Commit**

```bash
git add web/src/backends.ts web/test/backends.test.ts
git commit -m "feat(backends): add upsert/setActive/save/remove registry ops"
```

---

## Task 4: Make `api.ts` the active-view adapter

Rewire `api.ts` internals to read the active backend's slice from the registry, keeping every public function signature identical. This is the task that carries the four startup/storage invariants over to the new world.

**Files:**
- Modify: `web/src/api.ts`
- Test: `web/test/storage.test.ts` (extend — the existing `hydrateApiConfig` tests must stay green; this is the regression guard)

- [ ] **Step 1: Add the registry imports + active-view refresh to `api.ts`**

In `web/src/api.ts`, replace the import line at the very top:

```ts
import { storageGet, storageSet } from './storage.ts'
```

with:

```ts
import { storageGet, storageSet } from './storage.ts'
import {
  hydrateBackends,
  getActiveBackend,
  getBackend,
  peekRegistry,
} from './backends.ts'
```

- [ ] **Step 2: Replace the in-memory cache + reset with a registry-backed active view**

In `web/src/api.ts`, replace this block (the `currentConfig`/`currentAgentConfigs`/`configHydrated`/`agentConfigsHydrated` declarations and `__resetApiStateForTests`):

```ts
// In-memory cache. The phone WebView can reload the JS bundle at any time
// (host app rotation, page rebuild, etc.) and we want reads to be sync so
// the controller can use them on hot paths (scroll, prompt). The async
// storage functions keep this cache fresh and the persistent store (bridge
// KV) durable across reloads.
let currentConfig: AuthConfig = {
  baseUrl: defaultApiBaseUrl,
  token: '',
  autoScrollLastExchange: true,
  scrollSpeed: 'medium',
}
let currentAgentConfigs: Record<string, AgentProviderConfig> = {}
let configHydrated = false
let agentConfigsHydrated = false

// Reset the in-memory cache back to the initial defaults. Used by tests
// that need to assert on the "fresh hydration" path; production code
// never calls this. Exported with an underscored name to signal that
// it is not part of the public surface.
export function __resetApiStateForTests(): void {
  currentConfig = {
    baseUrl: defaultApiBaseUrl,
    token: '',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  }
  currentAgentConfigs = {}
  configHydrated = false
  agentConfigsHydrated = false
}
```

with:

```ts
// Active view: currentConfig / currentAgentConfigs are the ACTIVE backend's
// flattened slice, rebuilt from the registry by refreshActiveView(). This keeps
// the public surface (getApiConfig/getApi/getAgentConfigs) byte-identical to
// the pre-multi-backend world so the controller and glasses/main UI never
// change — they still read the active backend's data. The async hydrate calls
// keep this view fresh and the registry (bridge KV) durable across reloads.
let currentConfig: AuthConfig = {
  baseUrl: defaultApiBaseUrl,
  token: '',
  autoScrollLastExchange: true,
  scrollSpeed: 'medium',
}
let currentAgentConfigs: Record<string, AgentProviderConfig> = {}
let configHydrated = false
let agentConfigsHydrated = false

/**
 * Rebuild the active view (currentConfig + currentAgentConfigs) from the
 * active backend in the registry. Called after every hydrate / active switch /
 * save so reads stay consistent. When there is no active backend the view
 * collapses to empty defaults (the "please configure" empty state).
 */
function refreshActiveView(): void {
  const backend = getActiveBackend()
  if (!backend) {
    currentConfig = {
      baseUrl: defaultApiBaseUrl,
      token: '',
      autoScrollLastExchange: true,
      scrollSpeed: 'medium',
    }
    currentAgentConfigs = {}
    return
  }
  currentConfig = {
    baseUrl: backend.baseUrl,
    token: backend.token,
    yolo: backend.prefs.yolo,
    debugView: backend.prefs.debugView,
    autoScrollLastExchange: backend.prefs.autoScrollLastExchange,
    scrollSpeed: backend.prefs.scrollSpeed,
  }
  currentAgentConfigs = backend.agentConfigs ?? {}
}

// Reset the in-memory cache back to the initial defaults. Used by tests
// that need to assert on the "fresh hydration" path; production code
// never calls this. Exported with an underscored name to signal that
// it is not part of the public surface.
export function __resetApiStateForTests(): void {
  currentConfig = {
    baseUrl: defaultApiBaseUrl,
    token: '',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  }
  currentAgentConfigs = {}
  configHydrated = false
  agentConfigsHydrated = false
  __resetBackendsStateForTests()
}

// Imported after __resetApiStateForTests is defined so the reset order is clear.
import { __resetBackendsStateForTests, saveBackend as saveBackendForActive } from './backends.ts'
```

- [ ] **Step 3: Rewrite `hydrateApiConfig` / `hydrateAgentConfigs` to hydrate the registry then refresh the view**

In `web/src/api.ts`, replace the `hydrateApiConfig` function (the whole function including its doc comment) with:

```ts
/**
 * Read the auth config from the persistent store and seed the in-memory active
 * view. Now backed by the multi-backend registry: hydrate the registry (which
 * handles bridge-vs-localStorage precedence and legacy migration), then rebuild
 * the active view from the active backend. URL params are layered ON TOP of the
 * active backend's persisted fields (same priority as before: defaults <
 * persisted active backend < URL params) so a deep link refreshes credentials
 * without wiping prefs. Idempotent; pass `force: true` to bypass the flag and
 * re-read (needed after the bridge becomes available — see hydrateBackends).
 */
export async function hydrateApiConfig(force = false): Promise<AuthConfig> {
  if (configHydrated && !force) return currentConfig
  await hydrateBackends(force)
  refreshActiveView()
  const { token, explicitBaseUrl } = configFromLocation()
  currentConfig = {
    ...currentConfig,
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
    ...(token ? { token } : {}),
  }
  configHydrated = true
  return currentConfig
}
```

Replace the `hydrateAgentConfigs` function with:

```ts
export async function hydrateAgentConfigs(force = false): Promise<Record<string, AgentProviderConfig>> {
  if (agentConfigsHydrated && !force) return currentAgentConfigs
  await hydrateBackends(force)
  refreshActiveView()
  agentConfigsHydrated = true
  return currentAgentConfigs
}
```

- [ ] **Step 4: Rewrite `setApiConfig` / `saveAgentConfigs` to write back into the active backend**

In `web/src/api.ts`, replace the `setApiConfig` function with:

```ts
/**
 * Persist the connection + app prefs into the ACTIVE backend's slice of the
 * registry (or just update the in-memory view if there is no active backend
 * yet — e.g. before the first Connect or after removing the last backend).
 * The in-memory currentConfig is updated synchronously first so hot-path
 * reads stay consistent while the bridge write is in flight.
 */
export async function setApiConfig(config: AuthConfig): Promise<void> {
  const nextConfig = { ...config }
  delete nextConfig.autoScrollMode
  currentConfig = nextConfig
  const activeId = peekRegistry().activeBackendId
  if (activeId) {
    const backend = getBackend(activeId)
    if (backend) {
      await saveBackendForActive(activeId, {
        baseUrl: nextConfig.baseUrl,
        token: nextConfig.token,
        prefs: {
          yolo: nextConfig.yolo,
          debugView: nextConfig.debugView,
          autoScrollLastExchange: nextConfig.autoScrollLastExchange,
          scrollSpeed: nextConfig.scrollSpeed,
        },
      })
    }
  }
}
```

Replace the `saveAgentConfigs` function with:

```ts
export async function saveAgentConfigs(configs: Record<string, AgentProviderConfig>): Promise<void> {
  currentAgentConfigs = configs
  const activeId = peekRegistry().activeBackendId
  if (activeId) {
    await saveBackendForActive(activeId, { agentConfigs: configs })
  }
}
```

- [ ] **Step 5: Add a `refreshActiveView` export for the UI to call on switch**

In `web/src/api.ts`, find the `getApi` export (near the bottom):

```ts
export function getApi() {
  return new AgentHomeApi(currentConfig)
}
```

Add a new export just above it:

```ts
/**
 * Rebuild the active view from the registry's active backend. Called by the
 * UI after setActiveBackend / removeBackend so the controller's next
 * getApi()/getApiConfig() reads the newly-active backend's slice. Public so
 * App.tsx can trigger it without importing backends.ts directly.
 */
export function refreshActiveConfigView(): void {
  refreshActiveView()
}
```

- [ ] **Step 6: Verify the existing adapter tests still pass (regression guard)**

Run: `npm run test:unit` (from `web/`)

Expected: ALL tests PASS — the existing `test/storage.test.ts` `hydrateApiConfig` layering/migration/force tests must stay green (interface unchanged), `test/configHelpers.test.ts` and `test/controller.test.ts` stay green, and `test/backends.test.ts` stays green. The controller's "no fetch before config" test is the key guard that boot-after-hydration ordering survives.

If `test/controller.test.ts` fails on import (circular import between api.ts ↔ backends.ts), see Task 5 troubleshooting — but the import is one-directional at runtime (api.ts imports backends.ts; backends.ts imports only the TYPE from api.ts), so no cycle is expected.

- [ ] **Step 7: Commit**

```bash
git add web/src/api.ts
git commit -m "feat(api): make api.ts an active-view adapter over the backends registry"
```

---

## Task 5: Extend adapter tests for registry-sourced behavior

Add explicit tests that `setApiConfig` writes into the active backend and that a switch propagates to the view. This locks the switch-atomicity contract.

**Files:**
- Modify: `web/test/storage.test.ts`

- [ ] **Step 1: Add registry-sourced adapter tests to `storage.test.ts`**

At the top of `web/test/storage.test.ts`, add these imports alongside the existing ones:

```ts
import {
  upsertBackend,
  setActiveBackend,
  getActiveBackend,
  peekRegistry,
} from '../src/backends.ts'
import { __resetBackendsStateForTests } from '../src/backends.ts'
```

Append the following tests to `web/test/storage.test.ts` (after the last existing test):

```ts
test('setApiConfig writes connection + prefs into the ACTIVE backend', async () => {
  __resetApiStateForTests()
  const store = installWindow()
  clearBridge()
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
```

You also need `refreshActiveConfigView` and `saveAgentConfigs` and `getApiConfig` imported in `storage.test.ts`. Update the existing `api.ts` import block in that file to include them. Find:

```ts
import {
  hydrateApiConfig,
  __resetApiStateForTests,
} from '../src/api.ts'
```

Replace with:

```ts
import {
  hydrateApiConfig,
  setApiConfig,
  saveAgentConfigs,
  getApiConfig,
  __resetApiStateForTests,
  refreshActiveConfigView,
} from '../src/api.ts'
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `npm run test:unit` (from `web/`)

Expected: all tests PASS, including the four new adapter tests. The switch-atomicity test is the load-bearing one.

- [ ] **Step 3: Commit**

```bash
git add web/test/storage.test.ts
git commit -m "test(api): cover active-backend write-back + switch atomicity"
```

---

## Task 6: App.tsx — Backends section + Connect/Edit modal (UI)

Add the Backends list, the Connect/Edit modal, and the switch/edit/remove handlers. Replace the legacy Backend Configuration card. The glasses/main view and the agent-config/prefs cards are untouched (they already read the active backend).

**Files:**
- Modify: `web/src/App.tsx`

This is a large UI task; it is broken into steps that each leave the app compiling.

- [ ] **Step 1: Add registry imports and state to App.tsx**

In `web/src/App.tsx`, replace the existing import block from `./api` and below:

```ts
import {
  getApiConfig,
  setApiConfig,
  getApi,
  getAgentConfigs,
  saveAgentConfigs,
  hydrateApiConfig,
  hydrateAgentConfigs,
} from './api'
import type { AgentProviderConfig, AuthConfig } from './api'
import { AgentHomeController } from './controller/agentHomeController'
import { APP_BUILD_VERSION, EvenHubGlassesBridge } from './bridge/evenBridge'
import type { AppState } from './controller/model'
import { registerBridgeStorage } from './storage'
import { isBackendConfigured } from './configHelpers'
import './style.css'
```

with:

```ts
import {
  getApiConfig,
  setApiConfig,
  getApi,
  getAgentConfigs,
  saveAgentConfigs,
  hydrateApiConfig,
  hydrateAgentConfigs,
  refreshActiveConfigView,
} from './api'
import type { AgentProviderConfig, AuthConfig } from './api'
import { AgentHomeController } from './controller/agentHomeController'
import { APP_BUILD_VERSION, EvenHubGlassesBridge } from './bridge/evenBridge'
import type { AppState } from './controller/model'
import { registerBridgeStorage } from './storage'
import { isBackendConfigured } from './configHelpers'
import {
  hydrateBackends,
  getBackendsList,
  getActiveBackend,
  setActiveBackend,
  removeBackend,
  upsertBackend,
  saveBackend,
  normalizeConnectionInput,
  type Backend,
} from './backends'
import './style.css'
```

- [ ] **Step 2: Add backend-list + modal state inside the `App()` component**

In `web/src/App.tsx`, inside `export default function App()`, find the state declarations:

```ts
  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, string[]>>({})
  // Default to `{}`; the mount effect below populates this with persisted
  // values once `hydrateAgentConfigs()` resolves from the persistent store.
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentProviderConfig>>({})
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [agentRefreshNonce, setAgentRefreshNonce] = useState(0)
```

Add immediately after them:

```ts
  // ---- Multi-backend UI state ----
  // backendsVersion is bumped whenever the registry changes so the list re-renders.
  const [backendsVersion, setBackendsVersion] = useState(0)
  const bumpBackends = () => setBackendsVersion((v) => v + 1)
  // Connect/Edit modal state. `editingBackend` is null for "create new",
  // or an existing backend id for "edit".
  const [backendModalOpen, setBackendModalOpen] = useState(false)
  const [editingBackendId, setEditingBackendId] = useState<string | null>(null)
  const [modalName, setModalName] = useState('')
  const [modalConnection, setModalConnection] = useState('')
  const [modalToken, setModalToken] = useState('')
  const [modalTesting, setModalTesting] = useState(false)
  const [modalTestResult, setModalTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)

  const activeBackend = getActiveBackend()
  const backendsList = getBackendsList()
  // suppress unused-var lint for the bump trigger
  void backendsVersion
```

- [ ] **Step 3: Add switch / remove / connect / edit handlers**

Still inside `App()`, after the `changeAgentThinking` handler (around the line `})` that closes it, before `const isConfigured = ...`), add:

```ts
  // ---- Multi-backend handlers ----

  // Open the modal to connect a NEW backend.
  const openConnectModal = () => {
    setEditingBackendId(null)
    setModalName('')
    setModalConnection('')
    setModalToken('')
    setModalError(null)
    setModalTestResult(null)
    setBackendModalOpen(true)
  }

  // Open the modal to EDIT an existing backend.
  const openEditModal = (backend: Backend) => {
    setEditingBackendId(backend.id)
    setModalName(backend.name)
    setModalConnection(backend.baseUrl)
    setModalToken(backend.token)
    setModalError(null)
    setModalTestResult(null)
    setBackendModalOpen(true)
  }

  // Auto-split a pasted full ?token= URL into connection+token fields.
  const handleModalConnectionPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text')
    const parsed = normalizeConnectionInput(pasted)
    if (!parsed) return
    // Only auto-fill when the paste looks like a full URL (has a token); a
    // bare host paste is left alone so the user can keep typing the port.
    if (parsed.token) {
      e.preventDefault()
      setModalConnection(parsed.baseUrl)
      setModalToken(parsed.token)
    }
  }

  // Ping the backend to confirm reachability before saving. Does not persist.
  const handleTestBackend = async () => {
    setModalTesting(true)
    setModalTestResult(null)
    setModalError(null)
    try {
      const parsed = normalizeConnectionInput(modalConnection)
      const baseUrl = parsed?.baseUrl ?? modalConnection.trim()
      const token = modalToken.trim()
      if (!baseUrl || !token) throw new Error('URL and token are required')
      const { AgentHomeApi } = await import('./api')
      const api = new AgentHomeApi({ baseUrl, token })
      await api.getAgents()
      setModalTestResult({ ok: true, message: 'Reachable — agents list loaded' })
    } catch (e) {
      setModalTestResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setModalTesting(false)
    }
  }

  // Save (create or edit) the backend from the modal fields. On create, also
  // activate it and boot the controller onto it.
  const handleSaveBackend = async () => {
    setModalError(null)
    const parsed = normalizeConnectionInput(modalConnection)
    const baseUrl = parsed?.baseUrl ?? modalConnection.trim()
    const token = modalToken.trim()
    const name = modalName.trim() || baseUrl
    if (!baseUrl || !token) {
      setModalError('A connection URL (host:port) and a token are required.')
      return
    }
    try {
      if (editingBackendId) {
        await saveBackend(editingBackendId, { name, baseUrl, token })
        // If it was the active backend, re-boot to apply the new connection.
        if (getActiveBackend()?.id === editingBackendId && controller) {
          refreshActiveConfigView()
          controller.boot()
        }
      } else {
        const created = await upsertBackend({ name, baseUrl, token, prefs: {}, agentConfigs: {} })
        await setActiveBackend(created.id, () => refreshActiveConfigView())
        refreshActiveConfigView()
        setConfig(getApiConfig())
        setAgentConfigs(getAgentConfigs())
        setAgentRefreshNonce((n) => n + 1)
        if (controller) controller.boot()
      }
      setBackendModalOpen(false)
      bumpBackends()
    } catch (e) {
      setModalError(e instanceof Error ? e.message : String(e))
    }
  }

  // Switch to a different backend immediately and boot onto it.
  const handleSwitchBackend = async (id: string) => {
    if (getActiveBackend()?.id === id) return
    await setActiveBackend(id, () => refreshActiveConfigView())
    refreshActiveConfigView()
    setConfig(getApiConfig())
    setAgentConfigs(getAgentConfigs())
    setAgentRefreshNonce((n) => n + 1)
    if (controller) controller.boot()
    bumpBackends()
  }

  // Remove a backend with a confirm. If it was active, the controller re-boots
  // onto the fallback (or shows the empty state).
  const handleRemoveBackend = async (backend: Backend) => {
    if (!window.confirm(`Remove backend "${backend.name}"? Sessions live on the server and are not deleted.`)) return
    const res = await removeBackend(backend.id, () => refreshActiveConfigView())
    refreshActiveConfigView()
    setConfig(getApiConfig())
    setAgentConfigs(getAgentConfigs())
    if (res.activeChanged) {
      setAgentRefreshNonce((n) => (isBackendConfigured(getApiConfig()) ? n + 1 : n))
      if (controller) controller.boot()
    }
    bumpBackends()
  }
```

- [ ] **Step 4: Replace the legacy Backend Configuration card with the Backends section**

In `web/src/App.tsx`, in the settings JSX (the `) : (` branch), find the first card:

```tsx
            <section className="card config-card">
              <h2>Backend Configuration</h2>
              <div className="input-group" style={{ marginTop: '1rem' }}>
                <label>Backend URL</label>
                <input
                  type="text"
                  value={config.baseUrl}
                  onChange={e => setConfig({...config, baseUrl: e.target.value})}
                  onPaste={handleBaseUrlPaste}
                  placeholder="http://<BACKEND_SERVER>:<PORT>"
                />
              </div>
              <div className="input-group">
                <label>Secure Token</label>
                <input
                  type="password"
                  value={config.token}
                  onChange={e => setConfig({...config, token: e.target.value})}
                />
              </div>
            </section>
```

Replace that whole `<section>` with:

```tsx
            <section className="card config-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Backends</h2>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  {activeBackend ? `Active: ${activeBackend.name}` : 'No active backend'}
                </span>
              </div>

              <div className="backends-list" style={{ marginTop: '1rem' }}>
                {backendsList.length === 0 && (
                  <div className="backend-empty" style={{ padding: '1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No backends connected. Connect your first backend to get started.
                  </div>
                )}
                {backendsList.map((b) => {
                  const isActive = activeBackend?.id === b.id
                  return (
                    <div
                      key={b.id}
                      className={`backend-row${isActive ? ' backend-row-active' : ''}`}
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px', marginBottom: '8px', borderRadius: '8px', border: '1px solid var(--border-light)', background: isActive ? 'rgba(59, 130, 246, 0.12)' : 'rgba(30, 41, 59, 0.5)', cursor: isActive ? 'default' : 'pointer' }}
                      onClick={() => !isActive && handleSwitchBackend(b.id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <span style={{ fontSize: '1.1rem' }}>{isActive ? '●' : '○'}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{b.baseUrl.replace(/^https?:\/\//, '')}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {isActive && <span className="backend-active-chip" style={{ fontSize: '0.75rem', padding: '3px 8px', borderRadius: '999px', background: 'rgba(59, 130, 246, 0.25)', color: 'var(--text-main)' }}>active</span>}
                        <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); openEditModal(b) }} style={{ padding: '5px 10px' }}>Edit</button>
                        <button type="button" className="btn" onClick={(e) => { e.stopPropagation(); handleRemoveBackend(b) }} style={{ padding: '5px 10px' }} aria-label={`Remove ${b.name}`}>⋯</button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <button type="button" className="btn primary-btn" onClick={openConnectModal} style={{ width: '100%', marginTop: '0.5rem' }}>+ Connect New Backend</button>
            </section>
```

Also delete the now-unused `handleBaseUrlPaste` handler and `parseConnectionUrl` function from App.tsx (they are superseded by the modal + `normalizeConnectionInput`). To delete `parseConnectionUrl`, remove the whole function (the block starting `function parseConnectionUrl(input: string)` through its closing `}`). To delete `handleBaseUrlPaste`, remove the whole `const handleBaseUrlPaste = ...` arrow function.

- [ ] **Step 5: Add the Connect/Edit modal JSX**

In `web/src/App.tsx`, just before the closing `</main>` of the settings branch (i.e. right before the line `        )}` that closes the `: (` settings branch — find `</div>\n        )}` near the end of the settings view), insert the modal:

```tsx
            {backendModalOpen && (
              <div className="backend-modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }} onClick={() => setBackendModalOpen(false)}>
                <div className="backend-modal card" style={{ width: 'min(92vw, 460px)', padding: '1.25rem', background: 'rgba(15, 23, 42, 0.98)' }} onClick={(e) => e.stopPropagation()}>
                  <h2 style={{ margin: '0 0 1rem 0' }}>{editingBackendId ? 'Edit Backend' : 'Connect Backend'}</h2>
                  <div className="input-group">
                    <label>Name</label>
                    <input type="text" value={modalName} onChange={(e) => setModalName(e.target.value)} placeholder="e.g. Work Laptop" />
                  </div>
                  <div className="input-group">
                    <label>Connection</label>
                    <input type="text" value={modalConnection} onChange={(e) => setModalConnection(e.target.value)} onPaste={handleModalConnectionPaste} placeholder="http://host:port?token=…  or  host:port" />
                  </div>
                  <div className="input-group">
                    <label>Token</label>
                    <input type="password" value={modalToken} onChange={(e) => setModalToken(e.target.value)} placeholder="Shared secret token" />
                  </div>
                  {modalTestResult && (
                    <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', color: modalTestResult.ok ? '#22c55e' : '#ef4444' }}>
                      {modalTestResult.ok ? '✓ ' : '✗ '}{modalTestResult.message}
                    </div>
                  )}
                  {modalError && (
                    <div style={{ fontSize: '0.85rem', marginBottom: '0.5rem', color: '#ef4444' }}>{modalError}</div>
                  )}
                  <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                    <button type="button" className="btn" onClick={handleTestBackend} disabled={modalTesting}>{modalTesting ? 'Testing…' : 'Test'}</button>
                    <button type="button" className="btn" onClick={() => setBackendModalOpen(false)}>Cancel</button>
                    <button type="button" className="btn primary-btn" onClick={handleSaveBackend}>{editingBackendId ? 'Save' : 'Connect'}</button>
                  </div>
                </div>
              </div>
            )}
```

- [ ] **Step 6: Verify the build (types + lint)**

Run: `npm run build` (from `web/`)

Expected: build SUCCEEDS with no TypeScript errors. Watch for: unused imports (`parseConnectionUrl`/`handleBaseUrlPaste` removed cleanly), the `Backend` type import being used, and no `any` violations beyond the existing eslint-disable lines.

- [ ] **Step 7: Run the unit tests (still green; UI not unit-tested)**

Run: `npm run test:unit` (from `web/`)

Expected: all unit tests PASS. (The UI changes are validated by the simulator E2E in Task 8.)

- [ ] **Step 8: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(ui): Backends section + Connect/Edit modal for multi-backend"
```

---

## Task 7: CSS polish for the Backends UI

**Files:**
- Modify: `web/src/style.css`

- [ ] **Step 1: Append the multi-backend styles to `style.css`**

Append to the end of `web/src/style.css`:

```css
/* ---- Multi-backend Settings UI ---- */
.backends-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.backend-row {
  transition: background 0.12s ease, border-color 0.12s ease, transform 0.05s ease;
}
.backend-row:not(.backend-row-active):hover {
  background: rgba(59, 130, 246, 0.08);
  border-color: rgba(59, 130, 246, 0.4);
}
.backend-row:not(.backend-row-active):active {
  transform: translateY(1px);
}
.backend-row-active {
  border-color: rgba(59, 130, 246, 0.5);
}

.backend-active-chip {
  font-weight: 600;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}

.backend-modal-backdrop {
  backdrop-filter: blur(2px);
}
.backend-modal {
  border: 1px solid var(--border-light);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  border-radius: 10px;
}
.backend-modal .input-group {
  margin-bottom: 0.75rem;
}
.backend-empty {
  border: 1px dashed var(--border-light);
  border-radius: 8px;
}
```

- [ ] **Step 2: Verify the build still passes**

Run: `npm run build` (from `web/`)

Expected: build SUCCEEDS.

- [ ] **Step 3: Commit**

```bash
git add web/src/style.css
git commit -m "style(ui): polish Backends list + Connect/Edit modal"
```

---

## Task 8: Simulator E2E validation

The glasses/main UI is unchanged, so the existing fuzzy-test golden transitions must still pass. This task confirms no regression and that the app boots correctly in fixture mode.

**Files:** none (validation only)

- [ ] **Step 1: Run the simulator E2E**

Run: `npm run test:simulator` (from `web/`)

Expected: the default 100-iteration fuzzy run finishes with **0 failures**. Per `PROJECT_LEARNINGS §2`, code is not complete until this passes with 0 failures.

If a transition fails: the most likely cause is a boot-path regression (the controller's `getApiConfig()` returning empty when it shouldn't). Check that `hydrateBackends` is awaited before `ctrl.boot()` in the App mount effect — but note: App.tsx already calls `ctrl.boot()` only after the force-hydrate, and `boot()` itself guards on empty config (shows the "configure" message instead of fetching). The fuzzy harness seeds a working backend, so if it sees the "configure" screen instead of the agent list, the active-backend view isn't being populated from the seeded registry — verify the simulator seeds the `backends` key (or legacy `apiConfig`) before the app boots.

- [ ] **Step 2: If the simulator seeds the legacy `apiConfig` key, confirm migration runs**

Check the simulator/fixture setup. If it writes `apiConfig` (the legacy key), migration will import it on first boot. If it writes neither `apiConfig` nor `backends`, the app will correctly show the empty state and the fuzzy test will fail on the first agent-list assertion — in that case, update the simulator seed to write a `backends` registry (or keep writing `apiConfig` and rely on migration). Document whichever path applies in the commit message.

- [ ] **Step 3: Commit any simulator-seed fix (if needed)**

Only if Step 2 required a change:

```bash
git add scripts/fuzzy-test.mjs   # or whichever seed file changed
git commit -m "test(simulator): seed multi-backend registry for fixture boot"
```

If no change was needed, skip this step — the validation is the deliverable.

---

## Final verification

- [ ] **Step 1: Full unit suite**

Run: `npm run test:unit` (from `web/`)

Expected: ALL PASS.

- [ ] **Step 2: Full build + types**

Run: `npm run build` (from `web/`)

Expected: SUCCEEDS.

- [ ] **Step 3: Full simulator E2E**

Run: `npm run test:simulator` (from `web/`)

Expected: 0 failures over the default iterations.

- [ ] **Step 4: Manual happy-path checklist (per TESTING_PLAN §F)**

Verify by running `npm run dev` (from `web/`) against a real or fixture backend:
1. Fresh install (no keys): empty state → connect a backend → agents load → send a message.
2. Upgrade from an existing single-backend install: existing config appears as one named backend, auto-selected, agents load with no Save click.
3. Connect a 2nd backend via URL paste (auto-split) → switch to it → its agents load; switching back restores the first backend's agent config + prefs.
4. Edit a backend's token → Save → messages still work.
5. Remove the active backend → app falls back to the other backend and re-boots; remove the last backend → empty state.
6. Restart the app → the last-connected backend auto-connects on startup.

- [ ] **Step 5: Final commit (if any doc/spec tweaks arose during execution)**

```bash
git add -A
git commit -m "chore: final verification pass for multi-backend"
git log --oneline -10
```

---

## Self-review notes

- **Spec coverage:** Every spec section maps to a task — data model (T1/T2), migration (T2), registry ops incl. switch atomicity (T3), api.ts adapter (T4), adapter tests (T5), Backends UI + modal (T6), CSS (T7), E2E + manual (T8 + final). The four startup/storage invariants are preserved by keeping the api.ts public surface identical (T4) and guarded by the adapter tests (T5) + the existing controller/storage/configHelpers tests.
- **Type consistency:** `Backend.id` is always a `string`; `BackendPrefs` field names (`yolo`, `debugView`, `autoScrollLastExchange`, `scrollSpeed`) match `AuthConfig`'s field names exactly so the flattening in `refreshActiveView` maps 1:1. `AgentProviderConfig` is imported as a TYPE from api.ts into backends.ts (no runtime cycle).
- **Import cycle risk:** api.ts imports from backends.ts at runtime; backends.ts imports only `type { AgentProviderConfig }` from api.ts (erased at compile) plus `storageGet/Set` from storage.ts. No runtime cycle. If the test runner complains, move the `type` import to a `import type` line (it already is).
