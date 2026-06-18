import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { GlassesBridge } from '../controller/agentHomeController'
import type { AppInput, ScreenModel } from '../controller/model'
import { createInputCoalescer, mapEvenHubEvent } from './eventMapping'
import {
  isFixtureMode,
  logTestEvent,
  summarizeScreenModel,
} from '../testMode'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuthConfig = any;


const encoder = new TextEncoder()
// Injected by Vite define from app.json — single source of truth for version.
declare const __APP_VERSION__: string
export const APP_BUILD_VERSION: string = __APP_VERSION__


let activeEventListenerToken: symbol | undefined

// Most-recently-created bridge instance. Storage adapter and other modules
// use this to reach the persistent SDK without prop-drilling. Replaced on
// every successful `create` so React StrictMode double-invocation and any
// bridge re-creation always expose the live bridge.
let activeBridge: EvenHubGlassesBridge | undefined
export function getActiveBridge(): EvenHubGlassesBridge | undefined {
  return activeBridge
}

type EvenBridgeInstance = {
  createStartUpPageContainer(container: unknown): Promise<number>
  rebuildPageContainer(container: unknown): Promise<boolean>
  textContainerUpgrade?(container: unknown): Promise<boolean>
  audioControl(enabled: boolean): Promise<unknown>
  shutDownPageContainer?(exitMode?: number): Promise<boolean>
  callEvenApp?(method: string, payload: unknown): Promise<boolean>
  screenOff?(): Promise<boolean>
  turnScreenOff?(): Promise<boolean>
  getLocalStorage?(key: string): Promise<string>
  setLocalStorage?(key: string, value: string): Promise<boolean>
  onEvenHubEvent(listener: (event: unknown) => void): (() => void) | void
}

export class EvenHubGlassesBridge implements GlassesBridge {
  private hasRendered = false
  private pageGeneration = 0
  private renderSequence = 0
  private pendingPanelModel: { model: Extract<ScreenModel, { kind: 'sidebar' }>; generation: number } | undefined
  private panelRenderInFlight = false
  private panelRenderQueuedAfter = false
  private fullRenderInFlight = false
  private partialRenderDispatched = 0
  private partialRenderDropped = 0
  private partialRenderFlushed = 0
  private stalePartialRenderDropped = 0
  private panelRenderTimer: ReturnType<typeof setTimeout> | undefined
  private lastSidebarModel: Extract<ScreenModel, { kind: 'sidebar' }> | undefined
  // Flush the first partial render immediately so every hardware input gives visible
  // feedback. While a native render is in flight, `pendingPanelModel` still keeps only
  // the latest state, preventing slow G2 firmware calls from replaying stale scrolls.
  private readonly panelRenderIdleMs = 0
  private sdk: EvenBridgeInstance
  private unsubscribeEvents?: () => void
  private listenerToken?: symbol

  constructor(
    sdk: EvenBridgeInstance,
    unsubscribeEvents?: () => void,
    listenerToken?: symbol,
  ) {
    this.sdk = sdk
    this.unsubscribeEvents = unsubscribeEvents
    this.listenerToken = listenerToken
  }

  static async create(onInput: (input: AppInput) => void | Promise<void>) {
    const sdk = (await waitForEvenAppBridge()) as unknown as EvenBridgeInstance
    const dispatchInput = createInputCoalescer(onInput)
    const listenerToken = Symbol('even-hub-listener')
    activeEventListenerToken = listenerToken
    const unsubscribeEvents = sdk.onEvenHubEvent((event) => {
      // Some SDK hosts do not actually remove the first listener during React
      // StrictMode cleanup. Only the newest bridge instance may dispatch input.
      if (activeEventListenerToken !== listenerToken) return
      
      const input = mapEvenHubEvent(event as Parameters<typeof mapEvenHubEvent>[0])
      
      if (input) dispatchInput(input)
    })
    return activeBridge = new EvenHubGlassesBridge(
      sdk,
      typeof unsubscribeEvents === 'function' ? unsubscribeEvents : undefined,
      listenerToken,
    )
  }

  private queueDepthSnapshot() {
    return {
      partialInFlight: this.panelRenderInFlight ? 1 : 0,
      partialPending: this.pendingPanelModel !== undefined ? 1 : 0,
      fullRenderInFlight: this.fullRenderInFlight ? 1 : 0,
    }
  }

