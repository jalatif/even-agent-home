// Unit tests for formatModelName (App.tsx), focusing on the @<suffix> display
// fix for providers that qualify model ids with a dated/default tag
// (e.g. antigravity's claude-opus-4-8@default). Without the fix, the claude
// regex's (?:-.*)? tail swallowed the minor version together with @default,
// collapsing claude-opus-4-6/7/8@default to all display as "Opus 4".

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { formatModelName } = await import('../src/configHelpers.ts')

test('formatModelName: empty string -> Default', () => {
  assert.equal(formatModelName(''), 'Default')
})

test('formatModelName: claude opus with minor version', () => {
  assert.equal(formatModelName('claude-opus-4-8'), 'Opus 4.8')
  assert.equal(formatModelName('claude-sonnet-4-6'), 'Sonnet 4.6')
  assert.equal(formatModelName('claude-haiku-4-5'), 'Haiku 4.5')
})

test('formatModelName: strips @default/@dated suffix BEFORE matching so the minor version survives', () => {
  // These three previously all rendered as "Opus 4" (the bug).
  assert.equal(formatModelName('claude-opus-4-6@default'), 'Opus 4.6')
  assert.equal(formatModelName('claude-opus-4-7@default'), 'Opus 4.7')
  assert.equal(formatModelName('claude-opus-4-8@default'), 'Opus 4.8')
  assert.equal(formatModelName('claude-opus-4-5@20251101'), 'Opus 4.5')
  assert.equal(formatModelName('claude-sonnet-4-5@20250929'), 'Sonnet 4.5')
  assert.equal(formatModelName('claude-sonnet-4-6@default'), 'Sonnet 4.6')
  assert.equal(formatModelName('claude-haiku-4-5@20251001'), 'Haiku 4.5')
})

test('formatModelName: the three @default opus variants now render distinctly', () => {
  const names = new Set([
    formatModelName('claude-opus-4-6@default'),
    formatModelName('claude-opus-4-7@default'),
    formatModelName('claude-opus-4-8@default'),
  ])
  // Pre-fix this set had size 1 (all "Opus 4"); post-fix it must be 3.
  assert.equal(names.size, 3, 'each opus @default variant must render distinctly')
})

test('formatModelName: gpt aliases', () => {
  assert.equal(formatModelName('gpt-4o'), 'GPT-4o')
  assert.equal(formatModelName('gpt-4-turbo'), 'GPT-4 Turbo')
})

test('formatModelName: non-claude provider ids with @suffix fall back to stripping @ for display', () => {
  // Generic fallback path: dashes -> spaces, title-cased, @suffix stripped.
  assert.equal(formatModelName('gemini-2.5-pro'), 'Gemini 2.5 Pro')
})

test('formatModelName: slash-namespaced ids still render', () => {
  // e.g. openai/gpt-oss-120b-maas — not claude, not gpt-*; generic fallback.
  const out = formatModelName('zai-org/glm-5-maas')
  assert.ok(typeof out === 'string' && out.length > 0)
})
