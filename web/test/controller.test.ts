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