  private emitQueueDepth(reason: string) {
    logTestEvent('bridge', { queue: this.queueDepthSnapshot(), reason })
  }

  async render(model: ScreenModel) {
    const generation = ++this.pageGeneration
    const sequence = ++this.renderSequence
    // A full page rebuild invalidates every pending partial update. Clear the
    // queued panel model and cancel the idle timer so that enqueued scroll
    // updates or topic-preview renders from a previous page layout cannot
    // target containers that no longer exist.
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = undefined
    }
    this.pendingPanelModel = undefined
    this.panelRenderQueuedAfter = false
    // Do NOT reset panelRenderInFlight here — an in-flight partial update that
    // started before the full render will be rejected by the generation check
    // inside renderSidebarPanel when it resolves, and we want it to finish
    // naturally rather than leave the SDK in a half-updated state.
    this.fullRenderInFlight = true
    this.emitQueueDepth('full-render-start')
    try {
      if (this.hasRendered) {
        const container = buildPage(model, RebuildPageContainer)
        logTestEvent('bridge', { method: 'rebuildPageContainer', args: { sequence, generation, hasPanelBox: model.kind === 'sidebar' ? Boolean(model.panelBox) : false } })
        // Log the render event BEFORE the SDK call. The simulator's
        // `rebuildPageContainer` can hang for several seconds on some
        // screen transitions (notably the recording flow), and the
        // harness needs visibility into what was sent to the bridge
        // to validate content. On real hardware this pre-call log is
        // essentially a duplicate of the post-call one — both fire
        // within microseconds. The `attempted: true` flag
        // distinguishes the pre-call log.
        logTestEvent('render', { sequence, generation, model: summarizeScreenModel(model), attempted: true })
        // Fire-and-forget the SDK call. Detaching the call from the
        // `await` chain means a hung `rebuildPageContainer` in the
        // simulator (Flutter main thread blocked) cannot prevent the
        // bridge from releasing `fullRenderInFlight` and queuing the
        // next render. The original SDK call is still tracked in the
        // simulator's HTTP server, but the JS side has moved on.
        //
        // On real hardware this is a strict improvement: the SDK call
        // completes synchronously and the unhandled promise just
        // sits in the microtask queue. The post-call bookkeeping
        // (`this.lastSidebarModel = ...` and the completion log) runs
        // immediately, and any in-flight SDK call from a previous
        // render is abandoned cleanly.
        this.sdk.rebuildPageContainer(container).then(
          () => {
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTestEvent('render', { sequence, generation, model: summarizeScreenModel(model) })
          },
          () => {
            // SDK call rejected. Mark the bridge as needing a full
            // rebuild so the next render uses
            // `createStartUpPageContainer` instead of
            // `rebuildPageContainer`.
            this.hasRendered = false
            logTestEvent('render.failed', { sequence, generation, method: 'rebuildPageContainer' })
          },
        )
      } else {
        const container = buildPage(model, CreateStartUpPageContainer)
        logTestEvent('bridge', { method: 'createStartUpPageContainer', args: { sequence, generation, hasPanelBox: model.kind === 'sidebar' ? Boolean(model.panelBox) : false } })
        logTestEvent('render', { sequence, generation, model: summarizeScreenModel(model), attempted: true })
        this.sdk.createStartUpPageContainer(container).then(
          () => {
            this.hasRendered = true
            this.lastSidebarModel = model.kind === 'sidebar' ? model : undefined
            logTestEvent('render', { sequence, generation, model: summarizeScreenModel(model) })
          },
          () => {
            logTestEvent('render.failed', { sequence, generation, method: 'createStartUpPageContainer' })
          },
        )
      }
    } finally {
      this.fullRenderInFlight = false
      this.emitQueueDepth('full-render-end')
    }
  }

  /**
   * Partial render that updates the app-owned sidebar marker and right-panel text without
   * rebuilding the page. If `hasRendered` is false or the SDK lacks
   * `textContainerUpgrade`, fall back to a full rebuild.
   *
   * When `expectedGeneration` is provided, the update is silently dropped if the
   * page has been rebuilt since the model was created. When called directly from
   * the controller (no generation passed), the call is inherently valid because the
   * controller built the model for the current page state.
   */
  async renderSidebarPanel(model: Extract<ScreenModel, { kind: 'sidebar' }>, expectedGeneration?: number) {
    if (expectedGeneration !== undefined && expectedGeneration !== this.pageGeneration) {
      this.stalePartialRenderDropped += 1
      logTestEvent('render.partial.stale', {
        expectedGeneration,
        currentGeneration: this.pageGeneration,
        reason: 'generation-mismatch',
      })
      return
    }
    if (this.fullRenderInFlight) {
      this.stalePartialRenderDropped += 1
      logTestEvent('render.partial.stale', {
        expectedGeneration: expectedGeneration ?? 'none',
        currentGeneration: this.pageGeneration,
        reason: 'full-render-in-flight',
      })
      return
    }
    const sequence = ++this.renderSequence
    if (!this.hasRendered || typeof this.sdk.textContainerUpgrade !== 'function') {
      await this.render(model)
      return
    }
    const updates = buildSidebarPanelUpdates(model, this.lastSidebarModel)
    logTestEvent('bridge', { method: 'textContainerUpgrade', args: { sequence, generation: this.pageGeneration, count: updates.length, hasPanelBox: Boolean(model.panelBox) } })
    logTestEvent('render', { sequence, generation: this.pageGeneration, partial: true, model: summarizeScreenModel(model), attempted: true })
    for (const update of updates) {
      await withTimeout(this.sdk.textContainerUpgrade(update), 1000, 'textContainerUpgrade')
    }
    this.lastSidebarModel = model
    this.partialRenderFlushed += 1
    logTestEvent('render', { sequence, generation: this.pageGeneration, partial: true, model: summarizeScreenModel(model) })
  }

  /**
   * Fire-and-forget, latest-wins partial render for chat/topic list scrolls.
   *
   * The list-scroll input handler must return to the user as fast as possible. Awaiting
   * `textContainerUpgrade` calls here would couple native render latency to the input path
   * and would queue stale panel updates behind slow ones on real G2 hardware.
   *
   * Instead, this method:
   *   1. Stores the latest model in `pendingPanelModel`, overwriting any earlier queued model.
   *   2. Schedules a microtask flush if none is pending.
   *   3. While a flush is in flight, marks `panelRenderQueuedAfter` so the next idle tick
   *      re-renders once the in-flight call resolves.
   *   4. Counts both `partialRenderDispatched` and `partialRenderDropped` so the test
   *      harness can verify coalescing.
   *
   * The returned promise resolves when the queue has accepted the model, NOT when the
   * native render finishes. Callers must not `await` this for synchronous input handling.
   */
  enqueueSidebarPanel(model: Extract<ScreenModel, { kind: 'sidebar' }>): void {
    this.partialRenderDispatched += 1
    const generation = this.pageGeneration
    const previous = this.pendingPanelModel
    this.pendingPanelModel = { model, generation }
    if (previous) this.partialRenderDropped += 1
    if (this.panelRenderInFlight) {
      this.panelRenderQueuedAfter = true
      logTestEvent('render.partial.enqueue', {
        generation,
        dropped: previous ? 1 : 0,
        coalesced: previous ? 1 : 0,
        inFlight: true,
      })
      this.emitQueueDepth('enqueue')
      return
    }
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = setTimeout(() => {
        this.panelRenderTimer = undefined
        void this.flushPanelQueue()
      }, this.panelRenderIdleMs)
      const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
      maybeNodeTimeout.unref?.()
      logTestEvent('render.partial.enqueue', {
        generation,
        dropped: previous ? 1 : 0,
        coalesced: previous ? 1 : 0,
        inFlight: false,
      })
      this.emitQueueDepth('enqueue')
      return
    }
    this.panelRenderTimer = setTimeout(() => {
      this.panelRenderTimer = undefined
      void this.flushPanelQueue()
    }, this.panelRenderIdleMs)
    const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
    logTestEvent('render.partial.enqueue', {
      generation,
      dropped: previous ? 1 : 0,
      coalesced: previous ? 1 : 0,
      inFlight: false,
    })
    this.emitQueueDepth('enqueue')
  }

  /**
   * Drain the latest queued panel model through the partial-render path. If a newer model
   * arrives while we are rendering, the trailing flag is set so the queue re-renders once.
   */
  async flushPanelQueue(): Promise<void> {
    if (this.panelRenderInFlight) return
    const entry = this.pendingPanelModel
    if (!entry) return
    this.pendingPanelModel = undefined
    this.panelRenderInFlight = true
    this.panelRenderQueuedAfter = false
    this.emitQueueDepth('flush-start')
    const startedAt = Date.now()
    try {
      await this.renderSidebarPanel(entry.model, entry.generation)
    } catch {
      // Rendering failures must not stall the queue.
    } finally {
      const durationMs = Date.now() - startedAt
      logTestEvent('render.partial.flush', { generation: entry.generation, durationMs })
      this.panelRenderInFlight = false
      this.emitQueueDepth('flush-end')
      if (this.pendingPanelModel) {
        this.panelRenderQueuedAfter = false
        this.panelRenderTimer = setTimeout(() => {
          this.panelRenderTimer = undefined
          void this.flushPanelQueue()
        }, this.panelRenderIdleMs)
        const maybeNodeTimeout = this.panelRenderTimer as unknown as { unref?: () => void }
        maybeNodeTimeout.unref?.()
      } else if (this.panelRenderQueuedAfter) {
        this.panelRenderQueuedAfter = false
      }
    }
  }

  dispose() {
    if (this.listenerToken && activeEventListenerToken === this.listenerToken) {
      activeEventListenerToken = undefined
    }
    if (this.panelRenderTimer) {
      clearTimeout(this.panelRenderTimer)
      this.panelRenderTimer = undefined
    }
    this.pendingPanelModel = undefined
    this.lastSidebarModel = undefined
    this.panelRenderInFlight = false
    this.panelRenderQueuedAfter = false
    this.fullRenderInFlight = false
    this.pageGeneration = 0
    this.stalePartialRenderDropped = 0
    this.unsubscribeEvents?.()
    this.unsubscribeEvents = undefined
  }
  /** Test/debug introspection: returns counters of queued partial render activity. */
  getPartialRenderStats() {
    return {
      dispatched: this.partialRenderDispatched,
      dropped: this.partialRenderDropped,
      flushed: this.partialRenderFlushed,
      staleDropped: this.stalePartialRenderDropped,
    }
  }
  async setAudioEnabled(enabled: boolean) {
    logTestEvent('bridge', { method: 'setAudioEnabled', args: { enabled } })
    // In fixture mode the audio pipeline is fully simulated: the test
    // injects PCM via `injectAudioChunks` and supplies a transcript via
    // `setNextTranscript`. Calling the native `audioControl` is wasted
    // work that also keeps the simulator's Flutter main thread busy
    // — the simulator's microphone handler can take several seconds
    // to complete and the HTTP server is blocked while it runs. Skip
    // the native call entirely in fixture mode; the harness can
    // verify the recording flow via the test event stream and the
    // render model, neither of which need the audio control to run.
    if (isFixtureMode()) return
    // Race the audio control call against a 1s timeout. The simulator's
    // audioControl implementation can hang indefinitely, blocking the
    // simulator's HTTP server from responding to subsequent /api/input
    // requests. On real hardware audio control is fast (<50ms), so this
    // timeout only fires on the simulator.
    await withTimeout(this.sdk.audioControl(enabled), 1000, 'audioControl')
  }

  async showExitConfirmation() {
    if (typeof this.sdk.shutDownPageContainer === 'function') {
      await this.sdk.shutDownPageContainer(1)
      return
    }
    await this.sdk.callEvenApp?.('shutDownPageContainer', { exitMode: 1 })
  }

  async turnScreenOff() {
    try {
      if (typeof this.sdk.screenOff === 'function') {
        await this.sdk.screenOff()
        logTestEvent('bridge', { method: 'turnScreenOff', args: { via: 'screenOff' } })
        return
      }
      if (typeof this.sdk.turnScreenOff === 'function') {
        await this.sdk.turnScreenOff()
        logTestEvent('bridge', { method: 'turnScreenOff', args: { via: 'turnScreenOff' } })
        return
      }
      await this.sdk.callEvenApp?.('screenOff', {})
      logTestEvent('bridge', { method: 'turnScreenOff', args: { via: 'callEvenApp' } })
    } catch {
      logTestEvent('bridge', { method: 'turnScreenOff', args: { error: 'not supported' } })
    }
  }

  async getLocalStorage(key: string) {
    return this.sdk.getLocalStorage?.(key) ?? ''
  }

  async setLocalStorage(key: string, value: string) {
    return this.sdk.setLocalStorage?.(key, value) ?? false
  }
}

