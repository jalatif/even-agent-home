import {
  hydrateBackends,
  getActiveBackend,
  getBackend,
  peekRegistry,
  saveBackend as saveBackendForActive,
  upsertBackend,
  setActiveBackend,
  nameFromBaseUrl,
  __resetBackendsStateForTests,
} from './backends.ts'
import { pcmChunksToWav } from './audio/wav.ts'
import { getSttServerUrl } from './sttSettings.ts'

// Empty by default: the settings input shows its placeholder hint
// (http://<BACKEND_SERVER>:<PORT>) and the app shows its "please configure"
// empty state until the user enters a URL or scans a QR code. Previously this
// auto-filled from the current page origin (sameOriginBaseUrl), but that
// guessed wrong in dev (localhost:<vite-port>/api, which isn't a backend) and
// was confusing for the common multi-host case (glasses on LAN → separate
// bridge). Users always connect via QR/URL anyway, so the hint is clearer.
export const defaultApiBaseUrl = ''

export interface AuthConfig {
  baseUrl: string
  token: string
  debugView?: boolean
  yolo?: boolean
  autoScrollLastExchange?: boolean
  scrollSpeed?: 'slow' | 'medium' | 'fast'
  /** @deprecated Use autoScrollLastExchange and scrollSpeed. */
  autoScrollMode?: 'off' | 'slow' | 'medium' | 'fast'
}

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

function configFromLocation(): { token?: string; explicitBaseUrl?: string } {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  return {
    token: params.get('token') || undefined,
    explicitBaseUrl: params.get('baseUrl') || undefined,
  }
}

/**
 * Read the auth config from the persistent store and seed the in-memory active
 * view. Now backed by the multi-backend registry: hydrate the registry (which
 * handles bridge-vs-localStorage precedence and legacy migration), then rebuild
 * the active view from the active backend. URL params are layered ON TOP of the
 * active backend's persisted fields (same priority as before: defaults <
 * persisted active backend < URL params) so a deep link refreshes credentials
 * without wiping prefs. Idempotent; pass `force: true` to bypass the flag and
 * re-read (needed after the bridge becomes available — see hydrateBackends).
 *
 * Deep-link connect: if a deep link carries a baseUrl+token (the connect URL a
 * user pastes / the QR encodes) and there is no active backend yet, auto-create
 * and activate a backend from those credentials. This keeps the "open the app
 * via connect URL" onboarding path working under multi-backend, and means the
 * glasses/main UI boots onto the connected backend rather than the empty state.
 */
export async function hydrateApiConfig(force = false): Promise<AuthConfig> {
  if (configHydrated && !force) return currentConfig
  await hydrateBackends(force)
  refreshActiveView()
  const { token, explicitBaseUrl } = configFromLocation()
  // Deep-link connect when there is no active backend: create one from the
  // connect URL so the app boots onto it. (If an active backend already
  // exists, the params just layer on top as a credential refresh.)
  if (!getActiveBackend() && explicitBaseUrl && token) {
    try {
      const created = await upsertBackend({
        name: nameFromBaseUrl(explicitBaseUrl),
        baseUrl: explicitBaseUrl,
        token,
        prefs: {},
        agentConfigs: {},
      })
      await setActiveBackend(created.id)
      refreshActiveView()
    } catch {
      // Cap reached (or another transient error) — fall through to layering
      // the credentials onto currentConfig so the app can still boot instead
      // of crashing on the deep-link connect path.
      currentConfig = {
        ...currentConfig,
        baseUrl: explicitBaseUrl,
        token,
      }
    }
  } else {
    currentConfig = {
      ...currentConfig,
      ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
      ...(token ? { token } : {}),
    }
  }
  configHydrated = true
  return currentConfig
}

