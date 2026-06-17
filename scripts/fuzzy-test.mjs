#!/usr/bin/env node

/**
 * Fuzzy test runner for AgentHome glasses UI.
 *
 * Starts Vite + Even Hub simulator, drives 100+ random input sequences
 * (up/down/click/double_click). After each input, validates structural
 * invariants (state machine, UI rendering, performance).
 *
 * Usage:
 *   node scripts/fuzzy-test.mjs [iterations]
 *   node scripts/fuzzy-test.mjs 200 --mode real
 *
 * Default iterations: 100
 * Default mode: fixture
 */

import { spawn } from 'node:child_process'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

async function cleanOldArtifacts(kind) {
  const dir = path.join(repoRoot, 'artifacts', kind)
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch { return }
  const dirs = entries
    .filter(e => e.isDirectory())
    .map(e => ({ name: e.name, ts: e.name.replace(/T(\d+)-(\d+)-(\d+)-(\d+)Z$/, 'T$1:$2:$3.$4Z') }))
    .map(e => ({ name: e.name, mtime: new Date(e.ts).getTime() }))
    .filter(e => !isNaN(e.mtime))
    .sort((a, b) => b.mtime - a.mtime)
  // Keep the newest existing dir, remove the rest
  for (let i = 1; i < dirs.length; i++) {
    await rm(path.join(dir, dirs[i].name), { recursive: true, force: true }).catch(() => {})
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webRoot = path.join(repoRoot, 'web')
const args = parseArgs(process.argv.slice(2))
const iterations = Math.max(1, Math.min(1000, Number(process.argv[2] ?? 100) || 100))
const seed = Number(args.seed ?? Date.now()) >>> 0
const vitePort = Number(args['vite-port'] ?? process.env.VITE_PORT ?? 5173)
const automationPort = Number(args['automation-port'] ?? 9899)
const runMode = args['mode'] ?? 'fixture'
const isFixtureMode = runMode === 'fixture'
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const artifactRoot = path.join(repoRoot, 'artifacts', 'fuzzy-test', timestamp)
const testHost = process.env.AGENT_HOME_TEST_HOST ?? 'localhost'
const testToken = 'my_super_secret_persistent_token_123'
const testParams = new URLSearchParams()
if (isFixtureMode) testParams.set('agentHomeFixture', '1')
testParams.set('token', testToken)
const testUrl = `http://${testHost}:${vitePort}/?${testParams.toString()}`
const simUrl = `http://${testHost}:${automationPort}`
const INPUT_TYPES = ['up', 'down', 'click', 'double_click']

const children = []
const testEvents = []
const failures = []
const warnings = []
const transitionsHistory = []
let consoleSinceId = 0
let inputCount = 0
let randomState = seed

function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
  return randomState / 0x100000000
}

// --- Valid states and transitions (summarized AppState format) ---

const VALID_SCREENS = new Set([
  'loading', 'sidebar.agents', 'sidebar.sessions', 'sidebar.messages',
  'sidebarRecording', 'sidebarTranscribing', 'sidebarConfirm',
  'sidebarSending', 'notification', 'asleep'
])

const VALID_TRANSITIONS = {
  loading: ['sidebar.agents', 'sidebar.sessions', 'sidebar.messages', 'loading'],
  'sidebar.agents': ['sidebar.agents', 'sidebar.sessions', 'loading', 'asleep'],
  'sidebar.sessions': ['sidebar.sessions', 'sidebar.messages', 'sidebar.agents', 'loading', 'asleep'],
  'sidebar.messages': ['sidebar.messages', 'sidebarRecording', 'sidebar.sessions', 'notification', 'loading', 'asleep'],
  sidebarRecording: ['sidebarRecording', 'sidebarTranscribing', 'sidebarConfirm', 'sidebar.messages', 'notification', 'loading', 'asleep'],
  sidebarTranscribing: ['sidebarTranscribing', 'sidebarConfirm', 'sidebar.messages', 'notification', 'asleep'],
  sidebarConfirm: ['sidebarConfirm', 'sidebarSending', 'sidebar.messages', 'notification', 'loading', 'asleep'],
  sidebarSending: ['sidebarSending', 'sidebar.messages', 'sidebar.sessions', 'notification', 'loading', 'asleep'],
  notification: ['notification', 'sidebar.messages', 'sidebar.sessions', 'loading', 'asleep'],
  asleep: ['loading', 'sidebar.agents', 'sidebar.sessions', 'sidebar.messages', 'sidebarRecording', 'sidebarTranscribing', 'sidebarConfirm', 'sidebarSending', 'notification', 'asleep'],
}

function isValidState(state) {
  if (!state || typeof state !== 'object') return 'state is not an object'
  const screen = state.screen
  if (!VALID_SCREENS.has(screen)) return `unknown screen: ${screen}`

  if (screen === 'loading') {
    if (!state.message) return 'loading without message'
  }

  if (screen === 'sidebar.agents') {
    if (!Array.isArray(state.agents)) return 'agents focus without valid agents array'
    // frontend state.agents is an array of strings (agent IDs) that are enabled/available
    if (state.agents.length > 0 && typeof state.agents[0] !== 'string') return 'state.agents must be array of strings'
    if (state.selectedAgentIndex < 0 || state.selectedAgentIndex > Math.max(0, state.agents.length - 1))
      return `selectedAgentIndex ${state.selectedAgentIndex} out of range`
  }
  
  if (screen === 'sidebar.sessions') {
    if (!state.agent) return 'sessions without agent'
    if (!Array.isArray(state.sessions)) return 'sessions without valid sessions array'
    for (const session of state.sessions) {
      if (session.state !== 'idle' && session.state !== 'busy') {
        return `session ${session.id} has invalid state ${session.state}`
      }
    }
    if (state.selectedSessionIndex < 0 || state.selectedSessionIndex > Math.max(0, state.sessions.length - 1))
      return `selectedSessionIndex ${state.selectedSessionIndex} out of range`
  }

  if (screen === 'sidebar.messages' || screen === 'sidebarRecording' || screen === 'sidebarTranscribing' || screen === 'sidebarConfirm' || screen === 'sidebarSending') {
    if (!state.agent) return `${screen} without agent`
    if (typeof state.sessionId !== 'string') return `${screen} without sessionId`
    if (!Array.isArray(state.messages)) return `${screen} without messages array`
    if (typeof state.scrollOffset !== 'number' || state.scrollOffset < 0)
      return `invalid scrollOffset: ${state.scrollOffset}`
  }

  if (['sidebarConfirm', 'sidebarSending'].includes(screen)) {
    if (typeof state.transcript !== 'string') return `${screen} without transcript`
  }

  if (screen === 'notification') {
    if (typeof state.messageText !== 'string') return `notification without messageText`
    if (!state.agent) return `notification without agent`
  }

  return null
}

function isValidTransition(prev, next) {
  const allowed = prev ? VALID_TRANSITIONS[prev.screen] : null
  return allowed ? allowed.includes(next.screen) : false
}

// --- Utilities ---

function parseArgs(values) {
  const parsed = {}
  for (let i = 0; i < values.length; i += 1) {
    const v = values[i]
    if (!v.startsWith('--')) continue
    const key = v.slice(2)
    const next = values[i + 1]
    if (!next || next.startsWith('--')) { parsed[key] = true } else { parsed[key] = next; i += 1 }
  }
  return parsed
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

function fetchWithTimeout(url, init, timeoutMs) {
  const c = new AbortController()
  const t = setTimeout(() => c.abort(), timeoutMs)
  return fetch(url, { ...(init ?? {}), signal: c.signal }).finally(() => clearTimeout(t))
}

function startProcess(name, cmd, cmdArgs, opts) {
  const child = spawn(cmd, cmdArgs, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  children.push(child)
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`))
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`))
  child.on('exit', (code, signal) => {
    if (code !== 0 && signal !== 'SIGTERM') failures.push(`${name} exited code ${code ?? signal}`)
  })
  return child
}

function stopProcessTree(child) {
  if (child.killed) return
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
}

async function waitForHttp(url, timeoutMs, expectText) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await fetchWithTimeout(url, undefined, 3000)
      const t = await r.text()
      if (r.ok && (expectText === undefined || t.trim() === expectText)) return
    } catch { /* retry */ }
    await sleep(100)
  }
  throw new Error(`Timed out waiting for ${url}`)
}

