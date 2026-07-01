/**
 * Global "Custom STT Server URL" setting.
 *
 * Unlike the connection + app prefs (which live per-backend in the `backends`
 * registry blob), this is a single GLOBAL setting that is NOT tied to any
 * backend — the same custom STT server applies regardless of which backend is
 * active. It therefore gets its own standalone KV key, the same standalone-key
 * pattern used by `sim-settings.ts`.
 *
 * When blank (the default), transcription uses the active backend's
 * `/api/transcribe` exactly as before (encrypted PCM array). When set,
 * `AgentHomeApi.transcribeAudio` posts a multipart WAV directly to
 * `${url}/api/transcribe` with no encryption/auth headers (the custom server
 * has no backend token to decrypt the encrypted channel).
 *
 * The in-memory cache is read synchronously on the transcription hot path by
 * `transcribeAudio`; hydrate/set are async because they touch the bridge KV
 * store (which may round-trip to the phone's app-scoped storage).
 */

import { storageGet, storageSet, storageRemove } from './storage.ts'

const STT_SERVER_URL_KEY = 'sttServerUrl'

let cachedSttServerUrl = ''
let sttServerUrlHydrated = false

/**
 * Return the cached custom STT server URL (sync). This is the value
 * `transcribeAudio` reads on the hot path. Returns '' until hydration has run.
 */
export function getSttServerUrl(): string {
  return cachedSttServerUrl
}

/**
 * Read the persisted STT server URL from the KV store and seed the in-memory
 * cache. Idempotent; pass `force: true` to bypass the hydrated flag and re-read
 * (needed after the bridge becomes available — the pre-bridge pass read from
 * the localStorage fallback, so a post-bridge `force` read is required to pick
 * up the value the phone actually persisted, same reason as
 * `hydrateApiConfig(true)`).
 */
export async function hydrateSttServerUrl(force = false): Promise<string> {
  if (sttServerUrlHydrated && !force) return cachedSttServerUrl
  const raw = (await storageGet(STT_SERVER_URL_KEY)) ?? ''
  cachedSttServerUrl = typeof raw === 'string' ? raw.trim() : ''
  sttServerUrlHydrated = true
  return cachedSttServerUrl
}

/**
 * Persist + cache the STT server URL. The cache is updated synchronously first
 * so hot-path reads stay consistent while the bridge write is in flight, then
 * the write is awaited.
 */
export async function setSttServerUrl(url: string): Promise<void> {
  const next = typeof url === 'string' ? url.trim() : ''
  cachedSttServerUrl = next
  sttServerUrlHydrated = true
  if (next) {
    await storageSet(STT_SERVER_URL_KEY, next)
  } else {
    // Clear the key when emptied so we don't leave a stale empty string that
    // could mask a future non-empty value during a partial bridge read.
    await storageRemove(STT_SERVER_URL_KEY)
  }
}

/**
 * Reset the in-memory cache back to the initial default. Used by tests that
 * need to assert on the fresh-hydration path; production code never calls this.
 * Exported with an underscored name to signal it is not part of the public
 * surface (mirrors `__resetApiStateForTests`).
 */
export function __resetSttStateForTests(): void {
  cachedSttServerUrl = ''
  sttServerUrlHydrated = false
}
