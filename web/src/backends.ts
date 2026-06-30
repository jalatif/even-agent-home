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

/** Maximum number of backends a user may have saved at once. */
export const MAX_BACKENDS = 5

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

  // Full URL with scheme + optional ?token=. Only accept the connect-URL form
  // `http(s)://host:port[?token=...]` — a URL with a real path (e.g.
  // `http://x/api/foo`) is a mispaste, not a backend connect URL, so reject it
  // rather than silently dropping the path.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.pathname !== '/' && parsed.pathname !== '') return null
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
  let legacy: { baseUrl?: string; token?: string; yolo?: boolean; debugView?: boolean; autoScrollLastExchange?: boolean; scrollSpeed?: 'slow' | 'medium' | 'fast'; autoScrollMode?: 'off' | 'slow' | 'medium' | 'fast' } = {}
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

  // Migrate the legacy deprecated `autoScrollMode` ('off'|'slow'|'medium'|
  // 'fast') into the current `autoScrollLastExchange` + `scrollSpeed` fields,
  // exactly as the old api.ts migrateLegacyConfig did. Only applies when the
  // new fields are absent (a real saved value wins).
  let autoScrollLastExchange = legacy.autoScrollLastExchange
  let scrollSpeed = legacy.scrollSpeed
  const legacyAutoScrollMode = legacy.autoScrollMode
  if (legacyAutoScrollMode && autoScrollLastExchange === undefined && scrollSpeed === undefined) {
    autoScrollLastExchange = legacyAutoScrollMode !== 'off'
    if (legacyAutoScrollMode !== 'off') scrollSpeed = legacyAutoScrollMode
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
      autoScrollLastExchange,
      scrollSpeed,
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

/** Number of saved backends (regardless of which is active). */
export function getBackendsCount(): number {
  return currentRegistry.backends.length
}

/**
 * Ordered list for the UI, in STABLE insertion order (the order backends were
 * added). Selecting a backend as active does NOT reorder the list — the active
 * backend is indicated by highlighting + a chip on its row, not by position —
 * because reordering on click is disorienting. `recentBackendIds` is kept for
 * the removeBackend fallback only.
 */
export function getBackendsList(): Backend[] {
  return currentRegistry.backends.map((b) => b)
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
 *   3. refresh the api.ts active view (via the optional hook, kept external to
 *      avoid an import cycle with api.ts),
 *   4. persist.
 * No-op if the id is not found. Returns true if the active backend changed.
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
 * Clear the active backend (a "Stop"/disconnect): sets activeBackendId to null
 * WITHOUT removing any backends. The active view collapses to empty defaults
 * until the user selects a backend again. Returns true if something was
 * actually cleared. The saved backends (and the last-active id in
 * recentBackendIds) are preserved so re-selecting restores them.
 */
export async function clearActiveBackend(onActiveChanged?: () => void): Promise<boolean> {
  if (currentRegistry.activeBackendId === null) return false
  currentRegistry = {
    ...currentRegistry,
    activeBackendId: null,
  }
  if (onActiveChanged) onActiveChanged()
  await persist()
  return true
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