async function postInput(action) {
  const r = await fetchWithTimeout(`${simUrl}/api/input`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  }, 5000)
  if (!r.ok) failures.push(`input ${action} returned ${r.status}`)
}

async function pollConsole() {
  const r = await fetchWithTimeout(`${simUrl}/api/console?since_id=${consoleSinceId}`, undefined, 3000)
  if (!r.ok) return
  const p = await r.json()
  for (const entry of (p.entries ?? [])) {
    consoleSinceId = Math.max(consoleSinceId, Number(entry.id ?? 0) + 1)
    const marker = '[AgentHomeTest] '
    const msg = String(entry.message ?? '')
    const idx = msg.indexOf(marker)
    if (idx >= 0) {
      try { testEvents.push(JSON.parse(msg.slice(idx + marker.length))) } catch { /* skip */ }
    }
  }
}

function extractLatestState() {
  for (let i = testEvents.length - 1; i >= 0; i -= 1) {
    if (testEvents[i].event === 'state') return testEvents[i]
  }
  return null
}

function extractLatestRender() {
  for (let i = testEvents.length - 1; i >= 0; i -= 1) {
    if (testEvents[i].event === 'render') return testEvents[i]
  }
  return null
}

function checkStructuralInvariants(prevState) {
  const issues = []
  const state = extractLatestState()
  const render = extractLatestRender()

  if (state) {
    const v = isValidState(state)
    if (v) issues.push(`S1: ${v}`)
  }

  if (state && render) {
    const m = render.model ?? {}
    if (m.title && Buffer.byteLength(m.title, 'utf8') > 120) issues.push('S3: title > 120 bytes')
    if (typeof m.panelBodyLength === 'number' && m.panelBodyLength > 999) issues.push('S3: panelBody > 999 bytes')
    if (m.panelFooter && Buffer.byteLength(m.panelFooter, 'utf8') > 120) issues.push('S3: panelFooter > 120 bytes')
    if (Array.isArray(m.sidebarItems)) {
      if (m.sidebarItems.length < 1) issues.push('S3: sidebarItems is empty')
      if (m.sidebarItems.length > 20) issues.push(`S3: sidebarItems ${m.sidebarItems.length} > 20`)
      for (const it of m.sidebarItems) {
        if (Buffer.byteLength(String(it ?? ''), 'utf8') > 64) issues.push('S3: sidebarItem > 64 bytes')
      }
    }
  }

  if (state && state.screen === 'sidebar.messages') {
    if (typeof state.scrollOffset !== 'number' || state.scrollOffset < 0) {
      issues.push(`S4: invalid scrollOffset ${state.scrollOffset}`);
    }
    if (prevState && prevState.screen === 'sidebar.messages') {
      if (prevState.messages && state.messages && state.messages.length > prevState.messages.length) {
        if (state.scrollOffset !== 0) {
          issues.push(`S4: scrollOffset must be 0 when new message is added (was ${state.scrollOffset})`);
        }
      }
    }
  }

  return issues
}

