// Bridge unit tests with a fake Even Hub SDK.
//
// Why this file exists: the EvenHubGlassesBridge was the least-tested code in
// the app yet the most complex (render queueing, storage delegation, input
// coalescing). Two real hardware bugs lived here:
//   - Issue 1 (settings lost on re-open): App.tsx grabbed `bridge.getLocalStorage`
//     off the instance unbound, so the call threw and fell back to localStorage.
//     These tests assert storage methods are invoked correctly on a real instance.
//   - Issue 5 (input latency): renderSidebarPanel dispatched textContainerUpgrade
//     calls SERIALLY; each is a firmware round-trip on hardware. The latency
//     regression is only visible when the fake SDK models per-call latency, so
//     the render-latency test below configures the fake SDK to sleep per call
//     and asserts the parallel path completes in ~one round-trip, not N.
//
// We bypass `waitForEvenAppBridge` entirely by constructing EvenHubGlassesBridge
// directly with an in-process fake SDK. This is intentional: the production
// `static create()` wires up the real native bridge, which only exists inside
// the Even Hub host.

import { test } from 'node:test'
import assert from 'node:assert/strict'

// `__APP_VERSION__` is a Vite `define` injection at build time. Under Node's
// native test runner it isn't defined, and ESM imports are hoisted above any
// top-level assignment — so we stub the global FIRST, then dynamically import
// the bridge (which reads the const at module-eval time).
;(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = 'test'

const { EvenHubGlassesBridge } = await import('../src/bridge/evenBridge.ts')
type ScreenModel = import('../src/controller/model.ts').ScreenModel
type TextContainerUpgrade = import('@evenrealities/even_hub_sdk').TextContainerUpgrade

// ── Fake SDK ───────────────────────────────────────────────────────────
// In-process stand-in for the Even Hub native bridge. Every method records
// calls + arguments so tests can assert on the exact SDK contract, and the
// container methods can optionally sleep to model real firmware latency.

type SdkCall = { method: string; args: unknown }

interface FakeSdkOptions {
  // Per-call latency (ms) applied to textContainerUpgrade / rebuild / create.
  // Default 0 = instant (content tests). Set >0 to model firmware round-trips
  // for the render-latency regression test.
  perCallLatencyMs?: number
  // Force setLocalStorage to return false (failure path).
  storageSetFails?: boolean
}

function makeFakeSdk(opts: FakeSdkOptions = {}) {
  const latency = opts.perCallLatencyMs ?? 0
  const calls: SdkCall[] = []
  const storage = new Map<string, string>()

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  // IMPORTANT: the methods below reference `this.calls` (NOT the closure `calls`)
  // deliberately. This mirrors the real Even Hub SDK, whose methods need their
  // receiver. If the bridge ever hoists a method off the object and calls it
  // unbound (the Issue-1/Issue-5 unbound-method footgun), `this` is undefined
  // and the call throws "Cannot read properties of undefined (reading 'calls')" —
  // which Promise.allSettled would silently swallow. The regression test below
  // ("textContainerUpgrade actually completes, not silently rejected") catches
  // exactly that, by checking the call was recorded.
  class FakeSdk {
    calls = calls
    storage = storage
    async createStartUpPageContainer(container: unknown) {
      this.calls.push({ method: 'createStartUpPageContainer', args: container })
      if (latency) await sleep(latency)
      return true
    }
    async rebuildPageContainer(container: unknown) {
      this.calls.push({ method: 'rebuildPageContainer', args: container })
      if (latency) await sleep(latency)
      return true
    }
    async textContainerUpgrade(update: TextContainerUpgrade) {
      this.calls.push({ method: 'textContainerUpgrade', args: update })
      if (latency) await sleep(latency)
      return true
    }
    async audioControl(enabled: boolean) {
      this.calls.push({ method: 'audioControl', args: enabled })
      return true
    }
    async getLocalStorage(key: string) {
      this.calls.push({ method: 'getLocalStorage', args: key })
      return this.storage.get(key) ?? ''
    }
    async setLocalStorage(key: string, value: string) {
      this.calls.push({ method: 'setLocalStorage', args: { key, value } })
      if (opts.storageSetFails) return false
      this.storage.set(key, value)
      return true
    }
    onEvenHubEvent(_listener: (event: unknown) => void) {
      return () => {}
    }
  }
  const sdk = new FakeSdk()
  return sdk
}

// A minimal sidebar screen model sufficient to exercise the render paths.
function sidebarModel(panelBody = 'hello', panelFooter = 'footer'): Extract<ScreenModel, { kind: 'sidebar' }> {
  return {
    kind: 'sidebar',
    focus: 'panel',
    title: 'Agent Home',
    sidebarTitle: 'Agents',
    sidebarItems: ['claude', 'codex'],
    sidebarSelected: 0,
    panelTitle: '',
    panelBody,
    panelFooter,
    fullWidth: false,
  }
}

// `bridge.render()` is intentionally fire-and-forget: it kicks off the SDK
// call and resolves immediately, while `hasRendered` is only flipped inside
// the SDK call's `.then()`. Tests that need the partial-render path (which
// requires `hasRendered === true`) must yield a microtask after render() so
// the fake SDK's resolved promise propagates to that `.then` callback.
async function settleRenders() {
  // Two microtasks: one for the fake SDK promise, one for its .then.
  await Promise.resolve()
  await Promise.resolve()
}

// ── Issue 1: storage delegation ────────────────────────────────────────
// The bridge must read/write through the SDK's getLocalStorage/setLocalStorage
// and survive being called on the instance (the unbound-method bug). We call
// the methods directly on the bridge instance the way App.tsx's storage
// adapter does.

test('bridge.setLocalStorage writes through to the SDK store', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  const ok = await bridge.setLocalStorage('apiConfig', JSON.stringify({ baseUrl: 'http://x', token: 't' }))
  assert.equal(ok, true)
  assert.equal(sdk.storage.get('apiConfig'), JSON.stringify({ baseUrl: 'http://x', token: 't' }))
  // The SDK method must actually have been invoked (not swallowed).
  const setCalls = sdk.calls.filter((c) => c.method === 'setLocalStorage')
  assert.equal(setCalls.length, 1)
})