type PageContainerClass = typeof CreateStartUpPageContainer | typeof RebuildPageContainer


function buildPage(model: ScreenModel, Container: PageContainerClass) {
  if (model.kind === 'sidebar') return buildSidebarPage(model, Container)
  if (model.kind === 'list') return buildListPage(model, Container)
  return buildTextPage(model, Container)
}

function buildSidebarPage(model: Extract<ScreenModel, { kind: 'sidebar' }>, Container: PageContainerClass) {
  const fullWidth = model.fullWidth === true

  const outerBorder = new TextContainerProperty({
    containerID: 0,
    containerName: 'outer',
    content: '',
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 2,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
  })
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 100),
    xPosition: 2,
    yPosition: 2,
    width: 572,
    height: 36,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const overlay = new TextContainerProperty({
    containerID: 2,
    containerName: 'event-overlay',
    content: '',
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 1,
  })
  const sidebarSeparator = new TextContainerProperty({
    containerID: 3,
    containerName: 'separator',
    content: '',
    xPosition: fullWidth ? 0 : 168,
    yPosition: fullWidth ? 287 : 38,
    width: fullWidth ? 1 : 2,
    height: fullWidth ? 1 : 206,
    borderWidth: fullWidth ? 0 : 1,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
  })
  const panelBody = new TextContainerProperty({
    containerID: 6,
    content: trimForContainer(fillToContainer(model.panelBody || ' '), 999),
    xPosition: fullWidth ? 2 : 170,
    yPosition: 38,
    width: fullWidth ? 572 : 404,
    height: 206,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const panelBox = model.panelBox
    ? new TextContainerProperty({
        containerID: 7,
        containerName: 'panel-box',
        content: trimForContainer(formatBoxContent(model.panelBox), 999),
        xPosition: fullWidth ? 14 : 184,
        yPosition: 54,
        width: fullWidth ? 548 : 376,
        height: 190,
        borderWidth: 1,
        borderColor: 8,
        paddingLength: 8,
        isEventCapture: 0,
      })
    : new TextContainerProperty({
        containerID: 7,
        containerName: 'panel-box',
        content: '',
        xPosition: 0,
        yPosition: 287,
        width: 1,
        height: 1,
        borderWidth: 0,
        borderColor: 8,
        paddingLength: 0,
        isEventCapture: 0,
      })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.panelFooter, 120),
    xPosition: 2,
    yPosition: 248,
    width: 572,
    height: 38,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const sidebar = new TextContainerProperty({
    containerID: 5,
    containerName: 'sidebar',
    content: fullWidth ? '' : trimForContainer(formatSidebarAsText(model), 999),
    xPosition: fullWidth ? 0 : 2,
    yPosition: fullWidth ? 287 : 38,
    width: fullWidth ? 1 : 166,
    height: fullWidth ? 1 : 206,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  // The SDK native list moves its highlight without reporting each movement to
  // the app, so it cannot keep the right-side preview in sync. Use one event
  // overlay plus an app-rendered sidebar marker instead.
  const list = hiddenListContainer()
  const textObjects = [outerBorder, title, overlay, sidebarSeparator, sidebar, panelBody, panelBox, footer]
  return new Container({
    containerTotalNum: textObjects.length + 1,
    textObject: textObjects,
    listObject: [list],
  })
}

/**
 * Build the right-panel `TextContainerUpgrade` payloads that the partial-render path
 * sends to the glasses. We mirror the trim rules used by `buildSidebarPage` so the
 * partial update looks identical to a full rebuild. The hidden native list stays
 * untouched while the app-rendered sidebar marker and right panel are updated.
 */
function buildSidebarPanelUpdates(
  model: Extract<ScreenModel, { kind: 'sidebar' }>,
  previous?: Extract<ScreenModel, { kind: 'sidebar' }>,
): TextContainerUpgrade[] {
  const updates: TextContainerUpgrade[] = []
  const title = trimForContainer(model.title, 100)
  if (!previous || title !== trimForContainer(previous.title, 100)) updates.push(new TextContainerUpgrade({
    containerID: 1,
    containerName: 'title',
    content: title,
    contentOffset: 0,
    contentLength: title.length,
  }))
  const sidebar = model.fullWidth ? '' : trimForContainer(formatSidebarAsText(model), 999)
  const previousSidebar = previous?.fullWidth ? '' : previous ? trimForContainer(formatSidebarAsText(previous), 999) : undefined
  if (sidebar !== previousSidebar) updates.push(new TextContainerUpgrade({
    containerID: 5,
    containerName: 'sidebar',
    content: sidebar,
    contentOffset: 0,
    contentLength: sidebar.length,
  }))
  const panelBody = trimForContainer(fillToContainer(model.panelBody || ' '), 999)
  const previousPanelBody = previous ? trimForContainer(fillToContainer(previous.panelBody || ' '), 999) : undefined
  if (panelBody !== previousPanelBody) updates.push(new TextContainerUpgrade({
    containerID: 6,
    containerName: 'panel-body',
    content: panelBody,
    contentOffset: 0,
    contentLength: panelBody.length,
  }))
  const boxContent = model.panelBox
    ? trimForContainer(formatBoxContent(model.panelBox), 999)
    : ''
  const previousBoxContent = previous?.panelBox
    ? trimForContainer(formatBoxContent(previous.panelBox), 999)
    : ''
  if (boxContent !== previousBoxContent) updates.push(new TextContainerUpgrade({
    containerID: 7,
    containerName: 'panel-box',
    content: boxContent,
    contentOffset: 0,
    contentLength: boxContent.length,
  }))
  const footer = trimForContainer(model.panelFooter, 120)
  const previousFooter = previous ? trimForContainer(previous.panelFooter, 120) : undefined
  if (footer !== previousFooter) updates.push(new TextContainerUpgrade({
    containerID: 4,
    containerName: 'footer',
    content: footer,
    contentOffset: 0,
    contentLength: footer.length,
  }))
  return updates
}
function buildTextPage(model: Extract<ScreenModel, { kind: 'text' }>, Container: PageContainerClass) {
  if (model.box && model.footer) return buildBoxedTextPage(model, model.box, Container)

  const hasFooter = Boolean(model.footer)
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 120),
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 42,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const body = new TextContainerProperty({
    containerID: 2,
    containerName: 'body',
    content: trimForContainer(model.body, 999),
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: hasFooter ? 190 : 246,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 1,
  })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.footer ?? '', 180),
    xPosition: 0,
    yPosition: 246,
    width: 576,
    height: 42,
    borderWidth: hasFooter ? 1 : 0,
    borderColor: 8,
    paddingLength: hasFooter ? 4 : 0,
    isEventCapture: 0,
  })
  const list = hiddenListContainer()
  return new Container({
    containerTotalNum: 4,
    textObject: [title, body, footer],
    listObject: [list],
  })
}

