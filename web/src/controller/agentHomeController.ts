import type { AppInput, AppState, ScreenModel } from './model'
import { getScreenModel, calculateInitialScrollOffset } from './model'
import { getApi, getApiConfig, getAgentConfigs } from '../api'
import { logStateWork, logInputDispatch, nowMs } from '../testMode'

function wrapText(text: string, maxLen: number): string[] {
  const result: string[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.trim() === '') {
      result.push('');
      continue;
    }
    const words = line.split(' ');
    let currentLine = '';
    for (const word of words) {
      if (currentLine.length + word.length + 1 > maxLen && currentLine.length > 0) {
        result.push(currentLine);
        currentLine = word;
      } else {
        currentLine += (currentLine ? ' ' : '') + word;
      }
    }
    if (currentLine) result.push(currentLine);
  }
  return result;
}

function getScrollSpeedMs(speed: 'slow' | 'medium' | 'fast' | undefined): number {
  if (speed === 'slow') return 750
  if (speed === 'fast') return 200
  return 400
}

function getManualScrollStep(speed: 'slow' | 'medium' | 'fast' | undefined): number {
  if (speed === 'slow') return 1
  if (speed === 'fast') return 3
  return 2
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export interface GlassesBridge {
  render(model: ScreenModel): Promise<void>
  renderSidebarPanel?(model: Extract<ScreenModel, { kind: 'sidebar' }>): Promise<void>
  enqueueSidebarPanel?(model: Extract<ScreenModel, { kind: 'sidebar' }>): void
  setAudioEnabled(enabled: boolean): Promise<void>
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  showExitConfirmation?(): Promise<void>
  turnScreenOff?(): Promise<void>
  dispose?(): void
}

type StateListener = (state: AppState) => void

export class AgentHomeController {
  private state: AppState = { screen: 'loading', message: 'Starting...' }
  private listeners = new Set<StateListener>()
  private bridge?: GlassesBridge
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private pollInterval: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private animationInterval: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private autoScrollInterval: any = null
  private backgroundTasks: Set<string> = new Set()
  private turnTimeout: ReturnType<typeof setTimeout> | null = null
  // Wall-clock timestamp (ms) the current agent turn started — i.e. when
  // isThinking flipped to true. Cleared (null) when the turn ends. Drives the
  // "Agent is working | Ns" elapsed counter in the messages footer.
  private turnStartedAt: number | null = null
  private enabledAgents: string[] = []
  
  constructor(bridge?: GlassesBridge) {
    this.bridge = bridge
  }

  private startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval)
    if (this.animationInterval) clearInterval(this.animationInterval)

    this.animationInterval = setInterval(() => {
      // Re-render UI efficiently for spinning animation when there is a busy session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasBusySessions = this.backgroundTasks.size > 0 || (this.state as any).isThinking;
      const isViewingSessions = this.state.screen === 'sidebar.sessions' || this.state.screen === 'sidebar.messages';
      if (hasBusySessions && isViewingSessions) {
        this.setState(this.state, { renderBridge: true, skipListeners: true, partialRender: true });
      }
    }, 500)

    this.pollInterval = setInterval(async () => {
      const activeAgent = (this.state.screen === 'sidebar.messages' || this.state.screen === 'sidebarSending') ? this.state.agent : null;
      const activeSessionId = (this.state.screen === 'sidebar.messages' || this.state.screen === 'sidebarSending') ? this.state.sessionId : null;
      
      const api = getApi()
      
      // Global discovery for external busy sessions (e.g. from a CLI prompt)
      for (const agent of this.enabledAgents) {
         try {
           const sessions = await api.getSessions(agent);
           for (const s of sessions) {
             if (s.state === 'busy') {
               this.backgroundTasks.add(`${agent}::${s.id}`);
             }
           }
        } catch (e) { console.error('[poll:discovery]', agent, e) }
      }

      const tasksToPoll = Array.from(this.backgroundTasks).map(t => {
          const [agent, sessionId] = t.split('::');
          return { agent, sessionId };
      });
      
      if (activeAgent && activeSessionId && !this.backgroundTasks.has(`${activeAgent}::${activeSessionId}`)) {
        tasksToPoll.push({ agent: activeAgent, sessionId: activeSessionId });
      }

      for (const task of tasksToPoll) {
        try {
          const api = getApi()
          const pollResults = await Promise.all([
            api.getStatus(task.agent, task.sessionId),
            api.getHistory(task.agent, task.sessionId)
          ])
          const statusData = pollResults[0]
          const status = statusData.state || 'idle'
          const pollError = statusData.error
          let messages = pollResults[1]
          
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages = messages.filter((m: any) => {
              if (typeof m.text !== 'string') return false;
              const trimmed = m.text.trim();
              if (!trimmed) return false;
              if (/^\.+$/.test(trimmed)) return false;
              return true;
          });
          const isThinking = status === 'busy'
          if (!isThinking && this.turnTimeout) { clearTimeout(this.turnTimeout); this.turnTimeout = null }
          const taskKey = `${task.agent}::${task.sessionId}`;
          
          if (!isThinking && this.backgroundTasks.has(taskKey)) {
            // Task finished!
            this.backgroundTasks.delete(taskKey);
            // If the user's screen is asleep, trigger a notification. If they are awake and on a different screen, don't interrupt them.
            if (this.state.screen === 'asleep') {
               const prev = this.state.previous;
               const isAlreadyOpen = prev && prev.screen === 'sidebar.messages' && prev.agent === task.agent && prev.sessionId === task.sessionId;
               if (!isAlreadyOpen) {
                   const lastMsg = messages.length > 0 ? messages[messages.length - 1].text : 'New message';
                   this.setState({
                      screen: 'notification',
                      agent: task.agent,
                      sessionId: task.sessionId,
                      messageText: lastMsg,
                      previous: this.state
                   }, { renderBridge: true });
               }
            }
          }

          // Update UI if this is the active session
          if (activeAgent === task.agent && activeSessionId === task.sessionId) {
            if (this.state.screen === 'sidebarSending' && messages.length > 0) {
               this.setState({ screen: 'sidebar.messages', agent: activeAgent, sessionId: activeSessionId, messages, scrollOffset: 0, isThinking, agentError: pollError }, { renderBridge: true })
            } else if (this.state.screen === 'sidebar.messages') {
               // Never shrink messages — backend may not have written the latest yet
               if (messages.length < this.state.messages.length) {
                 // Keep local messages, only update thinking + error
                 const thinkingChanged = this.state.isThinking !== isThinking;
                 const errorChanged = this.state.agentError !== pollError;
                 if (thinkingChanged || errorChanged) {
                   this.setState({ ...this.state, isThinking, agentError: pollError }, { renderBridge: true, partialRender: true })
                 }
                 continue;
               }
               const lastOld = this.state.messages[this.state.messages.length - 1]
               const lastNew = messages[messages.length - 1]
               const textChanged = lastOld?.text !== lastNew?.text
               const lengthChanged = this.state.messages.length !== messages.length;
               
               if (lengthChanged || this.state.isThinking !== isThinking || textChanged) {
                   const newScrollOffset = (lengthChanged || textChanged) ? 0 : (this.state.scrollOffset || 0);
                   this.setState({ ...this.state, messages, isThinking, scrollOffset: newScrollOffset, agentError: pollError }, { renderBridge: true, partialRender: true })
               }
            }
          }
        } catch (e) { console.error('[poll:task]', task.agent, task.sessionId, e) }
      }
    }, 2000)
  }

  private stopPolling() {
    // We no longer stop polling so background tasks can complete.
  }

  public subscribe(listener: StateListener) {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private setState(newState: AppState, options: { renderBridge?: boolean; skipListeners?: boolean; partialRender?: boolean } = { renderBridge: true }) {
    // Track the working-turn timer. `isThinking` lives on several screen
    // types; read it generically. When it flips true, stamp the start time so
    // the footer can show an elapsed counter ("Agent is working | Ns"). When it
    // flips false (turn done / idle), clear it so the next turn restarts from 0.
    const wasThinking = !!(this.state as { isThinking?: boolean }).isThinking
    const nowThinking = !!(newState as { isThinking?: boolean }).isThinking
    if (!wasThinking && nowThinking) {
      this.turnStartedAt = Date.now()
    } else if (wasThinking && !nowThinking) {
      this.turnStartedAt = null
    }
    this.state = newState
    logStateWork(newState)
    if (!options.skipListeners) {
      for (const listener of this.listeners) listener(this.state)
    }
    if (this.bridge && options.renderBridge !== false) {
      const model = getScreenModel(this.state, this.turnStartedAt)
      if (options.partialRender && model.kind === 'sidebar' && this.bridge.enqueueSidebarPanel) {
        this.bridge.enqueueSidebarPanel(model)
      } else {
        this.bridge.render(model).catch(console.error)
      }
    }
  }

  public getState() { return this.state }

  public async boot() {
    this.stopPolling()
    this.setState({ screen: 'loading', message: 'Connecting to backend...' })
    try {
      const api = getApi()
      const allAgentsRaw = await api.getAgents()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allAgents = allAgentsRaw.map((a: any) => typeof a === 'string' ? { id: a, available: true } : a)
      const configs = await getAgentConfigs()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const enabledAgents = allAgents.filter((a: any) => a.available && (configs[a.id] ? configs[a.id].enabled : true)).map((a: any) => a.id)
      this.enabledAgents = enabledAgents;
      this.setState({ screen: 'sidebar.agents', agents: enabledAgents, selectedAgentIndex: 0 })
      this.startPolling(); // Ensure polling is running globally
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      const cfg = getApiConfig()
      const msg = err.message === 'Load failed' || !cfg.baseUrl || !cfg.token
        ? 'Use phone to configure AgentHome connection settings'
        : `Error: ${err.message}`
      this.setState({ screen: 'loading', message: msg })
    }
  }

  public async handleInput(input: AppInput) {
    const start = nowMs()
    try {
      await this.handleInputInternal(input)
    } finally {
      logInputDispatch({ type: input.type, listenerMs: nowMs() - start, ignored: false })
    }
  }

  private async handleInputInternal(input: AppInput) {
    console.log('[input]', input.type, this.state.screen)

    if (input.type !== 'audioChunk' && input.type !== 'foreground') {
      if (this.autoScrollInterval) {
        clearInterval(this.autoScrollInterval)
        this.autoScrollInterval = null
      }
    }

    if (input.type === 'doublePress') {
      if (this.state.screen === 'notification') {
        this.setState(this.state.previous || { screen: 'loading', message: 'Loading...' }, { renderBridge: true })
      } else if (this.state.screen === 'sidebar.messages' || this.state.screen === 'sidebarSending') {
        this.openSessionsList(this.state.agent)
      } else if (this.state.screen === 'sidebar.sessions') {
        this.boot() // Back to agents
      } else if (this.state.screen === 'sidebar.agents') {
        this.setState({ screen: 'asleep', previous: this.state })
        if (this.bridge?.turnScreenOff) this.bridge.turnScreenOff()
      } else if (this.state.screen === 'asleep') {
        this.setState(this.state.previous || { screen: 'loading', message: 'Waking...' })
      } else if (this.state.screen === 'sidebarRecording' || this.state.screen === 'sidebarTranscribing' || this.state.screen === 'sidebarConfirm') {
        this.setState({ ...this.state, screen: 'sidebar.messages', isThinking: false }, { renderBridge: true, partialRender: true }) // Cancel recording
      }
      return
    }

    if (this.state.screen === 'notification') {
      if (input.type === 'press') {
        this.openSession(this.state.agent, this.state.sessionId);
      }
      return;
    }

    if (this.state.screen === 'sidebar.agents') {
      if (input.type === 'swipeDown') {
        this.setState({ ...this.state, selectedAgentIndex: Math.min(this.state.agents.length - 1, this.state.selectedAgentIndex + 1) }, { partialRender: true })
      } else if (input.type === 'swipeUp') {
        this.setState({ ...this.state, selectedAgentIndex: Math.max(0, this.state.selectedAgentIndex - 1) }, { partialRender: true })
      } else if (input.type === 'selectIndex') {
        this.setState({ ...this.state, selectedAgentIndex: input.index ?? this.state.selectedAgentIndex })
      } else if (input.type === 'press') {
        const index = input.index ?? this.state.selectedAgentIndex
        const agent = this.state.agents[index]
        if (agent) this.openSessionsList(agent)
      }
    } 
    else if (this.state.screen === 'sidebar.sessions') {
      if (input.type === 'swipeDown') {
        this.setState({ ...this.state, selectedSessionIndex: Math.min(this.state.sessions.length - 1, this.state.selectedSessionIndex + 1) }, { partialRender: true })
      } else if (input.type === 'swipeUp') {
        this.setState({ ...this.state, selectedSessionIndex: Math.max(0, this.state.selectedSessionIndex - 1) }, { partialRender: true })
      } else if (input.type === 'selectIndex') {
        this.setState({ ...this.state, selectedSessionIndex: input.index ?? this.state.selectedSessionIndex })
      } else if (input.type === 'press') {
        const index = input.index ?? this.state.selectedSessionIndex
        const session = this.state.sessions[index]
        if (index === 0 || !session) {
          this.openSession(this.state.agent, '') // New session
        } else {
          this.openSession(this.state.agent, session.id)
        }
      }
    }
    else if (this.state.screen === 'sidebar.messages') {
      if (input.type === 'swipeDown') {
        const step = getManualScrollStep(getApiConfig().scrollSpeed)
        this.setState({ ...this.state, scrollOffset: Math.max(0, this.state.scrollOffset - step) }, { partialRender: true })
      } else if (input.type === 'swipeUp') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const state = this.state as any;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fullText = state.messages.map((m: any) => m.role === 'user' ? `You: ${m.text}` : `${state.agent}: ${m.text}`).join('\n\n')
        const lines = wrapText(fullText, 64)
        const maxOffset = Math.max(0, lines.length - 5)
        const step = getManualScrollStep(getApiConfig().scrollSpeed)
        this.setState({ ...state, scrollOffset: Math.min(maxOffset, state.scrollOffset + step) }, { partialRender: true })
      } else if (input.type === 'press') {
        this.startRecording()
      }
    }
    else if (this.state.screen === 'sidebarRecording') {
      if (input.type === 'audioChunk') {
        this.state.chunks.push(input.pcm)
      } else if (input.type === 'press') {
        this.stopRecordingAndTranscribe()
      }
    }
    else if (this.state.screen === 'sidebarTranscribing') {
      if (input.type === 'audioChunk') {
        this.state.chunks.push(input.pcm)
      }
    }
    else if (this.state.screen === 'sidebarConfirm') {
      if (input.type === 'swipeDown' || input.type === 'swipeUp') {
        this.setState({ ...this.state, selectedIndex: this.state.selectedIndex === 0 ? 1 : 0 })
      } else if (input.type === 'press') {
        if (this.state.transcriptError) {
          this.openSession(this.state.agent, this.state.sessionId)
          return
        }
        if (this.state.selectedIndex === 0) {
          this.sendMessage()
        } else {
          this.openSession(this.state.agent, this.state.sessionId)
        }
      }
    }
  }

  private async openSession(agent: string, sessionId: string) {
    this.setState({ screen: 'loading', message: 'Loading messages...' })
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let messages: any[] = []
      let status = 'idle'
      let agentError: string | undefined
      const api = getApi()
      if (sessionId) {
        const [statusResult, historyResult] = await Promise.all([
           api.getStatus(agent, sessionId).catch(() => ({ state: 'idle', error: undefined })),
           api.getHistory(agent, sessionId)
        ])
        status = statusResult.state
        agentError = statusResult.error
        messages = historyResult
        // Fallback: if status has no error but history suggests one (last message
        // is a user message with no assistant response), show a generic error.
        if (!agentError && status === 'idle' && messages.length > 0) {
            const last = messages[messages.length - 1];
            if (last?.role === 'user' && messages.filter(m => m.role === 'assistant').length === 0) {
                agentError = 'No response from agent';
            }
        }
      }
      
      const isThinking = status === 'busy'
      
      const config = getApiConfig()
      let initialScrollOffset = 0
      
      if (config.autoScrollLastExchange !== false && messages.length > 0) {
        initialScrollOffset = calculateInitialScrollOffset(messages, agent)
      }
      
      this.setState({ screen: 'sidebar.messages', agent, sessionId, messages, scrollOffset: initialScrollOffset, isThinking, agentError })
      
      if (this.autoScrollInterval) {
        clearInterval(this.autoScrollInterval)
        this.autoScrollInterval = null
      }
      
      if (initialScrollOffset > 0 && config.autoScrollLastExchange !== false) {
        const speedMs = getScrollSpeedMs(config.scrollSpeed)

        this.autoScrollInterval = setInterval(() => {
          if (this.state.screen !== 'sidebar.messages') {
            clearInterval(this.autoScrollInterval)
            this.autoScrollInterval = null
            return
          }
          
          if (this.state.scrollOffset > 0) {
            this.setState({ ...this.state, scrollOffset: this.state.scrollOffset - 1 }, { renderBridge: true, partialRender: true })
          } else {
            clearInterval(this.autoScrollInterval)
            this.autoScrollInterval = null
          }
        }, speedMs)
      }

      if (isThinking) {
         this.backgroundTasks.add(`${agent}::${sessionId}`)
      }
      this.startPolling()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      console.error("openSession error:", err.message, err.stack);
      this.openSessionsList(agent)
    }
  }

  private async openSessionsList(agent: string) {
    this.setState({ screen: 'loading', message: `Loading ${agent}...` })
    try {
      const api = getApi()
      const rawSessions = await api.getSessions(agent)
      // Sort most recent first, filter out completely empty ones (assuming empty if title is missing/default and ID is short)
      const sessions = rawSessions
        .filter(s => s.title && s.title !== 'Session' && s.title.trim() !== '')
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      this.setState({ screen: 'sidebar.sessions', agent, sessions: [{ id: '', title: '+ New Session', state: 'idle' }, ...sessions], selectedSessionIndex: 0 })
    } catch (e) {
      console.error('[openSessionsList]', agent, e)
      this.boot()
    }
  }

  private startRecording() {
    if (this.state.screen !== 'sidebar.messages') return
    if (this.bridge?.setAudioEnabled) this.bridge.setAudioEnabled(true)
    this.setState({ 
      screen: 'sidebarRecording', 
      agent: this.state.agent, 
      sessionId: this.state.sessionId, 
      messages: this.state.messages,
      chunks: [],
      startedAt: Date.now(),
      scrollOffset: this.state.scrollOffset
    })
  }

  private async stopRecordingAndTranscribe() {
    if (this.state.screen !== 'sidebarRecording') return
    const recordingState = this.state
    const chunks = recordingState.chunks
    this.setState({ 
      screen: 'sidebarTranscribing',
      agent: recordingState.agent,
      sessionId: recordingState.sessionId,
      messages: recordingState.messages,
      chunks,
      scrollOffset: recordingState.scrollOffset
    })
    
    // Transcribe
    try {
      try {
        if (this.bridge?.setAudioEnabled) await this.bridge.setAudioEnabled(false)
      } catch (err) {
        console.warn('[stopRecording] audio stop failed; trying transcription with buffered audio', err)
      }
      await sleep(75)
      const currentState = this.getState()
      const finalChunks: Uint8Array[] = currentState.screen === 'sidebarTranscribing'
        ? currentState.chunks
        : chunks
      let pcm: Uint8Array
      if (finalChunks.length === 0) {
        pcm = new Uint8Array(0)
      } else {
        const totalLen = finalChunks.reduce((sum, c) => sum + c.byteLength, 0)
        pcm = new Uint8Array(totalLen)
        let offset = 0
        for (const chunk of finalChunks) {
          pcm.set(chunk, offset)
          offset += chunk.byteLength
        }
      }
      const transcript = await getApi().transcribeAudio(pcm)
      const trimmedTranscript = transcript.trim()
      if (!trimmedTranscript || /^\.+$/.test(trimmedTranscript)) {
        throw new Error('No speech detected')
      }
      this.setState({
        screen: 'sidebarConfirm',
        agent: recordingState.agent,
        sessionId: recordingState.sessionId,
        messages: recordingState.messages,
        transcript: trimmedTranscript,
        selectedIndex: 0,
        scrollOffset: recordingState.scrollOffset
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Speech transcription failed'
      console.error('[stopRecording]', e)
      this.setState({
        screen: 'sidebarConfirm',
        agent: recordingState.agent,
        sessionId: recordingState.sessionId,
        messages: recordingState.messages,
        transcript: '',
        selectedIndex: 0,
        scrollOffset: recordingState.scrollOffset,
        transcriptError: message
      })
    }
  }

  private async sendMessage() {
    if (this.state.screen !== 'sidebarConfirm') return
    if (this.state.transcriptError) {
      this.openSession(this.state.agent, this.state.sessionId)
      return
    }
    const text = this.state.transcript || ''
    const trimmed = text.trim();
    if (!trimmed || /^\.+$/.test(trimmed)) {
      this.openSession(this.state.agent, this.state.sessionId)
      return
    }

    const agent = this.state.agent
    const sessionId = this.state.sessionId
    
    const updatedMessages = [...this.state.messages, { role: 'user', text }];
    this.setState({
      screen: 'sidebarSending',
      agent,
      sessionId,
      messages: updatedMessages,
      transcript: text,
      scrollOffset: 0
    })
    
    try {
      const apiConfig = getApiConfig()
      const configs = await getAgentConfigs()
      const config = configs[agent]

      const res = await getApi().prompt(agent, sessionId, text, config?.model, config?.thinking, apiConfig.yolo)
      // Stay on messages screen with local user message — polling will update with response
      if (this.turnTimeout) clearTimeout(this.turnTimeout)
      const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
      this.turnTimeout = setTimeout(() => {
        if (this.state.screen === 'sidebar.messages' && this.state.isThinking) {
          this.setState({ ...this.state, isThinking: false, agentError: 'Agent timed out' }, { renderBridge: true })
        }
      }, TIMEOUT_MS)
      this.setState({ screen: 'sidebar.messages', agent, sessionId: res.sessionId || sessionId, messages: updatedMessages, scrollOffset: 0, isThinking: true, agentError: undefined }, { renderBridge: true })
    } catch (e) {
      console.error('[sendMessage]', agent, e)
      this.openSession(agent, sessionId)
    }
  }

  public async sendTextMessage(text: string) {
    if (this.state.screen !== 'sidebar.messages') return
    const trimmed = text.trim();
    if (!trimmed || /^\.+$/.test(trimmed)) return;

    const agent = this.state.agent
    const sessionId = this.state.sessionId
    
    const updatedMessages = [...this.state.messages, { role: 'user', text }];
    this.setState({
      screen: 'sidebarSending',
      agent,
      sessionId,
      messages: updatedMessages,
      transcript: text,
      scrollOffset: 0
    })
    
    try {
      const apiConfig = getApiConfig()
      const configs = await getAgentConfigs()
      const config = configs[agent]

      const res = await getApi().prompt(agent, sessionId, text, config?.model, config?.thinking, apiConfig.yolo)
      // Stay on messages screen with local user message — polling will update with response
      if (this.turnTimeout) clearTimeout(this.turnTimeout)
      const TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
      this.turnTimeout = setTimeout(() => {
        if (this.state.screen === 'sidebar.messages' && this.state.isThinking) {
          this.setState({ ...this.state, isThinking: false, agentError: 'Agent timed out' }, { renderBridge: true })
        }
      }, TIMEOUT_MS)
      this.setState({ screen: 'sidebar.messages', agent, sessionId: res.sessionId || sessionId, messages: updatedMessages, scrollOffset: 0, isThinking: true, agentError: undefined }, { renderBridge: true })
    } catch (e) {
      console.error('[sendTextMessage]', agent, e)
      this.openSession(agent, sessionId)
    }
  }
}
