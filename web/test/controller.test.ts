import { test } from 'node:test'
import assert from 'node:assert/strict'

const { AgentHomeController } = await import('../src/controller/agentHomeController.ts')
const { __resetApiStateForTests } = await import('../src/api.ts')

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