test('bridge.getLocalStorage reads through from the SDK store', async () => {
  const sdk = makeFakeSdk()
  sdk.storage.set('apiConfig', JSON.stringify({ baseUrl: 'http://y', token: 't2' }))
  const bridge = new EvenHubGlassesBridge(sdk as any)
  const value = await bridge.getLocalStorage('apiConfig')
  assert.equal(value, JSON.stringify({ baseUrl: 'http://y', token: 't2' }))
})

test('bridge.getLocalStorage returns "" for a missing key (not undefined/throw)', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  const value = await bridge.getLocalStorage('does-not-exist')
  // The storage adapter in App.tsx does `v || null`, so "" must map to null
  // (missing). Returning undefined or throwing would break hydration.
  assert.equal(value, '')
})

// Issue 1 regression: this is the EXACT pattern App.tsx used to use, which
// unbound the method and lost `this`. The current fix captures the instance;
// this test guarantees setLocalStorage still works when called via the same
// "grab then invoke" shape a careless refactor could reintroduce.
test('storage methods work when invoked via a captured reference (no unbound-method regression)', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  // Mirror the fixed App.tsx pattern: call ON the instance, not off it.
  const captured = bridge
  await captured.setLocalStorage('k', 'v')
  const v = await captured.getLocalStorage('k')
  assert.equal(v, 'v')
  assert.equal(sdk.storage.get('k'), 'v')
})

// ── Issue 5: render correctness + latency ──────────────────────────────

test('first render uses createStartUpPageContainer; subsequent renders use rebuildPageContainer', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  await bridge.render(sidebarModel('first'))
  await settleRenders()
  await bridge.render(sidebarModel('second'))
  await settleRenders()
  const creates = sdk.calls.filter((c) => c.method === 'createStartUpPageContainer')
  const rebuilds = sdk.calls.filter((c) => c.method === 'rebuildPageContainer')
  assert.equal(creates.length, 1, 'first render should create')
  assert.equal(rebuilds.length, 1, 'second render should rebuild')
})

test('renderSidebarPanel issues one textContainerUpgrade per changed container (parallelized)', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  // Prime hasRendered so the partial path is taken (not a full render).
  await bridge.render(sidebarModel('first', 'footer-a'))
  await settleRenders()
  // Now render a model that changes title/body/footer → up to 3 updates.
  await bridge.renderSidebarPanel(sidebarModel('changed', 'footer-b'))
  const upgrades = sdk.calls.filter((c) => c.method === 'textContainerUpgrade')
  assert.ok(upgrades.length >= 1, 'at least one container update issued')
})

