import { useCallback, useEffect, useState, useRef, type ClipboardEvent } from 'react'
import { getApiConfig, setApiConfig, getApi, getAgentConfigs, saveAgentConfigs } from './api'
import type { AgentProviderConfig, AuthConfig } from './api'
import { AgentHomeController } from './controller/agentHomeController'
import { APP_BUILD_VERSION, EvenHubGlassesBridge } from './bridge/evenBridge'
import type { AppState } from './controller/model'
import QRScanner from './QRScanner'
import './style.css'

function formatModelName(m: string): string {
  if (m === '') return 'Default'
  if (m === 'claude-3-5-sonnet-20241022') return 'Sonnet 3.5 (New)'
  if (m === 'claude-3-5-sonnet-20240620') return 'Sonnet 3.5'
  if (m === 'claude-3-opus-20240229') return 'Opus 3'
  if (m === 'claude-3-haiku-20240307') return 'Haiku 3'
  if (m === 'claude-3-5-haiku-20241022') return 'Haiku 3.5'
  
  if (m.startsWith('claude-')) {
    const match = m.match(/^claude-(\d+)(?:-(\d+))?-(opus|sonnet|haiku)(?:-.*)?$/i);
    if (match) {
      const major = match[1];
      const minor = match[2];
      const type = match[3].charAt(0).toUpperCase() + match[3].slice(1);
      return `${type} ${major}${minor ? `.${minor}` : ''}`;
    }
  }

  if (m.startsWith('gpt-4o')) return 'GPT-4o'
  if (m === 'gpt-4-turbo') return 'GPT-4 Turbo'
  if (m === 'gpt-3.5-turbo') return 'GPT-3.5 Turbo'
  if (m === 'gpt-4') return 'GPT-4'
  if (m === 'claudely-local') return 'Local'
  if (m === 'claudely-cloud') return 'Cloud'
  return m.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
}

/**
 * Parse a backend connection URL of the form
 *   http://<host>:<port>?token=<token>[&name=<name>]
 * (the form printed by the backend banner and embedded in the QR code) and
 * return the corresponding { baseUrl, token } pair, or null if the input is
 * not a recognizable connection URL.
 */
function parseConnectionUrl(input: string): { baseUrl: string; token: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const token = parsed.searchParams.get('token');
  if (!token) return null;
  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  return { baseUrl, token };
}