function buildBoxedTextPage(model: Extract<ScreenModel, { kind: 'text' }>, boxedBody: BoxedBody, Container: PageContainerClass) {
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 120),
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 42,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const overlay = new TextContainerProperty({
    containerID: 2,
    containerName: 'body-events',
    content: '',
    xPosition: 0,
    yPosition: 42,
    width: 576,
    height: 204,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 1,
  })
  const box = new TextContainerProperty({
    containerID: 5,
    containerName: 'msg-box',
    content: trimForContainer(formatBoxContent(boxedBody), 999),
    xPosition: 14,
    yPosition: 58,
    width: 548,
    height: 172,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 8,
    isEventCapture: 0,
  })
  const footer = new TextContainerProperty({
    containerID: 4,
    containerName: 'footer',
    content: trimForContainer(model.footer ?? '', 180),
    xPosition: 0,
    yPosition: 246,
    width: 576,
    height: 42,
    borderWidth: 1,
    borderColor: 8,
    paddingLength: 4,
    isEventCapture: 0,
  })
  const list = hiddenListContainer()
  return new Container({
    containerTotalNum: 5,
    textObject: [title, overlay, box, footer],
    listObject: [list],
  })
}

type BoxedBody = NonNullable<Extract<ScreenModel, { kind: 'text' }>['box']>

