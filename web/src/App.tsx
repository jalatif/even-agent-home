import { useCallback, useEffect, useState, useRef, type ClipboardEvent } from 'react'
import {
  getApiConfig,
  setApiConfig,
  getApi,
  getAgentConfigs,
  saveAgentConfigs,
  hydrateApiConfig,
  hydrateAgentConfigs,
  refreshActiveConfigView,
  AgentHomeApi,
} from './api'
import type { AgentProviderConfig, AuthConfig } from './api'
import { AgentHomeController } from './controller/agentHomeController'
import { APP_BUILD_VERSION, EvenHubGlassesBridge } from './bridge/evenBridge'
import type { AppState } from './controller/model'
import { registerBridgeStorage } from './storage'
import { isBackendConfigured, formatModelName } from './configHelpers'
import { hydrateSimSettings, emitSettingsSnapshot, isSimSession } from './sim-settings'
import { hydrateSttServerUrl, setSttServerUrl } from './sttSettings'
import {
  getBackendsList,
  getActiveBackend,
  getActiveBackendId,
  getBackendsCount,
  setActiveBackend,
  clearActiveBackend,
  removeBackend,
  upsertBackend,
  saveBackend,
  normalizeConnectionInput,
  MAX_BACKENDS,
  type Backend,
} from './backends'
import './style.css'

/**
 * The model to pre-select for a freshly-configured agent (or when the saved
 * model is empty/'default'). Pinned per-agent because relying on list order
 * (`models[0]`) is fragile — the backend returns models in a fixed but
 * non-version-sorted order (e.g. claude starts with haiku, codex with
 * codex-mini-latest), so `models[0]` is rarely the flagship users want.
 *
 * The preferred model is only used if it actually appears in the available
 * model list, so an install that lacks it falls back gracefully.
 */
const PREFERRED_DEFAULT_MODEL: Record<string, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.5',
  antigravity: 'gemini-3.5-flash',
}

function defaultModelFor(agent: string, models: string[]): string {
  const preferred = PREFERRED_DEFAULT_MODEL[agent]
  if (preferred && models.length === 0) return preferred
  if (preferred && models.includes(preferred)) return preferred
  // Fallback heuristics when the exact preferred model isn't in the list, so we
  // still pick the flagship rather than blindly taking models[0] (which is
  // rarely what users want — lists are sorted alphabetically/by-id, not by
  // capability).
  if (agent === 'claude') {
    // Prefer the highest opus variant available (claude-opus-4-8, …-4-7, …),
    // then the highest sonnet. Avoids "Default" (empty) when the exact
    // preferred id is missing or the list hasn't refreshed yet.
    const opus = models
      .filter((m) => /^claude-opus-\d+(-\d+)?/i.test(m))
      .sort((a, b) => modelVersionDesc(a, b))
    if (opus.length) return opus[0]
    const sonnet = models
      .filter((m) => /^claude-sonnet-\d+(-\d+)?/i.test(m))
      .sort((a, b) => modelVersionDesc(a, b))
    if (sonnet.length) return sonnet[0]
  }
  if (agent === 'codex') {
    // Avoid -pro variants: with a ChatGPT account, Codex rejects models like
    // 'gpt-5.5-pro' ("not supported when using Codex with a ChatGPT account").
    // Prefer the matching non-pro base model (gpt-5.5) if present.
    const base = preferred && models.includes(preferred) ? preferred
      : models.find((m) => /^gpt-5\.\d+$/.test(m))
    if (base) return base
  }
  return models[0] || 'default'
}

function selectedModelFor(agent: string, savedModel: string | undefined, models: string[]): string {
  if (agent === 'claude' && savedModel && models.length > 0 && !models.includes(savedModel)) {
    return defaultModelFor(agent, models)
  }
  return savedModel || defaultModelFor(agent, models)
}

/** Compare two claude/gpt model ids by version, highest first. */
function modelVersionDesc(a: string, b: string): number {
  const va = (a.match(/\d+(?:-\d+)*/g) || []).join('.').split('-').map(Number)
  const vb = (b.match(/\d+(?:-\d+)*/g) || []).join('.').split('-').map(Number)
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (vb[i] || 0) - (va[i] || 0)
    if (d !== 0) return d
  }
  return 0
}