export default function App() {
  const [config, setConfig] = useState<AuthConfig>(getApiConfig())
  const [controller, setController] = useState<AgentHomeController | null>(null)
  const [screenState, setScreenState] = useState<AppState | null>(null)
  const [activeTab, setActiveTab] = useState<'main' | 'settings'>('main')
  const [showQRScanner, setShowQRScanner] = useState(false)

  useEffect(() => {
    let unmounted = false
    const ctrl = new AgentHomeController()
    
    EvenHubGlassesBridge.create((input) => ctrl.handleInput(input)).then(bridge => {
      if (unmounted) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(ctrl as any).bridge = bridge
      setController(ctrl)
      
      ctrl.subscribe(setScreenState)
      ctrl.boot()
    })
    
    return () => { unmounted = true }
  }, [])

  // Auto-persist the connection settings (URL + token + YOLO + debug) to
  // localStorage on every change so a restart or refresh does not require
  // re-entering the token. The Save button still exists for explicit
  // confirmation and to trigger controller.boot() with the new config.
  useEffect(() => {
    setApiConfig(config)
  }, [config])

  const handleSaveConfig = () => {
    setApiConfig(config)
    saveAgentConfigs(agentConfigs)
    setAgentRefreshNonce(value => value + 1)
    if (controller) controller.boot()
  }

  const handleScan = (url: string) => {
    const parsed = parseConnectionUrl(url);
    if (parsed) {
      setConfig(prev => ({ ...prev, baseUrl: parsed.baseUrl, token: parsed.token }));
    } else {
      alert('Invalid QR code: expected a connection URL like http://host:port?token=…');
    }
    setShowQRScanner(false);
  }

  // Pasting a full connection URL into the Backend URL field should auto-split
  // into baseUrl + token instead of forcing the user to retype both values.
  const handleBaseUrlPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text');
    const parsed = parseConnectionUrl(pasted);
    if (!parsed) return;
    e.preventDefault();
    setConfig(prev => ({ ...prev, baseUrl: parsed.baseUrl, token: parsed.token }));
  }

  interface AgentStatus {
    id: string;
    available: boolean;
  }

  const [agents, setAgents] = useState<AgentStatus[]>([])
  const [modelsByAgent, setModelsByAgent] = useState<Record<string, string[]>>({})
  const [agentConfigs, setAgentConfigs] = useState<Record<string, AgentProviderConfig>>(getAgentConfigs())
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null)
  const [agentRefreshNonce, setAgentRefreshNonce] = useState(0)

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
    const refreshModelLists = async (agentStatuses: AgentStatus[], attempt = 0) => {
      const modelsMap: Record<string, string[]> = {}
      const newConfigs = { ...getAgentConfigs() }
      const pending: string[] = []

      await Promise.all(agentStatuses.map(async (agent) => {
        if (!agent.available) return
        try {
          const result = await api.getModelsDetailed(agent.id)
          modelsMap[agent.id] = result.models
          if (!newConfigs[agent.id]) {
            newConfigs[agent.id] = { enabled: true, model: agent.id === 'claude' ? '' : (result.models[0] || 'default') }
          } else if (agent.id === 'claude' && result.source !== 'refreshed') {
            newConfigs[agent.id] = { ...newConfigs[agent.id], model: '' }
          } else if ((!newConfigs[agent.id].model || newConfigs[agent.id].model === 'default') && result.models[0]) {
            newConfigs[agent.id] = { ...newConfigs[agent.id], model: agent.id === 'claude' ? '' : result.models[0] }
          }
          if ((result.status === 'refreshing' || result.models.length === 0) && result.available !== false) {
            pending.push(agent.id)
          }
        } catch (e) {
          console.error(e)
        }
      }))

      if (isCancelled()) return
      setModelsByAgent(prev => ({ ...prev, ...modelsMap }))
      setAgentConfigs(newConfigs)
      saveAgentConfigs(newConfigs)

      if (pending.length > 0 && attempt < 5) {
        window.setTimeout(() => {
          if (!isCancelled()) refreshModelLists(agentStatuses.filter(agent => pending.includes(agent.id)), attempt + 1)
        }, 2000)
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    api.getAgents().then(async (data: any[]) => {
      if (isCancelled()) return
      const agentStatuses: AgentStatus[] = data.map(d => typeof d === 'string' ? { id: d, available: true } : d);
      const PREFERRED_ORDER = ['claude', 'codex', 'opencode', 'antigravity', 'oh-my-pi', 'pi', 'hermes', 'claudely'];
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
      const current = prev[agent] ?? { enabled: true, model: modelsByAgent[agent]?.[0] || 'default' }
      const next = { ...prev, [agent]: { ...current, enabled: !current.enabled } }
      saveAgentConfigs(next)
      return next
    })
  }

  const changeAgentModel = (agent: string, model: string) => {
    setAgentConfigs(prev => {
      const current = prev[agent] ?? { enabled: true, model }
      const next = { ...prev, [agent]: { ...current, model } }
      saveAgentConfigs(next)
      return next
    })
  }

  const changeAgentThinking = (agent: string, thinking: string) => {
    setAgentConfigs(prev => {
      const current = prev[agent] ?? { enabled: true, model: modelsByAgent[agent]?.[0] || 'default' }
      const next = { ...prev, [agent]: { ...current, thinking } }
      saveAgentConfigs(next)
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
      return (
        <div className="glasses-empty-state">
          <p>Please configure your settings to connect to the backend server for agent access.</p>
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
            {screenState.agents.length === 0 && <li className="glasses-item">No agents found</li>}
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
                <button className="send-btn" onClick={handleSendMessage} disabled={isThinking || screenState.screen === 'sidebarSending'}>Send</button>
              </div>
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
            {showQRScanner && (
              <QRScanner 
                onScan={handleScan} 
                onClose={() => setShowQRScanner(false)} 
              />
            )}
            <section className="card config-card" style={{ textAlign: 'center', padding: '2rem 1rem', marginBottom: '1rem' }}>
              <h2 style={{ marginBottom: '10px' }}>Quick Connect</h2>
              <p style={{ color: 'var(--text-muted)', marginBottom: '15px' }}>Scan QR code or enter details manually below</p>
              <button
                className="btn primary-btn"
                onClick={() => setShowQRScanner(true)}
                style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '1.1rem', padding: '10px 20px', margin: '0 auto' }}
              >
                📷 Scan QR Code
              </button>
            </section>

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
              <div className="input-group">
                <label>STT URL Override (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. http://localhost:8080/transcribe"
                  value={config.sttUrl || ''}
                  onChange={e => setConfig({...config, sttUrl: e.target.value})}
                />
              </div>
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
              <h2>Agent Configuration</h2>
              <div className="agent-list">
                {agents.map(agent => (
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
                    
                    {agent.id !== 'hermes' && (
                      <div style={{ display: 'flex', gap: '15px', marginTop: '15px', paddingTop: '15px', borderTop: '1px solid var(--border-light)', opacity: (!agent.available || !(agentConfigs[agent.id]?.enabled ?? true)) ? 0.5 : 1 }}>
                        <div style={{ flex: 1 }}>
                          <label style={{ display: 'block', fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '5px' }}>Model</label>
                          <select 
                            value={agentConfigs[agent.id]?.model ?? ''} 
                            onChange={e => changeAgentModel(agent.id, e.target.value)}
                            disabled={!agent.available || !(agentConfigs[agent.id]?.enabled ?? true)}
                            style={{ width: '100%', padding: '8px', borderRadius: '4px', border: '1px solid var(--border-light)', color: 'var(--text-main)', background: 'rgba(15, 23, 42, 0.8)' }}
                          >
                            {agent.id === 'claude' && <option value="">Default</option>}
                            {(modelsByAgent[agent.id] || []).map(m => <option key={m} value={m}>{formatModelName(m)}</option>)}
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
                ))}
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
              <button className="btn primary-btn" onClick={handleSaveConfig} style={{ width: '100%', fontSize: '1.1rem', padding: '12px' }}>Save Settings</button>
            </section>

            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.8rem', padding: '8px 0 2px' }}>
              Agent Home v{APP_BUILD_VERSION}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
