export type AppInput =
  | { type: 'press'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'doublePress'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'swipeUp'; eventSource?: number }
  | { type: 'swipeDown'; eventSource?: number }
  | { type: 'selectIndex'; index?: number; itemName?: string; eventSource?: number }
  | { type: 'audioChunk'; pcm: Uint8Array; injected?: boolean }
  | { type: 'foreground'; eventSource?: number }

export type BoxedText = {
  heading: string
  content: string
}

export type ScreenModel =
  | { kind: 'text'; title: string; body: string; footer?: string; box?: BoxedText }
  | { kind: 'list'; title: string; items: string[]; selectedIndex: number }
  | { kind: 'sidebar';
      title: string;
      sidebarTitle: string; sidebarItems: string[]; sidebarSelected: number;
      panelTitle: string; panelBody: string; panelFooter: string;
      panelBox?: BoxedText;
      fullWidth?: boolean;
      focus: 'sidebar' | 'panel'; }

// AgentHome custom types below
export type AppState =
  | { screen: 'loading'; message: string }
  | { screen: 'sidebar.agents'; agents: string[]; selectedAgentIndex: number }
/* eslint-disable @typescript-eslint/no-explicit-any */
  | { screen: 'sidebar.sessions'; agent: string; sessions: any[]; selectedSessionIndex: number }
  | { screen: 'sidebar.messages'; agent: string; sessionId: string; messages: any[]; scrollOffset: number; newerPages?: any[][]; isNewestPage?: boolean; isThinking?: boolean; agentError?: string }
  | { screen: 'sidebarRecording'; agent: string; sessionId: string; messages: any[]; chunks: Uint8Array[]; startedAt: number; scrollOffset: number; isThinking?: boolean }
  | { screen: 'sidebarTranscribing'; agent: string; sessionId: string; messages: any[]; scrollOffset: number; isThinking?: boolean }
  | { screen: 'sidebarConfirm'; agent: string; sessionId: string; messages: any[]; transcript: string; selectedIndex: number; scrollOffset: number; isThinking?: boolean }
  | { screen: 'sidebarSending'; agent: string; sessionId: string; messages: any[]; transcript: string; scrollOffset: number; isThinking?: boolean }
  | { screen: 'notification'; agent: string; sessionId: string; messageText: string; previous: AppState }
  | { screen: 'asleep'; previous: AppState }
/* eslint-enable @typescript-eslint/no-explicit-any */

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function calculateInitialScrollOffset(messages: any[], agent: string): number {
  if (!messages || messages.length === 0) return 0;
  
  let lastUserIdx = messages.length - 1;
  while (lastUserIdx >= 0 && messages[lastUserIdx].role !== 'user') lastUserIdx--;
  if (lastUserIdx < 0) return 0;
  
  const fullText = messages.map(m => m.role === 'user' ? `You: ${m.text}` : `${agent}: ${m.text}`).join('\n\n') || 'Start talking...';
  const totalLines = wrapText(fullText, 64).length;
  
  const priorMessagesText = messages.slice(0, lastUserIdx).map(m => m.role === 'user' ? `You: ${m.text}` : `${agent}: ${m.text}`).join('\n\n');
  const linesBeforeLastUser = priorMessagesText ? wrapText(priorMessagesText + '\n\n', 64).length : 0;
  
  let targetScrollOffset = Math.max(0, totalLines - (linesBeforeLastUser + 5));
  
  if (targetScrollOffset > 24) targetScrollOffset = 24;
  if (targetScrollOffset < 0) targetScrollOffset = 0;
  
  return targetScrollOffset;
}

const SPINNER_FRAMES = ['○', '◔', '◑', '◕', '●'];
export function getSpinnerFrame(): string {
  const idx = Math.floor(Date.now() / 150) % SPINNER_FRAMES.length;
  return SPINNER_FRAMES[idx];
}