// --- Main ---

async function main() {
  await cleanOldArtifacts('fuzzy-test')
  await mkdir(artifactRoot, { recursive: true })

  console.log(`\n==> AgentHome Fuzzy Test Runner <==`)
  console.log(`    Iterations: ${iterations}`)
  console.log(`    Mode:       ${runMode}\n`)
  console.log(`    Seed:       ${seed}\n`)

  console.log(`[fuzzy] Starting Vite on ${testHost}:${vitePort}...`)
  const vite = startProcess('vite', 'npm', [
    'run', 'dev', '--', '--host', testHost, '--port', String(vitePort),
  ], {
    cwd: webRoot,
    env: { ...process.env },
  })
  
  console.log(`[fuzzy] Starting backend on port 3456...`)
  const backend = startProcess('backend', 'node', ['bin/even-agent-home.js', '--token', testToken], {
    cwd: path.join(repoRoot, 'backend'),
    env: { ...process.env },
  })

  await waitForHttp(testUrl, 30000)
  
  // Wait for backend manually
  const deadlineBackend = Date.now() + 30000
  while (Date.now() < deadlineBackend) {
    try {
      const res = await fetch(`http://localhost:3456/api/agents`, { headers: { 'Authorization': `Bearer ${testToken}` } })
      if (res.ok) break
    } catch {}
    await sleep(100)
  }

  console.log(`[fuzzy] Starting simulator on port ${automationPort}...`)
  startProcess('simulator', 'npx', [
    '@evenrealities/evenhub-simulator@0.7.2',
    '--automation-port', String(automationPort), testUrl,
  ], { cwd: repoRoot })
  await waitForHttp(`${simUrl}/api/ping`, 20000, 'pong')

  await fetchWithTimeout(`${simUrl}/api/console`, { method: 'DELETE' }, 3000)
  consoleSinceId = 0

  // Wait for non-loading state
  const deadline = Date.now() + 10000
  let firstState = null
  while (Date.now() < deadline) {
    await pollConsole()
    const s = extractLatestState()
    if (s && s.screen !== 'loading') { firstState = s; break }
    await sleep(100)
  }

  if (!firstState) {
    failures.push('App did not reach non-loading state in 10s (likely auth not configured or backend unreachable)')
    console.log(`[fuzzy] Startup timeout - no non-loading state within 10s`)
    console.log(`[fuzzy] Common causes: (1) seed-credentials.local.json not populated, (2) backend not running, (3) backend shared secret mismatch`)
    for (const child of children.reverse()) stopProcessTree(child)
    process.exit(1)
  }

  testEvents.length = 0

  console.log(`[fuzzy] Startup: ${firstState.screen}@${firstState.focus ?? '-'}`)
  console.log(`[fuzzy] Running ${iterations} random inputs...`)

  let prevState = firstState
  let consecutiveStuck = 0
  let structuralIssues = []
  const reportedStructuralIssues = new Set()

  for (let iter = 0; iter < iterations; iter += 1) {
    const inputType = INPUT_TYPES[Math.floor(random() * INPUT_TYPES.length)]
    const eventStartIndex = testEvents.length

    await postInput(inputType)
    inputCount += 1

    // Leave enough room for the bridge's input coalescer/debounce windows.
    // The simulator accepts synthetic inputs faster than a user can gesture;
    // sending taps ~80ms apart makes legitimate duplicate suppression look
    // like lost dispatch telemetry.
    await sleep(180)
    await pollConsole()
    await sleep(40)
    await pollConsole()

    const currentState = extractLatestState()

    if (!currentState) {
      consecutiveStuck += 1
      if (consecutiveStuck > 30) {
        failures.push(`No state after ${consecutiveStuck} inputs (iter ${iter})`)
        break
      }
      continue
    }
    consecutiveStuck = 0

    if (prevState && !isValidTransition(prevState, currentState)) {
      failures.push(
        `Iter ${iter}: invalid transition ${prevState.screen}@${prevState.focus ?? '-'} -> ${currentState.screen}@${currentState.focus ?? '-'} via ${inputType}`,
      )
    }
    transitionsHistory.push({
      iter, from: prevState.screen, to: currentState.screen, via: inputType,
    })

    const violation = isValidState(currentState)
    if (violation) {
      failures.push(`Iter ${iter}: ${violation} [${inputType}] screen=${currentState.screen} focus=${currentState.focus ?? '-'}`)
    }

    structuralIssues = structuralIssues.concat(checkStructuralInvariants(prevState).map((i) => `Iter ${iter}: ${i}`))
    for (const issue of checkStructuralInvariants(prevState)) {
      if (reportedStructuralIssues.has(issue)) continue
      reportedStructuralIssues.add(issue)
      failures.push(`Iter ${iter}: ${issue}`)
    }

    const inputEvents = testEvents.slice(eventStartIndex)
    const dispatchSamples = inputEvents.filter((event) => event.event === 'input.dispatch')
    if (dispatchSamples.length === 0) {
      failures.push(`Iter ${iter}: no input.dispatch telemetry for ${inputType}`)
      console.log(`[DEBUG] inputEvents for iter ${iter}:`, JSON.stringify(inputEvents))
    }
    for (const sample of dispatchSamples) {
      if (Number(sample.listenerMs) > 50) failures.push(`Iter ${iter}: input listener took ${sample.listenerMs}ms (>50ms)`)
    }
    for (const sample of inputEvents.filter((event) => event.event === 'state')) {
      if (Number(sample.syncMs) > 50) failures.push(`Iter ${iter}: sync work took ${sample.syncMs}ms (>50ms)`)
    }

    prevState = currentState

    if (iter > 0 && iter % 25 === 0) {
      console.log(`[fuzzy] ${iter}/${iterations} (${failures.length} failures)`)
    }
  }

  const finalState = extractLatestState()
  const uniqueStructural = [...new Set(structuralIssues)]
  if (uniqueStructural.length > 50) warnings.push(`${uniqueStructural.length} structural issues (top 50)`)

  await writeFile(path.join(artifactRoot, 'results.json'), JSON.stringify({
    iterations, seed, inputCount, failures: failures.length, transitions: transitionsHistory.length,
  }, null, 2))
  await writeFile(path.join(artifactRoot, 'transitions.json'),
    JSON.stringify(transitionsHistory.slice(-200), null, 2))
  await writeFile(path.join(artifactRoot, 'structural-issues.json'),
    JSON.stringify(uniqueStructural.slice(0, 100), null, 2))

  console.log(`\n==> Results`)
  console.log(`    Iterations:       ${iterations}`)
  console.log(`    Seed:             ${seed}`)
  console.log(`    Total inputs:     ${inputCount}`)
  console.log(`    Failures:         ${failures.length}`)
  console.log(`    Structural:       ${uniqueStructural.length}`)
  console.log(`    Start: ${firstState.screen}@${firstState.focus ?? '-'}`)
  console.log(`    End:   ${finalState?.screen ?? '?'}@${finalState?.focus ?? '?'}`)
  console.log(`    Artifacts: ${artifactRoot}`)
  console.log(`    Replay: node scripts/fuzzy-test.mjs ${iterations} --seed ${seed}${runMode === 'real' ? ' --mode real' : ''}`)

  if (failures.length > 0) {
    console.log(`\nFailures (${failures.length}):`)
    for (const f of failures.slice(0, 30)) console.log(`  * ${f}`)
  }

  for (const child of children.reverse()) stopProcessTree(child)
  if (failures.length > 0) process.exitCode = 1
}

await main().catch((err) => {
  console.error(`[fuzzy] Fatal: ${err instanceof Error ? err.message : String(err)}`)
  for (const child of children.reverse()) stopProcessTree(child)
  process.exitCode = 1
})