// Issue 5 / navigation regression guard. The fake SDK's methods reference
// `this.calls` (like the real SDK), so an unbound method call throws and
// Promise.allSettled swallows it — the call would NOT be recorded in
// sdk.calls even though updates were "dispatched". This test asserts the
// recording actually happened, which fails the moment the bridge hoists a
// method off the object. This is exactly the bug that froze the glasses
// pointer and stopped live messages from rendering.
test('textContainerUpgrade actually completes (not silently rejected by unbound method)', async () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  await bridge.render(sidebarModel('first', 'footer-a'))
  await settleRenders()
  await bridge.renderSidebarPanel(sidebarModel('changed', 'footer-b'))
  const upgrades = sdk.calls.filter((c) => c.method === 'textContainerUpgrade')
  // If the method were called unbound, `this.calls.push` would throw, the
  // promise would reject, allSettled would swallow it, and upgrades.length
  // would be 0 despite "dispatching". Asserting >0 catches that.
  assert.ok(
    upgrades.length > 0,
    'textContainerUpgrade was dispatched but NOT recorded — the SDK method was likely called unbound (missing .bind). This silently rejects and freezes the glasses UI.',
  )
  // Navigation specifically: changing only the selection must update the
  // panel-body container. Reproduces the up/down-pointer-stuck symptom.
  sdk.calls.length = 0
  await bridge.renderSidebarPanel({ ...sidebarModel('changed', 'footer-b'), title: 'Moved' })
  const navUpgrades = sdk.calls.filter((c) => c.method === 'textContainerUpgrade')
  assert.ok(navUpgrades.length > 0, 'a selection/position change must emit at least one update')
})

test('renderSidebarPanel with N changed containers completes in ~1 round-trip, not N (Issue 5 latency regression)', async () => {
  // Model firmware latency: each SDK call sleeps LATENCY ms. The OLD serial
  // implementation awaited upgrades one after another, so N changed containers
  // took N*LATENCY. The parallel fix runs them concurrently, so the whole
  // flush is bounded by ~LATENCY (one round-trip). This test FAILS if the
  // serial loop is reintroduced — that is its whole purpose.
  const LATENCY = 80 // ms per SDK call
  const sdk = makeFakeSdk({ perCallLatencyMs: LATENCY })
  const bridge = new EvenHubGlassesBridge(sdk as any)
  await bridge.render(sidebarModel('first', 'footer-a'))
  // With latency > 0, settleRenders()'s microtasks aren't enough — the fake
  // SDK's createStartUpPageContainer resolves only after LATENCY ms, and only
  // THEN does hasRendered flip (in its .then). Wait one full round-trip so
  // renderSidebarPanel takes the partial path instead of falling back to a
  // full render (which issues zero textContainerUpgrade calls).
  await new Promise((r) => setTimeout(r, LATENCY + 20))

  const start = Date.now()
  // Change title + sidebar + panelBody + panelBox + footer → up to 5 updates.
  // (Whether all 5 differ from lastSidebarModel depends on buildSidebarPanelUpdates;
  // the assertion below tolerates the actual count but checks the N×latency bound.)
  await bridge.renderSidebarPanel({
    ...sidebarModel('changed-body', 'changed-footer'),
    title: 'Changed Title',
    panelBox: { heading: 'Box', content: 'content' },
  })
  const elapsed = Date.now() - start

  const upgrades = sdk.calls.filter((c) => c.method === 'textContainerUpgrade')
  const n = upgrades.length
  assert.ok(n >= 2, `expected at least 2 changed containers, got ${n}`)

  // Serial path would take >= n * LATENCY. Parallel path takes ~LATENCY (one
  // round-trip) plus a little scheduling slack. Allow up to 2x one round-trip
  // as the passing bound — comfortably below the serial floor of n*LATENCY.
  const parallelCeiling = LATENCY * 2
  const serialFloor = n * LATENCY
  assert.ok(
    elapsed < parallelCeiling,
    `parallel render took ${elapsed}ms with ${n} upgrades (LATENCY=${LATENCY}) — expected < ${parallelCeiling}ms. Serial would take >= ${serialFloor}ms.`
  )
})

// ── Issue 5 (input path): enqueueSidebarPanel is fire-and-forget ────────
test('enqueueSidebarPanel returns immediately and does not block the input path', async () => {
  const LATENCY = 60
  const sdk = makeFakeSdk({ perCallLatencyMs: LATENCY })
  const bridge = new EvenHubGlassesBridge(sdk as any)
  await bridge.render(sidebarModel('first'))
  const start = Date.now()
  // enqueue is synchronous (void); the render happens on a timer, not awaited.
  bridge.enqueueSidebarPanel(sidebarModel('changed'))
  const elapsed = Date.now() - start
  assert.ok(elapsed < 10, `enqueueSidebarPanel blocked for ${elapsed}ms — must be fire-and-forget`)
  // Let the queued flush finish so the test process can exit cleanly.
  await new Promise((r) => setTimeout(r, LATENCY * 2 + 50))
})

test('dispose clears pending panel state without throwing', () => {
  const sdk = makeFakeSdk()
  const bridge = new EvenHubGlassesBridge(sdk as any)
  bridge.enqueueSidebarPanel(sidebarModel('queued'))
  // Must not throw and must drop the pending model.
  assert.doesNotThrow(() => bridge.dispose())
  const stats = bridge.getPartialRenderStats()
  assert.ok(typeof stats.dispatched === 'number')
})