export function getScreenModel(state: AppState): ScreenModel {
  switch (state.screen) {
    case 'loading':
      return { kind: 'text', title: 'AgentHome', body: state.message }
    case 'sidebar.agents': {
      const agentItems = state.agents.length ? state.agents : ['No agents found']
      const windowStart = Math.max(0, Math.min(state.selectedAgentIndex - 3, agentItems.length - 7))
      const visibleAgents = agentItems.slice(windowStart, windowStart + 7)
      const agentList = visibleAgents.map((ag, i) => (windowStart + i === state.selectedAgentIndex ? `> ${ag}` : `  ${ag}`)).join('\n')
      return {
        kind: 'sidebar',
        focus: 'panel',
        title: 'Agent Home',
        sidebarTitle: '',
        sidebarItems: [],
        sidebarSelected: 0,
        panelTitle: '',
        panelBody: agentList,
        panelFooter: 'Select Agent to start conversation',
        fullWidth: true
      }
    }
    case 'sidebar.sessions': {
      const sessionItems = state.sessions.map(s => {
        const prefix = s.state === 'busy' ? `${getSpinnerFrame()} ` : ''
        return prefix + (s.title || s.id || '+ New Session')
      })
      const windowStart = Math.max(0, Math.min(state.selectedSessionIndex - 3, sessionItems.length - 7))
      const visibleItems = sessionItems.slice(windowStart, windowStart + 7)
      const sessionList = visibleItems.map((s, i) => (windowStart + i === state.selectedSessionIndex ? `> ${s}` : `  ${s}`)).join('\n')
      return {
        kind: 'sidebar',
        focus: 'panel',
        title: `${state.agent}: Select Session`,
        sidebarTitle: '',
        sidebarItems: [],
        sidebarSelected: 0,
        panelTitle: '',
        panelBody: sessionList,
        panelFooter: 'Select existing session or Start new session',
        fullWidth: true
      }
    }
    case 'sidebar.messages': {
      const text = state.messages.map(m => m.role === 'user' ? `You: ${m.text}` : `${state.agent}: ${m.text}`).join('\n\n') || 'Tap to start recording or type from phone';
      const lines = wrapText(text, 64);
      const totalLines = lines.length;
      const maxLines = 5;
      const bottomIndex = Math.max(0, totalLines - state.scrollOffset);
      const topIndex = Math.max(0, bottomIndex - maxLines);
      const visibleLines = lines.slice(topIndex, bottomIndex);
      return {
        kind: 'sidebar',
        focus: 'panel',
        title: state.agent,
        sidebarTitle: 'Sessions',
        sidebarItems: [],
        sidebarSelected: 0,
        panelTitle: '',
        panelBody: visibleLines.join('\n'),
        panelFooter: state.agentError ? `Waiting for input | Agent Error` : (state.isThinking ? `Agent is working ${getSpinnerFrame()}` : 'Waiting for input'),
        fullWidth: true
      }
    }
    case 'sidebarRecording':
      return {
        kind: 'sidebar', focus: 'panel', title: state.agent, sidebarTitle: '', sidebarItems: [], sidebarSelected: 0,
        panelTitle: '', panelBody: 'Recording... speak now.\n\n(Previous msgs hidden for clarity)',
        panelFooter: 'Click stop | Double click cancel', fullWidth: true
      }
    case 'sidebarTranscribing':
      return {
        kind: 'sidebar', focus: 'panel', title: state.agent, sidebarTitle: '', sidebarItems: [], sidebarSelected: 0,
        panelTitle: '', panelBody: 'Converting voice...',
        panelFooter: 'Please wait', fullWidth: true
      }
    case 'sidebarConfirm':
      return {
        kind: 'sidebar', focus: 'panel', title: 'Confirm Send', sidebarTitle: '', sidebarItems: [], sidebarSelected: 0,
        panelTitle: '', panelBody: `You said:\n${state.transcript}\n\n${state.selectedIndex === 0 ? '> Send' : '  Send'}\n${state.selectedIndex === 1 ? '> Cancel' : '  Cancel'}`,
        panelFooter: 'Swipe select | Press confirm', fullWidth: true
      }
    case 'sidebarSending':
      return {
        kind: 'sidebar', focus: 'panel', title: 'Sending', sidebarTitle: '', sidebarItems: [], sidebarSelected: 0,
        panelTitle: '', panelBody: 'Sending message...',
        panelFooter: '', fullWidth: true
      }
    case 'notification': {
      const lines = wrapText(state.messageText, 64);
      const textToDisplay = lines.slice(-4).join('\n'); // Show last 4 lines roughly
      return {
        kind: 'text',
        title: 'New Message',
        body: `From: ${state.agent}\n\n${textToDisplay}`,
        footer: 'Press view | Double press ignore',
        box: {
          heading: 'New Message',
          content: `From: ${state.agent}\n${textToDisplay}`
        }
      }
      }
    case 'asleep':
      return { kind: 'text', title: '', body: '' }
    default:
      return { kind: 'text', title: 'Error', body: 'Unknown state' }
  }
}
