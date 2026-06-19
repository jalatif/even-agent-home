import { storageGet, storageSet } from './storage.ts'

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

const API_CONFIG_KEY = 'apiConfig'
const AGENT_CONFIGS_KEY = 'agentConfigs'

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

function configFromLocation(): { token?: string; explicitBaseUrl?: string } {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  return {
    token: params.get('token') || undefined,
    explicitBaseUrl: params.get('baseUrl') || undefined,
  }
}


function migrateLegacyConfig(parsed: Partial<AuthConfig>): Partial<AuthConfig> {
  const out: Partial<AuthConfig> = { ...parsed }
  if (
    parsed.autoScrollMode &&
    parsed.autoScrollLastExchange === undefined &&
    parsed.scrollSpeed === undefined
  ) {
    out.autoScrollLastExchange = parsed.autoScrollMode !== 'off'
    if (parsed.autoScrollMode !== 'off') out.scrollSpeed = parsed.autoScrollMode
  }
  delete out.autoScrollMode
  return out
}

/**
 * Read the auth config from the persistent store (bridge KV, with
 * `localStorage` fallback) and seed the in-memory cache. URL params are
 * layered ON TOP of the saved config so a deep link refreshes credentials
 * without wiping unrelated saved fields (yolo, debugView, scroll prefs,
 * etc.). Idempotent — repeated calls are cheap because they hit the cache
 * after the first hydration.
 *
 * Pass `force: true` to bypass the `configHydrated` short-circuit. This is
 * needed after the EvenHub bridge becomes available: the first hydration
 * (pre-bridge) reads from the `localStorage` fallback and sets the flag,
 * so without `force` the post-bridge re-hydration would never consult the
 * durable bridge KV store and would lock in stale/empty defaults.
 */
export async function hydrateApiConfig(force = false): Promise<AuthConfig> {
  if (configHydrated && !force) return currentConfig
  let saved: Partial<AuthConfig> = {}
  try {
    const raw = await storageGet(API_CONFIG_KEY)
    if (raw) saved = migrateLegacyConfig(JSON.parse(raw))
  } catch (e) {
    console.warn('[api] failed to read apiConfig from storage', e)
  }
  // Layering rules (lowest → highest priority):
  //   1. Hard defaults (currentConfig's initial values) — baseUrl is '' so
  //      the settings placeholder hint shows until the user configures it.
  //   2. Persisted fields (token, baseUrl, yolo, debug, scroll prefs).
  //      Saved fields ALWAYS win over the empty default.
  //   3. URL params. `?token=` alone refreshes the token without rewriting
  //      baseUrl. `?baseUrl=` (explicit) overrides saved.
  const { token, explicitBaseUrl } = configFromLocation()
  currentConfig = {
    ...currentConfig,
    ...saved,
    ...(explicitBaseUrl ? { baseUrl: explicitBaseUrl } : {}),
    ...(token ? { token } : {}),
  }
  configHydrated = true
  return currentConfig
}

export async function hydrateAgentConfigs(force = false): Promise<Record<string, AgentProviderConfig>> {
  if (agentConfigsHydrated && !force) return currentAgentConfigs
  try {
    const raw = await storageGet(AGENT_CONFIGS_KEY)
    if (raw) currentAgentConfigs = JSON.parse(raw)
  } catch (e) {
    console.warn('[api] failed to read agentConfigs from storage', e)
  }
  agentConfigsHydrated = true
  return currentAgentConfigs
}

export async function setApiConfig(config: AuthConfig): Promise<void> {
  const nextConfig = { ...config }
  delete nextConfig.autoScrollMode
  currentConfig = nextConfig
  try {
    await storageSet(API_CONFIG_KEY, JSON.stringify(nextConfig))
  } catch (e) {
    console.warn('[api] failed to save apiConfig to storage', e)
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
  try {
    await storageSet(AGENT_CONFIGS_KEY, JSON.stringify(configs))
  } catch (e) {
    console.warn('[api] failed to save agentConfigs to storage', e)
  }
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
    const { encryptPayload, decryptPayload } = await import('./crypto');
    
    // Encrypt outgoing body if present
    if (options.body && typeof options.body === 'string') {
      const encryptedData = await encryptPayload(options.body, this.config.token);
      options.body = JSON.stringify({ encryptedPayload: encryptedData });
    }

    options.headers = { ...options.headers, ...this.headers };

    const res = await fetch(url, options);
    let data = await res.json().catch(() => ({}));
    // Decrypt incoming payload before status handling so encrypted error
    // responses can still surface their real message on the glasses.
    if (data.encryptedPayload) {
      const decryptedData = await decryptPayload(data.encryptedPayload, this.config.token);
      data = JSON.parse(decryptedData);
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
    return this.config.baseUrl.replace(/\/api\/?$/, '') + '/api'
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

  async transcribeAudio(pcmData: Uint8Array): Promise<string> {
    // STT is always resolved by the BACKEND. The provider (built-in Whisper,
    // Deepgram, OpenAI Whisper) is selected by the backend's
    // --stt-provider-url / --stt-provider-key flags, keeping any provider API
    // key server-side only. The frontend just ships the raw PCM over the
    // encrypted bridge channel to /api/transcribe.
    const data = await this.fetchEncrypted(`${this.apiBaseUrl}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ audio: Array.from(pcmData) })
    })
    return data.text || ''
  }
}
