import assert from 'node:assert/strict'
import { calculateInitialScrollOffset, getScreenModel } from '../web/src/controller/model.ts'
import type { AppState } from '../web/src/controller/model.ts'

const agent = 'Agent'

function longText(label: string, words: number) {
  return Array.from({ length: words }, (_, i) => `${label}${i}`).join(' ')
}

function panelBodyFor(messages: Array<{ role: string; text: string }>, scrollOffset: number) {
  const state: AppState = {
    screen: 'sidebar.messages',
    agent,
    sessionId: 'test-session',
    messages,
    scrollOffset,
  }
  const model = getScreenModel(state)
  assert.equal(model.kind, 'sidebar')
  return model.panelBody
}

const shortConversation = [
  { role: 'user', text: 'Hello' },
  { role: 'assistant', text: 'Hi. How can I help?' },
]

assert.equal(
  calculateInitialScrollOffset(shortConversation, agent),
  0,
  'short conversations should open at the bottom without auto-scroll',
)

const longConversation = [
  { role: 'user', text: 'First question' },
  { role: 'assistant', text: longText('first-answer-', 80) },
  { role: 'user', text: 'Latest question anchor' },
  { role: 'assistant', text: longText('latest-answer-', 140) },
]

const initialOffset = calculateInitialScrollOffset(longConversation, agent)
assert.ok(initialOffset > 0, `long latest replies should start above the bottom, got ${initialOffset}`)
assert.ok(initialOffset <= 24, `initial offset should respect the 24-line cap, got ${initialOffset}`)

const initialBody = panelBodyFor(longConversation, initialOffset)
assert.match(
  initialBody,
  /Latest question anchor|latest-answer-/,
  'initial auto-scroll window should keep the latest turn in view',
)

const bottomBody = panelBodyFor(longConversation, 0)
assert.notEqual(
  initialBody,
  bottomBody,
  'manual or automatic scroll offset changes should alter the visible glasses body',
)
assert.match(bottomBody, /latest-answer-/, 'bottom view should show the latest assistant reply')

const hugeConversation = [
  { role: 'user', text: 'Initial prompt' },
  { role: 'assistant', text: longText('huge-answer-', 800) },
  { role: 'user', text: 'Follow-up prompt' },
  { role: 'assistant', text: longText('follow-up-answer-', 800) },
]

assert.equal(
  calculateInitialScrollOffset(hugeConversation, agent),
  24,
  'very long conversations should cap initial auto-scroll at 24 lines',
)

const withNewAssistantMessage = [
  ...longConversation,
  { role: 'assistant', text: 'Newest completion anchor' },
]

const newMessageBody = panelBodyFor(withNewAssistantMessage, 0)
assert.match(
  newMessageBody,
  /Newest completion anchor/,
  'newly appended assistant messages should be visible when scrollOffset resets to 0',
)

const visibleLineCount = newMessageBody.split('\n').length
assert.ok(visibleLineCount <= 5, `message panel must stay within five rendered lines, got ${visibleLineCount}`)

console.log('Auto-scroll regression checks passed.')