function buildListPage(model: Extract<ScreenModel, { kind: 'list' }>, Container: PageContainerClass) {
  const title = new TextContainerProperty({
    containerID: 1,
    containerName: 'title',
    content: trimForContainer(model.title, 100),
    xPosition: 0,
    yPosition: 10,
    width: 576,
    height: 36,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    isEventCapture: 0,
  })

  // Center horizontally: (576 - 400) / 2 = 88
  const list = new ListContainerProperty({
    containerID: 2,
    containerName: 'list',
    xPosition: 88,
    yPosition: 60,
    width: 400,
    height: 228,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: model.items.length || 1,
      itemWidth: 400,
      itemName: model.items.length ? model.items : ['Empty'],
      isItemSelectBorderEn: 1,
    }),
    isEventCapture: 1,
  })

  return new Container({
    containerTotalNum: 2,
    textObject: [title],
    listObject: [list],
  })
}

function hiddenListContainer() {
  return new ListContainerProperty({
    containerID: 8,
    containerName: 'list',
    xPosition: 0,
    yPosition: 287,
    width: 1,
    height: 1,
    borderWidth: 0,
    borderColor: 8,
    paddingLength: 0,
    itemContainer: new ListItemContainerProperty({
      itemCount: 1,
      itemWidth: 1,
      itemName: [''],
      isItemSelectBorderEn: 0,
    }),
    isEventCapture: 0,
  })
}