export async function hydrateAgentConfigs(force = false): Promise<Record<string, AgentProviderConfig>> {
  if (agentConfigsHydrated && !force) return currentAgentConfigs
  await hydrateBackends(force)
  refreshActiveView()
  agentConfigsHydrated = true
  return currentAgentConfigs
}

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
    if (getBackend(activeId)) {
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

export function getApiConfig(): AuthConfig {
  if (!configHydrated && typeof window !== 'undefined') {
    // First call before hydration completed — kick off the async hydrate
    // so a subsequent reload can pick up saved values. We still return the
    // defaults so the controller has something usable.
    void hydrateApiConfig()
  }
  return currentConfig
}

export interface AgentProviderConfig {
  enabled: boolean
  model: string
  thinking?: string

}

export interface ModelListResponse {
  models: string[]
  source?: 'static' | 'refreshed' | 'empty' | 'unavailable'
  status?: 'idle' | 'refreshing' | 'complete' | 'error' | 'unavailable'
  available?: boolean
  refreshedAt?: string | null
  error?: string | null
}

export async function getAgentConfigs(): Promise<Record<string, AgentProviderConfig>> {
  if (!agentConfigsHydrated) await hydrateAgentConfigs()
  return currentAgentConfigs
}

export async function saveAgentConfigs(configs: Record<string, AgentProviderConfig>): Promise<void> {
  currentAgentConfigs = configs
  const activeId = peekRegistry().activeBackendId
  if (activeId) {
    await saveBackendForActive(activeId, { agentConfigs: configs })
  }
}

/**
 * Rebuild the active view from the registry's active backend. Called by the
 * UI after setActiveBackend / removeBackend so the controller's next
 * getApi()/getApiConfig() reads the newly-active backend's slice. Public so
 * App.tsx can trigger it without importing backends.ts directly.
 */
export function refreshActiveConfigView(): void {
  refreshActiveView()
}

export function getApi() {
  return new AgentHomeApi(currentConfig)
}

export class AgentHomeApi {
  private config: AuthConfig
  constructor(config: AuthConfig) {
    this.config = config
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.token}`,
      'X-AgentHome-Auth': this.config.token,
      'X-AgentHome-Encrypted': '1'
    }
  }

  private async fetchEncrypted(url: string, options: RequestInit = {}) {
    const { encryptPayload, decryptPayload } = await import('./crypto.ts');
    
    // Encrypt outgoing body if present
    if (options.body && typeof options.body === 'string') {
      const encryptedData = await encryptPayload(options.body, this.config.token);
      options.body = JSON.stringify({ encryptedPayload: encryptedData });
    }

    options.headers = { ...options.headers, ...this.headers };

    const res = await fetch(url, options);
    let data = await res.json().catch(() => ({}));
    // Decrypt incoming payload before status handling so encrypted error
    // responses can still surface their real message on the glasses. A decrypt
    // failure (AES-GCM auth-tag mismatch from a wrong/rotated token, or a
    // truncated payload) must surface as a DISTINCT auth error — otherwise the
    // raw DOMException propagates and boot() misreports it as a connectivity
    // problem ("Unable to connect to backend"), sending the user down the
    // wrong debugging path.
    if (data.encryptedPayload) {
      try {
        const decryptedData = await decryptPayload(data.encryptedPayload, this.config.token);
        data = JSON.parse(decryptedData);
      } catch {
        throw new Error('Authentication failed — the backend token may be incorrect or rotated. Check the backend connection token in Settings.')
      }
    }
    if (!res.ok) {
      const message = typeof data.error === 'string' && data.error.trim()
        ? data.error
        : `Fetch failed: ${res.statusText || res.status}`
      throw new Error(message);
    }
    return data;
  }

  private get apiBaseUrl() {
    const baseUrl = this.config.baseUrl.trim()
    if (!baseUrl || !this.config.token.trim()) {
      throw new Error('Agent Home backend is not configured')
    }
    return baseUrl.replace(/\/api\/?$/, '') + '/api'
  }

  async getAgents(): Promise<string[]> {
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/agents`)
    return data.agents || []
  }

  async getModels(agent: string): Promise<string[]> {
    const data = await this.getModelsDetailed(agent)
    return data.models || []
  }

  async getModelsDetailed(agent: string): Promise<ModelListResponse> {
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/models?agent=${encodeURIComponent(agent)}`)
    return { ...data, models: data.models || [] }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getSessions(agent: string): Promise<any[]> {
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/sessions?agent=${encodeURIComponent(agent)}`)
    return data.sessions || []
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getHistory(agent: string, sessionId: string): Promise<any[]> {
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/history?agent=${encodeURIComponent(agent)}&sessionId=${encodeURIComponent(sessionId)}`)
    return data.history || []
  }

  async getStatus(agent: string, sessionId: string): Promise<{ state: string; error?: string }> {
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/status?provider=${encodeURIComponent(agent)}&sessionId=${encodeURIComponent(sessionId)}`)
    return { state: data.state || 'idle', error: data.error }
  }
  async prompt(agent: string, sessionId: string, text: string, model?: string, thinking?: string, yolo?: boolean): Promise<{ sessionId: string }> {
    return await this.fetchEncrypted(`${this.apiBaseUrl}/prompt`, {
      method: 'POST',
      body: JSON.stringify({ provider: agent, sessionId, text, model, thinking, yolo })
    })
  }

  async interrupt(agent: string, sessionId: string): Promise<void> {
    await this.fetchEncrypted(`${this.apiBaseUrl}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ provider: agent, sessionId })
    })
  }

  async transcribeAudio(pcmData: Uint8Array): Promise<string> {
    // Optional global override: if the user configured a Custom STT Server URL
    // (Settings, not tied to a backend), post a multipart WAV directly to that
    // server with NO encryption/auth — the custom server has no backend token
    // to decrypt the encrypted channel, so it must use the plain multipart
    // contract documented in docs/custom-stt-server.md. Only `.text` is read.
    const customUrl = getSttServerUrl().trim()
    if (customUrl) {
      return await this.transcribeAudioCustom(pcmData, customUrl)
    }

    // Default: STT is resolved by the active BACKEND. The provider (built-in
    // Whisper, Deepgram, OpenAI Whisper) is selected by the backend's
    // --stt-provider-url / --stt-provider-key flags, keeping any provider API
    // key server-side only. The frontend just ships the raw PCM over the
    // encrypted bridge channel to /api/transcribe.
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ audio: Array.from(pcmData) })
    })
    return data.text || ''
  }

  /**
   * Send audio to a user-configured custom STT server (plain multipart WAV,
   * no encryption/auth). The server must accept `POST /api/transcribe` with a
   * multipart `audio` field (a WAV file) and return JSON `{ "text": "..." }`.
   * Non-2xx surfaces a readable error to the user as the transcript error.
   */
  private async transcribeAudioCustom(pcmData: Uint8Array, baseUrl: string): Promise<string> {
    const wav = pcmChunksToWav([pcmData])
    const form = new FormData()
    form.append('audio', wav, 'audio.wav')
    // Normalize the path the same way `apiBaseUrl` does: strip a trailing slash
    // and any `/api` suffix, then re-append `/api/transcribe`. This lets users
    // paste either `https://host`, `https://host/`, or `https://host/api`.
    const normalizedBase = baseUrl.replace(/\/+$/, '').replace(/\/api\/?$/, '')
    const url = `${normalizedBase}/api/transcribe`
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', body: form })
    } catch {
      throw new Error(`Could not reach custom STT server at ${normalizedBase}. Check the STT Server URL in Settings.`)
    }
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      const detail = text.trim().slice(0, 200)
      throw new Error(`Custom STT server error ${res.status}${detail ? `: ${detail}` : ''}`)
    }
    try {
      const data = JSON.parse(text)
      return data.text || ''
    } catch {
      throw new Error('Custom STT server returned an invalid (non-JSON) response')
    }
  }
}
