#!/usr/bin/env node
// scripts/simulator-topic-scroll.mjs
//
// Standalone test that drives the Even Hub simulator with only
// up/down/click/double_click and asserts the user can navigate to
// three forum topics and exhaustively scroll through all 12 of their
// messages. Each fixture message embeds a `topic-N-m<M>` anchor so
// the harness can assert "I saw message M of topic N" without parsing
// the controller's state.messages structure.
//
// Usage:
//   1. Start Vite in fixture mode:
//        VITE_AGENT_HOME_FIXTURE=1 npm run dev
//   2. Start the simulator:
//        npx --yes @evenrealities/evenhub-simulator@0.7.2 \
//          http://localhost:5173 --automation-port 9898
//   3. Run this script:
//        node scripts/simulator-topic-scroll.mjs
//
// Exits 0 if every topic yielded every anchor, 1 otherwise.

import { setTimeout as delay } from 'timers/promises'

const SIM_URL = process.env.SIMULATOR_URL ?? 'http://localhost:9898'
const TOPICS_TO_TEST = [4, 5, 6]
const MESSAGES_PER_TOPIC = 12
const MAX_SWIPES_PER_TOPIC = 30

let consoleSinceId = 0

async function postInput(action, { quietMs = 750 } = {}) {
  const res = await fetch(`${SIM_URL}/api/input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  })
  if (!res.ok) throw new Error(`simulator /api/input ${action} returned ${res.status}`)
  await delay(quietMs)
}

async function pollConsole() {
  const res = await fetch(`${SIM_URL}/api/console?since_id=${consoleSinceId}`)
  if (!res.ok) throw new Error(`console poll failed: ${res.status}`)
  const payload = await res.json()
  const entries = payload.entries ?? []
  for (const entry of entries) {
    consoleSinceId = Math.max(consoleSinceId, Number(entry.id ?? 0) + 1)
  }
  return entries
}

function parseTestEvents(entries) {
  const events = []
  for (const entry of entries) {
    const message = String(entry.message ?? '')
    const marker = '[AgentHomeTest] '
    const index = message.indexOf(marker)
    if (index < 0) continue
    try {
      const parsed = JSON.parse(message.slice(index + marker.length))
      events.push(parsed)
    } catch {
      // Skip malformed events.
    }
  }
  return events
}

function latestState(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.event === 'state') return ev
  }
  return null
}

function latestSidebarRender(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i]
    if (ev?.event === 'render' && ev?.model?.kind === 'sidebar') return ev
  }
  return null
}

function currentScreenModel(events) {
  return latestSidebarRender(events)?.model ?? null
}

async function waitForCondition(predicate, { timeoutMs = 30_000, intervalMs = 300, label = 'condition' } = {}) {
  const started = Date.now()
  let last = []
  while (Date.now() - started < timeoutMs) {
    const entries = await pollConsole()
    const events = parseTestEvents(entries)
    last = events
    if (predicate(events)) return events
    await delay(intervalMs)
  }
  throw new Error(`waitForCondition timed out after ${timeoutMs}ms waiting for: ${label}\nLast events: ${JSON.stringify(last.slice(-5), null, 2)}`)
}

function expectedAnchorsForTopic(topic) {
  const anchors = []
  for (let m = 1; m <= MESSAGES_PER_TOPIC; m += 1) {
    anchors.push(`topic-${topic}-m${m}`)
  }
  return anchors
}

async function waitForChatsScreen() {
  return waitForCondition(
    (events) => {
      const state = latestState(events)
      const model = currentScreenModel(events)
      return state?.focus === 'chats' && (model?.sidebarItemCount ?? 0) >= 5
    },
    { timeoutMs: 20_000, label: 'chats focus with 5 chats' },
  )
}

async function openForum() {
  // Chats fixture: [Alpha(0), Forum(1), Ops(2), Research(3), Archive(4)].
  // Navigate to Forum (index 1) and open it. The press delay is
  // 750ms to clear the controller's `selectionOnlyPressReadyAt`
  // 600ms guard so the next press actually advances selectedChatIndex.
  await postInput('down')
  await waitForCondition(
    (events) => {
      const state = latestState(events)
      const model = currentScreenModel(events)
      return state?.focus === 'chats' && model?.sidebarSelected === 1
    },
    { timeoutMs: 5_000, label: 'sidebarSelected=1' },
  )
  await postInput('click')
  await waitForCondition(
    (events) => {
      const model = currentScreenModel(events)
      return model?.focus === 'topics'
    },
    { timeoutMs: 8_000, label: 'focus=topics' },
  )
}

async function openTopic(targetIndex) {
  // Topics 0..6 in the fixture. Default selectedTopicIndex is 0.
  // Each `down` advances the highlight by one. `click` opens the
  // selected topic and transitions to `focus: 'messages'`.
  for (let i = 0; i < targetIndex; i += 1) {
    await postInput('down')
    await waitForCondition(
      (events) => {
        const model = currentScreenModel(events)
        return model?.focus === 'topics' && model?.sidebarSelected === i + 1
      },
      { timeoutMs: 5_000, label: `topics sidebarSelected=${i + 1}` },
    )
  }
  await postInput('click')
  await waitForCondition(
    (events) => {
      const model = currentScreenModel(events)
      return model?.focus === 'messages'
    },
    { timeoutMs: 8_000, label: 'focus=messages' },
  )
}

async function exhaustivelyScroll(topic) {
  // Each swipeUp advances the scroll offset; older-page fetches
  // happen automatically when the controller reaches the end of
  // the currently loaded messages. We track which `topic-N-m<M>`
  // anchors we've seen in the rendered body and stop when a swipe
  // produces no new anchor AND the scroll offset stops advancing
  // for two consecutive swipes.
  const seen = new Set()
  const expected = expectedAnchorsForTopic(topic)
  let lastSeenSize = -1
  let stableCount = 0
  for (let i = 0; i < MAX_SWIPES_PER_TOPIC; i += 1) {
    await postInput('up')
    // The fixture's listMessages has an 80ms delay; older-page
    // fetch takes another 80ms. 600ms is enough to let both
    // round-trips complete before we read state.
    await delay(600)
    const entries = await pollConsole()
    const events = parseTestEvents(entries)
    const model = currentScreenModel(events)
    const body = model?.panelBodyExcerpt ?? ''
    const box = model?.panelBox?.contentExcerpt ?? ''
    const combined = `${body}\n${box}`
    for (const anchor of expected) {
      if (combined.includes(anchor)) seen.add(anchor)
    }
    if (seen.size >= MESSAGES_PER_TOPIC) {
      return { seen, swipes: i + 1, complete: true }
    }
    if (lastSeenSize === seen.size) {
      stableCount += 1
      if (stableCount >= 2) {
        return { seen, swipes: i + 1, complete: false }
      }
    } else {
      stableCount = 0
    }
    lastSeenSize = seen.size
  }
  return { seen, swipes: MAX_SWIPES_PER_TOPIC, complete: false }
}

async function backToTopics() {
  await postInput('double_click')
  await waitForCondition(
    (events) => {
      const model = currentScreenModel(events)
      return model?.focus === 'topics'
    },
    { timeoutMs: 5_000, label: 'back to topics' },
  )
}

async function run() {
  const results = []
  console.log('Waiting for app to load...')
  await waitForChatsScreen()
  console.log('Opening Project forum...')
  await openForum()
  console.log('Forum topics visible.')

  for (const topic of TOPICS_TO_TEST) {
    console.log(`\n=== Topic ${topic} ===`)
    console.log(`  Highlighting topic ${topic} (sidebarSelected=${topic})...`)
    await openTopic(topic)
    console.log(`  Topic ${topic} opened, focus=messages. Exhaustively scrolling...`)
    const { seen, swipes, complete } = await exhaustivelyScroll(topic)
    const expected = expectedAnchorsForTopic(topic)
    const missing = expected.filter((a) => !seen.has(a))
    const pass = missing.length === 0
    results.push({ topic, seen: [...seen].sort(), missing, swipes, complete, pass })
    console.log(`  ${swipes} swipes, ${seen.size}/${MESSAGES_PER_TOPIC} anchors seen`)
    if (!pass) {
      console.log(`  MISSING: ${missing.join(', ')}`)
    } else {
      console.log(`  ALL ${MESSAGES_PER_TOPIC} MESSAGES OBSERVED.`)
    }
    if (topic < TOPICS_TO_TEST[TOPICS_TO_TEST.length - 1]) {
      console.log('  Going back to topics list...')
      await backToTopics()
    }
  }

  console.log('\n=== Summary ===')
  for (const r of results) {
    console.log(
      `Topic ${r.topic}: ${r.pass ? 'PASS' : 'FAIL'} (${r.seen.length}/${MESSAGES_PER_TOPIC} messages, ${r.swipes} swipes${r.complete ? '' : ', INCOMPLETE'})`,
    )
  }
  const allPass = results.every((r) => r.pass)
  process.exit(allPass ? 0 : 1)
}

run().catch((err) => {
  console.error('FATAL:', err)
  process.exit(2)
})
