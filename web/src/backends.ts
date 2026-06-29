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