export default function App() {
  // Initial state is the in-memory cache. It is populated synchronously
  // from defaults; the bridge/localStorage hydration below patches in the
  // persisted values once available and triggers a re-render.
  const [config, setConfig] = useState<AuthConfig>(getApiConfig())
  const [controller, setController] = useState<AgentHomeController | null>(null)
  const [screenState, setScreenState] = useState<AppState | null>(null)
  const [activeTab, setActiveTab] = useState<'main' | 'settings'>('main')

  interface AgentStatus {
    id: string;
    available: boolean;
  }

  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, string[]>>({})
  // Default to `{}`; the mount effect below populates this with persisted
  // values once `hydrateAgentConfigs()` resolves from the persistent store.
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentProviderConfig>>({})
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [agentRefreshNonce, setAgentRefreshNonce] = useState(0)
  // Global STT Server URL override (not tied to a backend). Blank = use the
  // active backend's built-in STT; non-blank = send audio to a custom server.
  const [sttServerUrl, setSttServerUrlState] = useState('')

  // ---- Multi-backend UI state ----
  // backendsVersion is bumped whenever the registry changes so the list re-renders.
  const [backendsVersion, setBackendsVersion] = useState(0)
  const bumpBackends = () => setBackendsVersion((v) => v + 1)
  // Connect/Edit modal state. `editingBackendId` is null for "create new",
  // or an existing backend id for "edit".
  const [backendModalOpen, setBackendModalOpen] = useState(false)
  const [editingBackendId, setEditingBackendId] = useState<string | null>(null)
  const [modalName, setModalName] = useState('')
  const [modalConnection, setModalConnection] = useState('')
  const [modalToken, setModalToken] = useState('')
  const [modalTesting, setModalTesting] = useState(false)
  const [modalTestResult, setModalTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [modalError, setModalError] = useState<string | null>(null)
  // Backend pending in-app remove confirmation (null = no confirm dialog open).
  const [removingBackend, setRemovingBackend] = useState<Backend | null>(null)
  // Per-row ⋯ menu: the backend id whose menu is open (null = all closed).
  const [openMenuId, setOpenMenuId] = useState<string | null>(null)

  const activeBackend = getActiveBackend()
  const backendsList = getBackendsList()
  const backendsCount = getBackendsCount()
  // suppress unused-var lint for the bump trigger
  void backendsVersion

  // Close the per-row ⋯ menu when clicking outside it (or pressing Escape).
  useEffect(() => {
    if (!openMenuId) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null
      // Ignore clicks inside the menu itself or on a ⋯ toggle (those handle
      // their own open/close).
      if (target?.closest('[data-backend-menu]') || target?.closest('[data-backend-menu-toggle]')) return
      setOpenMenuId(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuId(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [openMenuId])

  // Simulator record/replay: restore recorded settings BEFORE the app boots,
  // then emit a settings snapshot so the skill can capture the current config.
  // The app also re-emits whenever config changes (the existing config-change
  // effect below calls emitSettingsSnapshot when isSimSession() is true).
  // No-op on real hardware / normal dev (gated by __sim_session in the URL).
  useEffect(() => {
    if (!isSimSession()) return
    void hydrateSimSettings().then(() => void emitSettingsSnapshot())
    const onHashChange = () => {
      if (window.location.hash === '#snapshot') {
        void emitSettingsSnapshot()
        window.location.hash = ''
      }
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    let unmounted = false
    // Hydrate from storage before the bridge is ready so the UI never shows
    // defaults on first paint when persisted values exist.
    void (async () => {
      const [hydratedConfig, hydratedAgentConfigs, hydratedSttUrl] = await Promise.all([
        hydrateApiConfig(),
        hydrateAgentConfigs(),
        hydrateSttServerUrl(),
      ])
      if (unmounted) return
      setConfig(hydratedConfig)
      setAgentConfigs(hydratedAgentConfigs)
      setSttServerUrlState(hydratedSttUrl)
      // Re-render so the Backends list reflects the now-hydrated registry.
      bumpBackends()
    })()

    const ctrl = new AgentHomeController()

    EvenHubGlassesBridge.create((input) => ctrl.handleInput(input)).then(bridge => {
      if (unmounted) return
      // Register the bridge-backed persistent store now that the SDK is
      // available. Subsequent reads and writes from `api.ts` go through
      // the bridge (survives WebView reload); `localStorage` is just a
      // fallback for browser dev.
      //
      // IMPORTANT: capture the `bridge` instance and call methods *on* it.
      // Grabbing the methods off the instance (`const sdkGet = bridge.getLocalStorage`)
      // detaches them from their receiver — when invoked later, `this` is
      // `undefined` and the call throws "Cannot read properties of undefined
      // (reading 'sdk')". The old code swallowed that error silently and
      // every read/write fell back to window.localStorage, which the phone
      // WebView clears on relaunch — so settings never persisted.
      registerBridgeStorage(() => {
        if (typeof bridge.getLocalStorage !== 'function' || typeof bridge.setLocalStorage !== 'function') return null
        return {
          async getItem(key) {
            try {
              const v = await bridge.getLocalStorage(key)
              return v || null
            } catch (e) {
              console.warn('[storage] bridge getLocalStorage failed', e)
              return null
            }
          },
          async setItem(key, value) {
            try {
              const ok = await bridge.setLocalStorage(key, value)
              if (!ok) console.warn('[storage] bridge setLocalStorage returned false', key)
            } catch (e) {
              console.warn('[storage] bridge setLocalStorage failed', e)
            }
          },
        }
      })
      // Re-hydrate once the bridge is available so the first paint does
      // not lock in a default before the SDK KV store is consulted. Pass
      // `force: true` because the pre-bridge hydration already set the
      // `configHydrated`/`agentConfigsHydrated` flags from the localStorage
      // fallback — without force, the second call would short-circuit and
      // never consult the bridge KV store, locking in stale defaults.
      //
      // CRITICAL ordering: the initial `ctrl.boot()` (which fetches the agent
      // list via `getApi()` → `currentConfig`) must run AFTER this re-hydration
      // completes, not concurrently. If boot() reads the config before the
      // bridge KV store is consulted, it sees the empty pre-bridge defaults
      // (no baseUrl/token), `getAgents()` fails, and the app shows "No agents
      // found / Configure backend" even though valid settings ARE persisted.
      // That was the "have to click Save to reload agents" bug.
      void (async () => {
        const [hydratedConfig, hydratedAgentConfigs, hydratedSttUrl] = await Promise.all([
          hydrateApiConfig(true),
          hydrateAgentConfigs(true),
          hydrateSttServerUrl(true),
        ])
        if (unmounted) return
        setConfig(hydratedConfig)
        setAgentConfigs(hydratedAgentConfigs)
        setSttServerUrlState(hydratedSttUrl)
        // Re-render so the Backends list reflects the bridge KV store (the
        // active backend / last-connected is now known).
        bumpBackends()

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(ctrl as any).bridge = bridge
        setController(ctrl)

        ctrl.subscribe(setScreenState)
        // Boot now reads the fully-hydrated config (baseUrl + token restored
        // from the bridge KV store), so agents load automatically on startup.
        ctrl.boot()

        // The settings UI's agents/models list is populated by the
        // refreshAgentsAndModels effect (dep: agentRefreshNonce). Its initial
        // mount run fired BEFORE the bridge KV store was consulted, so it
        // read the empty pre-hydration config and `getAgents()` failed
        // silently — leaving the settings agent list empty until the user
        // clicked Save (which bumped the nonce). Now that the config is
        // hydrated, bump the nonce to re-trigger that effect so the settings
        // list populates on startup without a manual Save. Only bump when the
        // config is usable, else the refresh would fail silently again.
        if (isBackendConfigured(hydratedConfig)) {
          setAgentRefreshNonce(n => n + 1)
        }
      })()
    })

    return () => { unmounted = true }
  }, [])

  // Auto-persist the connection settings (URL + token + YOLO + debug) to
  // the persistent store on every change so a restart or refresh does not
  // require re-entering the token. Fire-and-forget; the in-memory cache
  // is updated synchronously inside `setApiConfig` so subsequent reads
  // are consistent even if the bridge write is still in flight.
  useEffect(() => {
    void setApiConfig(config)
  }, [config])

  const handleSaveConfig = () => {
    void setApiConfig(config)
    void saveAgentConfigs(agentConfigs)
    void setSttServerUrl(sttServerUrl)
    setAgentRefreshNonce(value => value + 1)
    if (controller) controller.boot()
  }

  // ---- Multi-backend handlers ----

  // Open the modal to connect a NEW backend. Capped at MAX_BACKENDS: if the
  // user is already at the limit, warn and ask them to remove one rather than
  // silently refusing or opening the form.
  const openConnectModal = () => {
    if (getBackendsCount() >= MAX_BACKENDS) {
      window.alert(`You can connect at most ${MAX_BACKENDS} backends. Remove an existing backend to add a new one.`)
      return
    }
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
        setAgentConfigs(await getAgentConfigs())
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
    setAgentConfigs(await getAgentConfigs())
    setAgentRefreshNonce((n) => n + 1)
    if (controller) controller.boot()
    bumpBackends()
  }

  // Stop the active backend: keep it (and all others) saved, but clear the
  // active backend so the app shows the "select a backend" state until the
  // user picks one again. Distinct from remove (which deletes the entry).
  const handleStopBackend = async () => {
    const changed = await clearActiveBackend(() => refreshActiveConfigView())
    if (!changed) return
    refreshActiveConfigView()
    setConfig(getApiConfig())
    setAgentConfigs(await getAgentConfigs())
    // No backend is active after a stop: clear the agent/model lists so the
    // Agent Configuration section renders empty (rather than the previous
    // backend's stale agents with no backend name alongside).
    if (!getActiveBackend()) {
      setAgents([])
      setModelsByAgent({})
    }
    setAgentRefreshNonce((n) => (isBackendConfigured(getApiConfig()) ? n + 1 : n))
    if (controller) controller.boot()
    bumpBackends()
  }

  // Stage a backend for in-app remove confirmation. The confirm dialog is
  // rendered from `removingBackend`; window.confirm is unreliable in WebViews.
  const handleRemoveBackend = (backend: Backend) => {
    setRemovingBackend(backend)
  }

  // Actually remove the backend the user confirmed. If it was active, the
  // controller re-boots onto the fallback (or shows the empty/select state).
  const confirmRemoveBackend = async () => {
    const backend = removingBackend
    if (!backend) return
    setRemovingBackend(null)
    const res = await removeBackend(backend.id, () => refreshActiveConfigView())
    refreshActiveConfigView()
    setConfig(getApiConfig())
    setAgentConfigs(await getAgentConfigs())
    if (!getActiveBackend()) {
      // No backend active (last one removed, or the active one was removed
      // with no fallback): clear stale agents/models so Agent Configuration
      // is empty instead of showing the removed backend's agent list.
      setAgents([])
      setModelsByAgent({})
    }
    if (res.activeChanged) {
      setAgentRefreshNonce((n) => (isBackendConfigured(getApiConfig()) ? n + 1 : n))
      if (controller) controller.boot()
    }
    bumpBackends()
  }

  // Copy a command string to the clipboard and flash a "Copied!" indicator on
  // the source button for ~1.2s. Falls back to a hidden textarea + execCommand
  // for older WebViews (e.g. some Even Hub G2 builds) where navigator.clipboard
  // is not available.
  const copyToClipboard = async (text: string, label: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopiedCommand(label);
      window.setTimeout(() => {
        setCopiedCommand(prev => (prev === label ? null : prev));
      }, 1200);
    } catch (err) {
      console.error('Copy failed', err);
    }
  }

  const refreshAgentsAndModels = useCallback((isCancelled: () => boolean) => {
    const api = getApi()
    // Capture the backend this refresh is for. If the user switches backends
    // while the async model fetches are in flight (or a refresh retry fires
    // later), the result must NOT be written back — otherwise the new active
    // backend's saved agentConfigs get clobbered with the old backend's
    // freshly-defaulted configs (the "configs revert to defaults on switch"
    // bug). Both the external cancel flag and this id guard must hold.
    const refreshBackendId = getActiveBackendId()
    const sameBackend = () => !isCancelled() && getActiveBackendId() === refreshBackendId
    const refreshModelLists = async (agentStatuses: AgentStatus[], attempt = 0) => {
      const modelsMap: Record<string, string[]> = {}
      const newConfigs = { ...(await getAgentConfigs()) }
      const pending: string[] = []

      await Promise.all(agentStatuses.map(async (agent) => {
        if (!agent.available) return
        try {
          const result = await api.getModelsDetailed(agent.id)
          modelsMap[agent.id] = result.models
          if (!newConfigs[agent.id]) {
            // Fresh config: pre-select the preferred default for the agent
            // (e.g. claude-opus-4-8, gpt-5.5) when available, else models[0].
            newConfigs[agent.id] = { enabled: true, model: defaultModelFor(agent.id, result.models) }
          } else if (!newConfigs[agent.id].model || newConfigs[agent.id].model === 'default') {
            // No explicit user choice (empty or 'default') — pre-select the
            // preferred default. This covers the case where the model list
            // refreshes AFTER first paint and the saved selection was empty
            // (previously showed "Default" for claude). An explicitly saved
            // model is never overwritten.
            const picked = defaultModelFor(agent.id, result.models)
            if (picked !== 'default') {
              newConfigs[agent.id] = { ...newConfigs[agent.id], model: picked }
            }
          } else if (agent.id === 'claude' && result.models.length > 0 && !result.models.includes(newConfigs[agent.id].model)) {
            const picked = defaultModelFor(agent.id, result.models)
            if (picked !== 'default' && picked !== newConfigs[agent.id].model) {
              newConfigs[agent.id] = { ...newConfigs[agent.id], model: picked }
            }
          } else if (agent.id === 'codex' && /-pro$/.test(newConfigs[agent.id].model)) {
            // Codex -pro variants (gpt-5.5-pro, …) are rejected when using Codex
            // with a ChatGPT account (400 "not supported"). The default selection
            // MUST be the non-pro base model (gpt-5.5). Reset a saved -pro choice
            // to the base default so the first turn doesn't fail — a user who
            // genuinely wants -pro (API account) can re-select it from the list.
            const picked = defaultModelFor(agent.id, result.models)
            if (picked !== 'default' && picked !== newConfigs[agent.id].model) {
              newConfigs[agent.id] = { ...newConfigs[agent.id], model: picked }
            }
          }
          if ((result.status === 'refreshing' || result.models.length === 0) && result.available !== false) {
            pending.push(agent.id)
          }
        } catch (e) {
          console.error(e)
        }
      }))

      // If the active backend changed mid-fetch, drop the result entirely —
      // writing newConfigs (built from this backend's view) onto a different
      // active backend would clobber that backend's saved agentConfigs.
      if (!sameBackend()) return
      setModelsByAgent(prev => ({ ...prev, ...modelsMap }))
      setAgentConfigs(newConfigs)
      void saveAgentConfigs(newConfigs)

      if (pending.length > 0 && attempt < 5) {
        window.setTimeout(() => {
          if (sameBackend()) refreshModelLists(agentStatuses.filter(agent => pending.includes(agent.id)), attempt + 1)
        }, 2000)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.getAgents().then(async (data: any[]) => {
      if (!sameBackend()) return
      const agentStatuses: AgentStatus[] = data.map(d => typeof d === 'string' ? { id: d, available: true } : d);
      const PREFERRED_ORDER = ['claude', 'codex', 'opencode', 'antigravity', 'oh-my-pi', 'pi', 'hermes', 'openclaw'];
      agentStatuses.sort((a, b) => {
        const ia = PREFERRED_ORDER.indexOf(a.id);
        const ib = PREFERRED_ORDER.indexOf(b.id);
        if (ia === -1 && ib === -1) return a.id.localeCompare(b.id);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
      setAgents(agentStatuses)
      await refreshModelLists(agentStatuses)
    }).catch(console.error)
  }, [])

  useEffect(() => {
    let cancelled = false
    refreshAgentsAndModels(() => cancelled)
    return () => { cancelled = true }
  }, [agentRefreshNonce, refreshAgentsAndModels])

  const toggleAgent = (agent: string) => {
    setAgentConfigs(prev => {
      const current = prev[agent] ?? { enabled: true, model: defaultModelFor(agent, modelsByAgent[agent] || []) }
      const next = { ...prev, [agent]: { ...current, enabled: !current.enabled } }
      void saveAgentConfigs(next)
      return next
    })
  }

  const changeAgentModel = (agent: string, model: string) => {
    setAgentConfigs(prev => {
      const current = prev[agent] ?? { enabled: true, model }
      const next = { ...prev, [agent]: { ...current, model } }
      void saveAgentConfigs(next)
      return next
    })
  }

  const changeAgentThinking = (agent: string, thinking: string) => {
    setAgentConfigs(prev => {
      const current = prev[agent] ?? { enabled: true, model: defaultModelFor(agent, modelsByAgent[agent] || []) }
      const next = { ...prev, [agent]: { ...current, thinking } }
      void saveAgentConfigs(next)
      return next
    })
  }


  const isConfigured = config.baseUrl && config.token && agents.length > 0;

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Typed extractions of optional screenState fields so dep arrays and JSX
  // don't need `as any` casts. `screenState.messages`/`selectedAgentIndex`/
  // `selectedSessionIndex` are referenced by useEffect deps below; extracting
  // them here gives stable references for React's identity comparison.
  const messagesForScroll = screenState?.screen === 'sidebar.messages' ? screenState.messages : null
  const selectedAgentIndex = screenState?.screen === 'sidebar.agents' ? screenState.selectedAgentIndex : null
  const selectedSessionIndex = screenState?.screen === 'sidebar.sessions' ? screenState.selectedSessionIndex : null

  useEffect(() => {
    if (screenState?.screen === 'sidebar.messages' && messagesContainerRef.current) {
      const container = messagesContainerRef.current;
      // Only force scroll to bottom if the mouse hasn't manually scrolled up
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((container as any)._isUserAtBottom !== false) {
          requestAnimationFrame(() => {
            setTimeout(() => {
              container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            }, 10);
          });
      }
    }
  }, [messagesForScroll]); // eslint-disable-line react-hooks/exhaustive-deps -- screenState?.screen intentionally not in deps: effect re-runs only on message changes

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handleMessagesScroll = (e: any) => {
    const target = e.target;
    // Check if user is within 50px of bottom
    target._isUserAtBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 50;
  };


  useEffect(() => {
    if (!screenState) return;
    const selectedEl = document.querySelector('.glasses-item.selected');
    if (selectedEl) {
      selectedEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedAgentIndex, selectedSessionIndex]); // eslint-disable-line react-hooks/exhaustive-deps -- screenState intentionally not in deps: effect re-runs only on selection changes

  const [inputText, setInputText] = useState('')

  const handleSendMessage = () => {
    if (!inputText.trim() || !controller) return
    if (messagesContainerRef.current) {
       // eslint-disable-next-line @typescript-eslint/no-explicit-any
       (messagesContainerRef.current as any)._isUserAtBottom = true;
    }
    controller.sendTextMessage(inputText)
    setInputText('')
  }

  const renderGlassesView = () => {
    if (!screenState) return <div>Loading interface...</div>

    if (!isConfigured && screenState.screen === 'loading' && agents.length === 0) {
      const hasBackends = getBackendsCount() > 0
      return (
        <div className="glasses-empty-state">
          <p>
            {hasBackends
              ? 'Select a backend in Settings to view available agents.'
              : 'Please configure your settings to connect to the backend server for agent access.'}
          </p>
          <button className="btn primary-btn" onClick={() => setActiveTab('settings')}>Go to Settings</button>
        </div>
      )
    }

    if (screenState.screen === 'loading') {
      return <div className="glasses-centered">{screenState.message}</div>
    }

    if (screenState.screen === 'sidebar.agents') {
      return (
        <div className="glasses-screen">
          <div className="glasses-header">Select Agent</div>
          <ul className="glasses-list">
            {screenState.agents.length === 0 && (
              <>
                <li className="glasses-item">No agents found</li>
                <li
                  className="glasses-item"
                  style={{ opacity: 0.7, cursor: 'pointer' }}
                  onClick={() => setActiveTab('settings')}
                >
                  Configure backend in Settings →
                </li>
              </>
            )}
            {screenState.agents.map((ag, i) => (
              <li
                key={ag}
                className={`glasses-item ${screenState.selectedAgentIndex === i ? 'selected' : ''}`}
                onClick={() => controller?.handleInput({ type: 'press', index: i })}
              >
                {ag}
              </li>
            ))}
          </ul>
        </div>
      )
    }

    if (screenState.screen === 'sidebar.sessions') {
      return (
        <div className="glasses-screen">
          <div className="glasses-header">
            <button className="back-btn" onClick={() => controller?.handleInput({ type: 'doublePress' })}>◀</button>
            {screenState.agent} Sessions
          </div>
          <ul className="glasses-list">
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {screenState.sessions.map((ses: any, i: number) => (
              <li 
                key={i} 
                className={`glasses-item ${screenState.selectedSessionIndex === i ? 'selected' : ''}`}
                onClick={() => controller?.handleInput({ type: 'press', index: i })}
              >
                {ses.state === 'busy' && <span className="spinner" style={{ marginRight: '8px' }}>⚙️</span>} {ses.title || ses.id || '+ New Session'}
              </li>
            ))}
          </ul>
        </div>
      )
    }

    if (screenState.screen === 'notification') {
      return (
        <div className="glasses-screen">
          <div className="glasses-header">New Message</div>
          <div className="glasses-centered" style={{ textAlign: 'left', padding: '1rem', whiteSpace: 'pre-wrap' }}>
            <strong>From: {screenState.agent}</strong><br /><br />
            {screenState.messageText}
          </div>
          <div className="glasses-confirm-actions">
             <button onClick={() => controller?.handleInput({ type: 'press' })}>View (Press)</button>
             <button onClick={() => controller?.handleInput({ type: 'doublePress' })}>Ignore (Double Press)</button>
          </div>
        </div>
      )
    }

    if (screenState.screen === 'sidebar.messages' || screenState.screen === 'sidebarSending' || screenState.screen === 'sidebarRecording' || screenState.screen === 'sidebarTranscribing' || screenState.screen === 'sidebarConfirm') {
      // `isThinking` exists on both `sidebar.messages` and `sidebarSending`;
      // `agentError` only on `sidebar.messages`. Extracting once avoids
      // repeated narrowing in the JSX and removes the need for `as any`.
      const isThinking = screenState.screen === 'sidebar.messages' || screenState.screen === 'sidebarSending' ? !!screenState.isThinking : false;
      const agentError = screenState.screen === 'sidebar.messages' ? screenState.agentError : undefined;
      const onMessagesOrSending = screenState.screen === 'sidebar.messages' || screenState.screen === 'sidebarSending';
       return (
         <div className="glasses-screen glasses-messages-screen">
          <div className="glasses-header">
            <button className="back-btn" onClick={() => controller?.handleInput({ type: 'doublePress' })}>◀</button>
            {screenState.agent}
          </div>
          
          <div className="glasses-messages" id="glasses-messages-container" ref={messagesContainerRef} onScroll={handleMessagesScroll}>
            <div style={{ marginTop: 'auto' }}></div>
            {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
            {screenState.messages && screenState.messages.map((m: any, i: number) => (
              <div key={i} className={`message-bubble ${m.role === 'user' ? 'message-user' : 'message-agent'}`}>
                {m.text}
              </div>
            ))}
            {screenState.screen === 'sidebarRecording' && <div className="glasses-status">Recording... 🎤</div>}
            {screenState.screen === 'sidebarTranscribing' && <div className="glasses-status">Transcribing... ⏳</div>}
            {screenState.screen === 'sidebarSending' && <div className="glasses-status">Sending... 🚀</div>}
            {screenState.screen === 'sidebarConfirm' && (
              <div className="glasses-confirm">
                <p>Transcript: {screenState.transcript}</p>
                <div className="glasses-confirm-actions">
                  <button onClick={() => controller?.handleInput({ type: 'press' })}>Send</button>
                  <button onClick={() => controller?.handleInput({ type: 'doublePress' })}>Cancel</button>
                </div>
              </div>
            )}
            <div id="messages-end-anchor" ref={messagesEndRef}></div>
          </div>
          
          {onMessagesOrSending && (
            <div className="glasses-input-container">
              <div className="glasses-text-input">
                <input
                  type="text"
                  placeholder={isThinking || screenState.screen === 'sidebarSending' ? "Agent is working..." : "Type a message..."}
                  value={inputText}
                  onChange={e => setInputText(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleSendMessage()}
                  disabled={isThinking || screenState.screen === 'sidebarSending'}
                />
              </div>
              {!isThinking && (
                <button className="send-btn actions" onClick={handleSendMessage} disabled={screenState.screen === 'sidebarSending'}>Send</button>
              )}
              {isThinking && (
                <div className="glasses-actions">
                  <button className="stop-btn" onClick={() => controller?.stopAgent()} title="Stop agent">⏹</button>
                </div>
              )}
            </div>
          )}
          {onMessagesOrSending && (
             <div className="glasses-status" style={{ marginTop: '0.5rem', marginBottom: '0.5rem' }}>
                {agentError
                  ? `✗ Agent Error: ${agentError}`
                  : (isThinking || screenState.screen === 'sidebarSending' ? '✓ Agent connected' : 'Waiting for input')
                }
             </div>
          )}
        </div>
      )
    }

    return <div className="glasses-centered">Asleep</div>
  }

  return (
    <div className="app-shell">
      <header className="app-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', background: 'rgba(15, 23, 42, 0.8)', borderBottom: '1px solid var(--border-light)' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: '22px', fontWeight: 600, letterSpacing: '-0.5px' }}>
            {activeTab === 'settings' ? 'Settings' : 'Agent Home'}
          </h1>
          <p className="eyebrow" style={{ color: 'var(--text-muted)', fontSize: '13px', margin: '2px 0 0 0' }}>
            {activeTab === 'settings' ? 'Configure backend connection' : 'Unified AI Assistant'}
          </p>
        </div>
        <button 
          className="icon-button" 
          onClick={() => setActiveTab(activeTab === 'settings' ? 'main' : 'settings')}
          style={{ background: 'transparent', border: '1px solid var(--border-light)', color: 'var(--text-main)', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer' }}
        >
          {activeTab === 'settings' ? 'Back' : '⚙️ Settings'}
        </button>
      </header>
      
      <main className="main-content" style={{ flex: 1, padding: '1rem', overflowY: 'auto' }}>
        {activeTab === 'main' ? (
          <section className="card">
            <div className="glasses-container">
              {renderGlassesView()}
            </div>
            
            {config.debugView && (
              <div className="debug-view" style={{ marginTop: '1rem' }}>
                <h3>Debug State</h3>
                <pre className="state-pre">{JSON.stringify(screenState, null, 2)}</pre>
              </div>
            )}
          </section>
        ) : (
          <div className="settings-view">
            <section className="card config-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ margin: 0 }}>Backends</h2>
                <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>
                  {backendsCount}/{MAX_BACKENDS}
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
                      style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', padding: '12px', marginBottom: '8px', borderRadius: '8px', border: `1px solid ${isActive ? 'rgba(34, 197, 94, 0.55)' : 'var(--border-light)'}`, background: isActive ? 'rgba(34, 197, 94, 0.14)' : 'rgba(30, 41, 59, 0.5)', cursor: isActive ? 'default' : 'pointer' }}
                      onClick={() => !isActive && handleSwitchBackend(b.id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                        <span style={{ fontSize: '1.1rem', color: isActive ? '#22c55e' : 'var(--text-muted)', lineHeight: 1 }}>{isActive ? '●' : '○'}</span>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, color: 'var(--text-main)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.name}</div>
                          <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{b.baseUrl.replace(/^https?:\/\//, '')}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, position: 'relative' }}>
                        {isActive && <span className="backend-active-chip" style={{ fontSize: '0.7rem', padding: '3px 8px', borderRadius: '999px', background: 'rgba(34, 197, 94, 0.25)', color: '#22c55e' }}>active</span>}
                        <button
                          type="button"
                          className="btn backend-menu-toggle"
                          data-backend-menu-toggle
                          onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === b.id ? null : b.id) }}
                          style={{ padding: '5px 12px', fontSize: '1.1rem', lineHeight: 1 }}
                          aria-label={`Actions for ${b.name}`}
                          aria-haspopup="menu"
                          aria-expanded={openMenuId === b.id}
                          title="Backend actions"
                        >⋯</button>
                        {openMenuId === b.id && (
                          <div
                            data-backend-menu
                            className="backend-menu"
                            style={{ position: 'absolute', top: '100%', right: 0, marginTop: '4px', minWidth: '150px', background: 'rgba(15, 23, 42, 0.98)', border: '1px solid var(--border-light)', borderRadius: '8px', boxShadow: '0 12px 30px rgba(0,0,0,0.45)', zIndex: 40, overflow: 'hidden' }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              className="backend-menu-item"
                              disabled={!isActive}
                              onClick={() => { setOpenMenuId(null); if (isActive) void handleStopBackend() }}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'transparent', border: 'none', color: isActive ? 'var(--text-main)' : 'var(--text-muted)', cursor: isActive ? 'pointer' : 'not-allowed', opacity: isActive ? 1 : 0.45, fontSize: '0.92rem' }}
                              title={isActive ? 'Stop (disconnect) this backend without removing it' : 'Only the active backend can be stopped'}
                            >Stop</button>
                            <button
                              type="button"
                              className="backend-menu-item"
                              onClick={() => { setOpenMenuId(null); openEditModal(b) }}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'transparent', border: 'none', borderTop: '1px solid var(--border-light)', color: 'var(--text-main)', cursor: 'pointer', fontSize: '0.92rem' }}
                            >Edit</button>
                            <button
                              type="button"
                              className="backend-menu-item"
                              onClick={() => { setOpenMenuId(null); handleRemoveBackend(b) }}
                              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 12px', background: 'transparent', border: 'none', borderTop: '1px solid var(--border-light)', color: '#ef4444', cursor: 'pointer', fontSize: '0.92rem' }}
                            >Remove</button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              <button type="button" className="btn primary-btn" onClick={openConnectModal} style={{ width: '100%', marginTop: '0.5rem' }}>+ Connect New Backend</button>
            </section>

            <details className="card config-card">
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '1.1rem', listStyle: 'revert' }}>
                Backend Setup Instructions
              </summary>
              <div style={{ marginTop: '12px', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                <p style={{ margin: '0 0 12px 0' }}>
                  Run these commands on the machine that will host the Agent Home
                  bridge (your laptop, a server, etc.). Pick a port for the
                  bridge and make sure the <strong>Backend URL</strong> above
                  uses the same port.
                </p>

                <div style={{ marginBottom: '12px' }}>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    1. Install the package
                  </div>
                  <div style={{ display: 'flex', alignItems: 'stretch', gap: '8px' }}>
                    <code style={{
                      display: 'block',
                      flex: 1,
                      minWidth: 0,
                      background: 'rgba(15, 23, 42, 0.6)',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.9rem',
                      overflowX: 'auto',
                      whiteSpace: 'nowrap',
                    }}>
                      npm install -g even-agent-home
                    </code>
                    <button
                      type="button"
                      className="btn"
                      aria-label="Copy install command"
                      title="Copy install command"
                      onClick={() => copyToClipboard('npm install -g even-agent-home', 'install')}
                      style={{ flexShrink: 0, width: '38px', minWidth: '38px', padding: 0, fontSize: '16px' }}
                    >
                      {copiedCommand === 'install' ? '✓' : '📋'}
                    </button>
                  </div>
                </div>

                <div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '4px' }}>
                    2. Start the bridge (replace <code>my-secret</code> with your own token)
                  </div>
                  <div style={{ display: 'flex', alignItems: 'stretch', gap: '8px' }}>
                    <code style={{
                      display: 'block',
                      flex: 1,
                      minWidth: 0,
                      background: 'rgba(15, 23, 42, 0.6)',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.9rem',
                      overflowX: 'auto',
                      whiteSpace: 'nowrap',
                    }}>
                      even-agent-home --token my-secret --port 8765
                    </code>
                    <button
                      type="button"
                      className="btn"
                      aria-label="Copy start command"
                      title="Copy start command"
                      onClick={() => copyToClipboard('even-agent-home --token my-secret --port 8765', 'start')}
                      style={{ flexShrink: 0, width: '38px', minWidth: '38px', padding: 0, fontSize: '16px' }}
                    >
                      {copiedCommand === 'start' ? '✓' : '📋'}
                    </button>
                  </div>
                </div>
              </div>
            </details>

            <section className="card config-card">
              <h2>Agent Configuration{activeBackend ? ` — ${activeBackend.name}` : ''}</h2>
              <div className="agent-list">
                {agents.map(agent => {
                  const modelOptions = modelsByAgent[agent.id] || []
                  const selectedModel = selectedModelFor(agent.id, agentConfigs[agent.id]?.model, modelOptions)
                  const renderedModelOptions = selectedModel && selectedModel !== 'default' && !modelOptions.includes(selectedModel)
                    ? [selectedModel, ...modelOptions]
                    : modelOptions
                  return (
                  <div key={agent.id} className="agent-row" style={{ display: 'flex', flexDirection: 'column', padding: '15px', background: 'rgba(30, 41, 59, 0.5)', borderRadius: '8px', marginBottom: '10px', border: '1px solid var(--border-light)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontWeight: '600', fontSize: '1.1rem', textTransform: 'capitalize', color: 'var(--text-main)' }}>{agent.id}</span>
                      
                      {!agent.available ? (
                        <span style={{ padding: '6px 10px', fontSize: '0.9rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>Unavailable</span>
                      ) : (
                        <select 
                          value={(agentConfigs[agent.id]?.enabled ?? true) ? 'enabled' : 'disabled'}
                          onChange={(e) => {
                            const enabled = agentConfigs[agent.id]?.enabled ?? true
                            if (e.target.value === 'enabled' && !enabled) toggleAgent(agent.id)
                            else if (e.target.value === 'disabled' && enabled) toggleAgent(agent.id)
                          }}
                          style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-light)', fontWeight: '500', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                        >
                          <option value="enabled">Enabled</option>
                          <option value="disabled">Disabled</option>
                        </select>
                      )}
                    </div>
                    
                    {agent.id !== 'hermes' && agent.id !== 'openclaw' && (
                      <div style={{ display: 'flex', gap: '15px', marginTop: '15px', paddingTop: '15px', borderTop: '1px solid var(--border-light)', opacity: (!agent.available || !(agentConfigs[agent.id]?.enabled ?? true)) ? 0.5 : 1 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '5px' }}>Model</label>
                          <select 
                            value={selectedModel} 
                            onChange={e => changeAgentModel(agent.id, e.target.value)}
                            disabled={!agent.available || !(agentConfigs[agent.id]?.enabled ?? true)}
                            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                          >
                            {agent.id === 'claude' && <option value="">Default</option>}
                            {renderedModelOptions.map(m => <option key={m} value={m}>{formatModelName(m)}</option>)}
                          </select>
                        </div>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '5px' }}>Thinking Level</label>
                          <select
                            value={agentConfigs[agent.id]?.thinking ?? 'off'}
                            onChange={e => changeAgentThinking(agent.id, e.target.value)}
                            disabled={!agent.available || !(agentConfigs[agent.id]?.enabled ?? true)}
                            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                          >
                            <option value="off">Off</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="xhigh">Extra High</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                )})}
              </div>
            </section>

            <section className="card config-card" style={{ marginTop: '1rem' }}>
              <div className="input-group checkbox-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                <input
                  type="checkbox"
                  id="autoScrollLastExchange"
                  checked={config.autoScrollLastExchange !== false}
                  onChange={e => setConfig({...config, autoScrollLastExchange: e.target.checked})}
                  style={{ width: 'auto' }}
                />
                <label htmlFor="autoScrollLastExchange" style={{ margin: 0 }}>Auto Scroll Last Exchange</label>
              </div>
              <div className="input-group" style={{ marginBottom: '15px' }}>
                <label>Scroll Speed</label>
                <select 
                  value={config.scrollSpeed || 'medium'}
                  onChange={e => setConfig({...config, scrollSpeed: e.target.value as AuthConfig['scrollSpeed']})}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                >
                  <option value="slow">Slow</option>
                  <option value="medium">Medium</option>
                  <option value="fast">Fast</option>
                </select>
              </div>
              <div className="input-group checkbox-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                <input 
                  type="checkbox" 
                  id="yoloToggle"
                  checked={config.yolo ?? false} 
                  onChange={e => setConfig({...config, yolo: e.target.checked})} 
                  style={{ width: 'auto' }}
                />
                <label htmlFor="yoloToggle" style={{ margin: 0 }}>Yolo Permission Mode</label>
              </div>
              <div className="input-group checkbox-group" style={{ flexDirection: 'row', alignItems: 'center', gap: '10px', marginBottom: '15px' }}>
                <input
                  type="checkbox"
                  id="debugToggle"
                  checked={config.debugView || false}
                  onChange={e => setConfig({...config, debugView: e.target.checked})}
                  style={{ width: 'auto' }}
                />
                <label htmlFor="debugToggle" style={{ margin: 0 }}>Enable Glasses Debug View</label>
              </div>
              <div className="input-group" style={{ marginBottom: '15px' }}>
                <label>STT Server URL (Optional)</label>
                <input
                  type="text"
                  value={sttServerUrl}
                  onChange={e => setSttServerUrlState(e.target.value)}
                  placeholder="Use backend default"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                />
                <p style={{ margin: '6px 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                  Leave blank to use the backend's built-in STT. A custom STT server must expose POST /api/transcribe accepting a WAV audio file and returning {`{"text": "..."}`}.
                </p>
              </div>
              <button className="btn primary-btn" onClick={handleSaveConfig} style={{ width: '100%', fontSize: '1.1rem', padding: '12px' }}>Save Settings</button>
            </section>

            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '8px 0 2px' }}>
              Agent Home v{APP_BUILD_VERSION}
            </div>
          </div>
        )}

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

        {removingBackend && (
          <div className="backend-modal-backdrop" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
            <div className="backend-modal card" style={{ width: 'min(92vw, 420px)', padding: '1.25rem', background: 'rgba(15, 23, 42, 0.98)' }}>
              <h2 style={{ margin: '0 0 0.5rem 0' }}>Remove backend?</h2>
              <p style={{ margin: '0 0 1rem 0', color: 'var(--text-muted)', fontSize: '0.9rem' }}>
                Remove “{removingBackend.name}”? Sessions live on the server and are not deleted.
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button type="button" className="btn" onClick={() => setRemovingBackend(null)}>Cancel</button>
                <button type="button" className="btn" style={{ background: '#ef4444', color: '#fff', border: 'none' }} onClick={() => void confirmRemoveBackend()}>Remove</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
