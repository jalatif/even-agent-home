import { test } from 'node:test'
import assert from 'node:assert/strict'

const { AgentHomeController } = await import('../src/controller/agentHomeController.ts')
const { __resetApiStateForTests, setApiConfig } = await import('../src/api.ts')

test('boot does not fetch /api/agents before backend config exists', async () => {
  __resetApiStateForTests()

  const originalFetch = globalThis.fetch
  const fetchCalls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input))
    throw new Error('unexpected fetch')
  }) as typeof fetch

  try {
    const controller = new AgentHomeController()
    await controller.boot()

    assert.deepEqual(fetchCalls, [])
    assert.equal(controller.getState().screen, 'loading')
    assert.match(controller.getState().message ?? '', /configure AgentHome connection settings/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('root double press uses shutdown bridge instead of screen-off fallback', async () => {
  __resetApiStateForTests()

  const calls: string[] = []
  const controller = new AgentHomeController({
    async render() {},
    async setAudioEnabled() {},
    async showExitConfirmation() {
      calls.push('showExitConfirmation')
    },
    async turnScreenOff() {
      calls.push('turnScreenOff')
    },
  })

  await controller.boot()
  ;(controller as unknown as { state: unknown }).state = {
    screen: 'sidebar.agents',
    agents: ['codex'],
    selectedAgentIndex: 0,
  }

  await controller.handleInput({ type: 'doublePress' })

  assert.deepEqual(calls, ['showExitConfirmation'])
  assert.equal(controller.getState().screen, 'sidebar.agents')
})

test('double press on the boot (loading) root page fires showExitConfirmation', async () => {
  __resetApiStateForTests()

  const calls: string[] = []
  const controller = new AgentHomeController({
    async render() {},
    async setAudioEnabled() {},
    async showExitConfirmation() {
      calls.push('showExitConfirmation')
    },
    async turnScreenOff() {
      calls.push('turnScreenOff')
    },
  })

  // `boot()` with no backend config leaves the controller on the `loading`
  // screen — that is the actual root page a user sees at startup before the
  // agent list resolves. A double-tap there must reach the exit path.
  await controller.boot()
  assert.equal(controller.getState().screen, 'loading')

  await controller.handleInput({ type: 'doublePress' })

  assert.deepEqual(calls, ['showExitConfirmation'])
})

test('preserved boot refresh does not blank an active glasses screen', async () => {
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  let releaseAgents!: () => void
  const agentsGate = new Promise<void>(resolve => {
    releaseAgents = resolve
  })
  globalThis.fetch = (async () => ({
    ok: true,
    async json() {
      await agentsGate
      return { agents: ['codex'] }
    },
  })) as typeof fetch

  const controller = new AgentHomeController()
  try {
    ;(controller as unknown as { state: unknown }).state = {
      screen: 'sidebar.messages',
      agent: 'codex',
      sessionId: 'session-1',
      messages: [{ role: 'assistant', text: 'Ready' }],
      scrollOffset: 0,
      isThinking: false,
    }

    const bootPromise = controller.boot({ preserveCurrentScreen: true })
    await Promise.resolve()

    assert.equal(controller.getState().screen, 'sidebar.messages')
    releaseAgents()
    await bootPromise

    assert.equal(controller.getState().screen, 'sidebar.agents')
  } finally {
    const timers = controller as unknown as {
      pollInterval: ReturnType<typeof setInterval> | null
      animationInterval: ReturnType<typeof setInterval> | null
    }
    if (timers.pollInterval) clearInterval(timers.pollInterval)
    if (timers.animationInterval) clearInterval(timers.animationInterval)
    globalThis.fetch = originalFetch
  }
})

test('failed session-list reload from an open session keeps the current session visible', async () => {
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: false,
    status: 502,
    statusText: 'Bad Gateway',
    async json() {
      return { error: 'OpenClaw session list failed' }
    },
  })) as typeof fetch

  const controller = new AgentHomeController()
  try {
    ;(controller as unknown as { state: unknown }).state = {
      screen: 'sidebar.messages',
      agent: 'openclaw',
      sessionId: 'openclaw-session-1',
      messages: [{ role: 'assistant', text: 'Ready' }],
      scrollOffset: 0,
      isThinking: false,
    }

    await controller.handleInput({ type: 'doublePress' })

    assert.equal(controller.getState().screen, 'sidebar.messages')
    assert.equal(controller.getState().agent, 'openclaw')
    assert.equal(controller.getState().sessionId, 'openclaw-session-1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stale open-session result cannot overwrite a newer sessions screen', async () => {
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  let releaseHistory!: () => void
  const historyGate = new Promise<void>(resolve => {
    releaseHistory = resolve
  })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/history')) {
      await historyGate
      return {
        ok: true,
        async json() {
          return { history: [{ role: 'assistant', text: 'stale message' }] }
        },
      }
    }
    if (url.includes('/status')) {
      return {
        ok: true,
        async json() {
          return { state: 'idle' }
        },
      }
    }
    if (url.includes('/sessions')) {
      return {
        ok: true,
        async json() {
          return { sessions: [{ id: 'session-1', title: 'Session 1', timestamp: '2026-06-25T00:00:00.000Z' }] }
        },
      }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const controller = new AgentHomeController()
  try {
    const privateController = controller as unknown as {
      openSession(agent: string, sessionId: string): Promise<void>
      openSessionsList(agent: string): Promise<void>
    }

    const staleOpen = privateController.openSession('openclaw', 'session-1')
    await Promise.resolve()
    await privateController.openSessionsList('openclaw')
    releaseHistory()
    await staleOpen

    assert.equal(controller.getState().screen, 'sidebar.sessions')
    assert.equal(controller.getState().agent, 'openclaw')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stale openSession of a busy session still registers it for background polling', async () => {
  // Regression: the stale guard in openSession used to return before
  // backgroundTasks.add(), so a busy session opened then navigated away from
  // before the guard was never tracked — its completion notification relied on
  // the 2s discovery poll re-finding it. The fix moves backgroundTasks.add()
  // above the stale guard so busy sessions are always tracked.
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  let releaseHistory!: () => void
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/history')) {
      await historyGate
      return { ok: true, async json() { return { history: [] } } }
    }
    if (url.includes('/status')) {
      // The session is BUSY — this is what triggers backgroundTasks.add().
      return { ok: true, async json() { return { state: 'busy' } } }
    }
    if (url.includes('/sessions')) {
      return { ok: true, async json() { return { sessions: [] } } }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const controller = new AgentHomeController()
  try {
    const privateController = controller as unknown as {
      openSession(agent: string, sessionId: string): Promise<void>
      openSessionsList(agent: string): Promise<void>
      backgroundTasks: Set<string>
    }

    // Start opening a BUSY session, then supersede it with a sessions-list
    // navigation before openSession's history fetch resolves.
    const staleOpen = privateController.openSession('openclaw', 'busy-session')
    await Promise.resolve()
    await privateController.openSessionsList('openclaw')
    // Now let the stalled openSession resolve — it will hit the stale guard.
    releaseHistory()
    await staleOpen

    // Despite the stale return, the busy session must be tracked so its
    // completion can surface a notification.
    assert.ok(
      privateController.backgroundTasks.has('openclaw::busy-session'),
      `busy session must be registered for background polling despite stale openSession; tasks=${JSON.stringify([...privateController.backgroundTasks])}`
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stale openSessionsList result cannot overwrite a newer openSession', async () => {
  // Coverage gap #1: the existing race test races openSession as the stale
  // producer. This races openSessionsList as the stale producer: a stalled
  // /sessions fetch must not overwrite the messages screen a newer openSession
  // navigated to.
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  let releaseSessions!: () => void
  const sessionsGate = new Promise<void>(resolve => { releaseSessions = resolve })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/sessions')) {
      await sessionsGate // stall the list fetch (stale producer)
      return { ok: true, async json() { return { sessions: [{ id: 'stale-sess', title: 'Stale', timestamp: '2026-06-25T00:00:00.000Z' }] } } }
    }
    if (url.includes('/history')) {
      return { ok: true, async json() { return { history: [{ role: 'assistant', text: 'real message' }] } } }
    }
    if (url.includes('/status')) {
      return { ok: true, async json() { return { state: 'idle' } } }
    }
    throw new Error(`unexpected fetch: ${url}`)
  }) as typeof fetch

  const controller = new AgentHomeController()
  try {
    const privateController = controller as unknown as {
      openSession(agent: string, sessionId: string): Promise<void>
      openSessionsList(agent: string): Promise<void>
    }

    // Start a sessions-list load, then supersede it with an openSession
    // navigation before the list fetch resolves.
    const staleList = privateController.openSessionsList('openclaw')
    await Promise.resolve()
    await privateController.openSession('openclaw', 'session-1')
    releaseSessions()
    await staleList

    // The newer openSession (messages screen) must win.
    assert.equal(controller.getState().screen, 'sidebar.messages')
    assert.equal(controller.getState().sessionId, 'session-1')
  } finally {
    controller.dispose()
    globalThis.fetch = originalFetch
  }
})

test('failed session-list reload restores the prior sidebar.agents screen', async () => {
  // Coverage gap #2a: the existing restore test only covers the sidebar.messages
  // branch. This covers the sidebar.agents branch of the previousState restore.
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: false, status: 502, statusText: 'Bad Gateway',
    async json() { return { error: 'sessions failed' } },
  })) as typeof fetch

  const controller = new AgentHomeController()
  try {
    ;(controller as unknown as { state: unknown }).state = {
      screen: 'sidebar.agents',
      agents: ['openclaw', 'codex'],
      selectedAgentIndex: 0,
    }
    const privateController = controller as unknown as {
      openSessionsList(agent: string): Promise<void>
    }
    await privateController.openSessionsList('openclaw')

    // Should restore to the agents screen, not be stuck on loading.
    assert.equal(controller.getState().screen, 'sidebar.agents')
    assert.deepEqual((controller.getState() as { agents?: string[] }).agents, ['openclaw', 'codex'])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('failed session-list reload restores the prior sidebar.sessions screen', async () => {
  // Coverage gap #2b: the sidebar.sessions branch of the previousState restore.
  __resetApiStateForTests()
  await setApiConfig({
    baseUrl: 'http://backend.test',
    token: 'token',
    autoScrollLastExchange: true,
    scrollSpeed: 'medium',
  })

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({
    ok: false, status: 502, statusText: 'Bad Gateway',
    async json() { return { error: 'sessions failed' } },
  })) as typeof fetch

  const controller = new AgentHomeController()
  try {
    const priorSessions = [{ id: 'old-1', title: 'Old Session', state: 'idle' }]
    ;(controller as unknown as { state: unknown }).state = {
      screen: 'sidebar.sessions',
      agent: 'openclaw',
      sessions: priorSessions,
      selectedSessionIndex: 0,
    }
    const privateController = controller as unknown as {
      openSessionsList(agent: string): Promise<void>
    }
    await privateController.openSessionsList('openclaw')

    assert.equal(controller.getState().screen, 'sidebar.sessions')
    assert.deepEqual((controller.getState() as { sessions?: { id: string }[] }).sessions, priorSessions)
  } finally {
    globalThis.fetch = originalFetch
  }
})
