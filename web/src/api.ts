export const defaultApiBaseUrl = 'http://localhost:3456'

export interface AuthConfig {
  baseUrl: string
  token: string
  sttUrl?: string
  debugView?: boolean
  yolo?: boolean
  autoScrollLastExchange?: boolean
  scrollSpeed?: 'slow' | 'medium' | 'fast'
  /** @deprecated Use autoScrollLastExchange and scrollSpeed. */
  autoScrollMode?: 'off' | 'slow' | 'medium' | 'fast'
}

function configFromLocation(): Partial<AuthConfig> {
  if (typeof window === 'undefined') return {}
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') || undefined
  const explicitBaseUrl = params.get('baseUrl') || undefined
  const sameOriginBaseUrl = `${window.location.protocol}//${window.location.host}/api`
  const tokenBaseUrl = window.location.port === '5173' ? defaultApiBaseUrl : sameOriginBaseUrl
  const baseUrl = explicitBaseUrl || (token ? tokenBaseUrl : undefined)
  return { ...(baseUrl ? { baseUrl } : {}), ...(token ? { token } : {}) }
}

let currentConfig: AuthConfig = {
  baseUrl: defaultApiBaseUrl,
  token: '',
  autoScrollLastExchange: true,
  scrollSpeed: 'medium',
}

try {
  const saved = localStorage.getItem('apiConfig')
  if (saved) {
    const savedConfig = JSON.parse(saved)
    currentConfig = { ...currentConfig, ...savedConfig }
    if (savedConfig.autoScrollMode && savedConfig.autoScrollLastExchange === undefined && savedConfig.scrollSpeed === undefined) {
      currentConfig.autoScrollLastExchange = savedConfig.autoScrollMode !== 'off'
      if (savedConfig.autoScrollMode !== 'off') currentConfig.scrollSpeed = savedConfig.autoScrollMode
    }
  }
  currentConfig = { ...currentConfig, ...configFromLocation() }
} catch {
  // intentionally empty
}

export function setApiConfig(config: AuthConfig) {
  const nextConfig = { ...config }
  delete nextConfig.autoScrollMode
  currentConfig = nextConfig
  localStorage.setItem('apiConfig', JSON.stringify(nextConfig))
}

export function getApiConfig() {
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

export function getAgentConfigs(): Record<string, AgentProviderConfig> {
  try {
    return JSON.parse(localStorage.getItem('agentConfigs') || '{}')
  } catch {
    return {}
  }
}

export function saveAgentConfigs(configs: Record<string, AgentProviderConfig>) {
  localStorage.setItem('agentConfigs', JSON.stringify(configs))
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
    if (!res.ok) throw new Error(`Fetch failed: ${res.statusText}`);

    const data = await res.json();
    
    // Decrypt incoming payload if present
    if (data.encryptedPayload) {
      const decryptedData = await decryptPayload(data.encryptedPayload, this.config.token);
      return JSON.parse(decryptedData);
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
    const url = this.config.sttUrl ? this.config.sttUrl : `${this.apiBaseUrl}/transcribe`
    const data = await this.fetchEncrypted(url, {
      method: 'POST',
      body: JSON.stringify({ audio: Array.from(pcmData) })
    })
    return data.text || ''
  }
}