function trimForContainer(value: string, maxLength: number) {
  if (encoder.encode(value).byteLength <= maxLength) return value

  const suffix = '...'
  const contentLimit = Math.max(0, maxLength - encoder.encode(suffix).byteLength)
  let output = ''
  for (const char of value) {
    const candidate = output + char
    if (encoder.encode(candidate).byteLength > contentLimit) break
    output = candidate
  }
  return `${output}${suffix}`
}

function formatBoxContent(boxedBody: BoxedBody) {
  return boxedBody.content ? `${boxedBody.heading}\n\n${boxedBody.content}` : boxedBody.heading
}


function formatSidebarAsText(model: Extract<ScreenModel, { kind: 'sidebar' }>) {
  const items = model.sidebarItems.length > 0 ? model.sidebarItems : ['']
  const visible = visibleListWindow(items, model.sidebarSelected, 7)
  return [
    model.sidebarTitle,
    ...visible.map((item, index) => {
      const itemIndex = visible.start + index
      return `${itemIndex === model.sidebarSelected ? '> ' : '  '}${trimForContainer(item, 22)}`
    }),
  ].join('\n')
}

function visibleListWindow(items: string[], selectedIndex: number, maxVisible: number) {
  const clamped = Math.max(0, Math.min(selectedIndex, items.length - 1))
  const half = Math.floor(maxVisible / 2)
  const start = Math.max(0, Math.min(clamped - half, Math.max(0, items.length - maxVisible)))
  return Object.assign(items.slice(start, start + maxVisible), { start })
}



const CONTAINER_FILL_BYTES = 990

function fillToContainer(content: string) {
  const currentBytes = encoder.encode(content).byteLength
  if (currentBytes >= CONTAINER_FILL_BYTES) return content
  const padBytes = CONTAINER_FILL_BYTES - currentBytes
  return content + ' '.repeat(padBytes)
}

/**
 * Race a SDK call against a timeout. The EvenHub glasses simulator's
 * `rebuildPageContainer` and `textContainerUpgrade` calls can hang
 * indefinitely on some screen transitions (notably the recording flow).
 * On real hardware a firmware bug could do the same. Without a timeout, the
 * `fullRenderInFlight` / `panelRenderInFlight` flags stay true forever and
 * every subsequent render is silently dropped. A timed race lets the bridge
 * release its in-flight state and proceed; the test harness still gets the
 * pre-await `logTestEvent('render', ...)` event so it can validate the
 * content that was sent.
 *
 * The timeout value is well above normal hardware latency (real G2 calls
 * complete in 50-200ms) and well below the test step budgets (1-2s).
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => {
      logTestEvent('bridge.timeout', { method: label, timeoutMs: ms })
      resolve(undefined)
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
