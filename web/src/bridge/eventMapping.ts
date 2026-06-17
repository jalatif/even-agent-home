import { evenHubEventFromJson } from '@evenrealities/even_hub_sdk'
import type { AppInput } from '../controller/model'

export const EvenEventType = {
  click: 0,
  scrollTop: 1,
  scrollBottom: 2,
  doubleClick: 3,
  foregroundEnter: 4,
} as const

const EvenEventTypeName = {
  click: 'CLICK_EVENT',
  scrollTop: 'SCROLL_TOP_EVENT',
  scrollBottom: 'SCROLL_BOTTOM_EVENT',
  doubleClick: 'DOUBLE_CLICK_EVENT',
  foregroundEnter: 'FOREGROUND_ENTER_EVENT',
} as const

type EvenHubEventLike = {
  type?: string
  data?: unknown
  jsonData?: Record<string, unknown>
  textEvent?: EventRecord
  listEvent?: EventRecord
  audioEvent?: { audioPcm?: Uint8Array | ArrayBuffer | number[] }
  sysEvent?: EventRecord
}

type EventRecord = Record<string, unknown>

export function createInputCoalescer(
  onInput: (input: AppInput) => void | Promise<void>,
  duplicateTapDebounceMs = 90,
  tapCooldownMs = 30,
  duplicateSwipeDebounceMs = 30,
) {
  let lastTapTime = 0
  let lastTapKind: 'press' | 'doublePress' | undefined
  let lastSwipeTime = 0
  let lastSwipeKind: 'swipeUp' | 'swipeDown' | undefined

  function emit(input: AppInput) {
    void onInput(input)
  }

  return (input: AppInput) => {
    if (input.type === 'doublePress') {
      const now = Date.now()
      const elapsed = now - lastTapTime

      if (lastTapKind === 'doublePress' && elapsed < 140) return

      lastTapTime = now
      lastTapKind = 'doublePress'
      emit(input)
      return
    }

    if (input.type === 'press') {
      const now = Date.now()
      const elapsed = now - lastTapTime

      if (lastTapKind === 'press' && elapsed < duplicateTapDebounceMs) return
      if (lastTapKind === 'doublePress' && elapsed < tapCooldownMs) return

      lastTapTime = now
      lastTapKind = 'press'
      emit(input)
      return
    }

    if (input.type === 'swipeUp' || input.type === 'swipeDown') {
      const now = Date.now()
      const elapsed = now - lastSwipeTime

      if (lastSwipeKind === input.type && elapsed < duplicateSwipeDebounceMs) return

      lastSwipeTime = now
      lastSwipeKind = input.type
      emit(input)
      return
    }

    emit(input)
  }
}

/**
 * Bound hardware input bursts released together after an SDK/native stall. At most one
 * gesture is dispatched per short window, and the latest gesture replaces earlier pending
 * input instead of replaying a backlog across later screens. Audio chunks bypass this gate
 * because dropping PCM would corrupt recordings.
 */
export function createBoundedInputDispatcher(
  onInput: (input: AppInput) => void | Promise<void>,
  dispatchWindowMs = 20,
) {
  let pending: AppInput | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  return (input: AppInput) => {
    if (input.type === 'audioChunk') {
      void onInput(input)
      return
    }
    pending = input
    if (timer) return
    timer = setTimeout(() => {
      timer = undefined
      const next = pending
      pending = undefined
      if (next) void onInput(next)
    }, dispatchWindowMs)
    const maybeNodeTimeout = timer as unknown as { unref?: () => void }
    maybeNodeTimeout.unref?.()
  }
}

export function mapEvenHubEvent(event: EvenHubEventLike | unknown): AppInput | undefined {
  const rawEventType = readRawEventType(event)
  const rawRecord = readRawRecord(event)
  const rawIndex = readSelectedIndex(rawRecord)
  const rawItemName = readSelectedName(rawRecord)
  const rawEventSource = readEventSource(event)
  if (eventTypeEquals(rawEventType, EvenEventType.foregroundEnter, EvenEventTypeName.foregroundEnter)) {
    return withEventSource({ type: 'foreground' }, rawEventSource)
  }
  if (eventTypeEquals(rawEventType, EvenEventType.doubleClick, EvenEventTypeName.doubleClick)) return withEventSource(withOptionalSelection('doublePress', rawIndex, rawItemName), rawEventSource)
  if (eventTypeEquals(rawEventType, EvenEventType.click, EvenEventTypeName.click)) return withEventSource(withOptionalSelection('press', rawIndex, rawItemName), rawEventSource)
  if (eventTypeEquals(rawEventType, EvenEventType.scrollTop, EvenEventTypeName.scrollTop)) return withEventSource({ type: 'swipeUp' }, rawEventSource)
  if (eventTypeEquals(rawEventType, EvenEventType.scrollBottom, EvenEventTypeName.scrollBottom)) return withEventSource({ type: 'swipeDown' }, rawEventSource)

  const normalized = normalizeEvent(event)

  if (normalized.audioEvent?.audioPcm) {
    return { type: 'audioChunk', pcm: toUint8Array(normalized.audioEvent.audioPcm) }
  }

  const normalizedEventSource = rawEventSource ?? readEventSource(normalized)

  if (eventTypeEquals(readEventType(normalized.sysEvent), EvenEventType.foregroundEnter, EvenEventTypeName.foregroundEnter)) {
    return withEventSource({ type: 'foreground' }, normalizedEventSource)
  }

  const listEvent = normalized.listEvent
  const eventRecord = listEvent ?? normalized.textEvent ?? normalized.sysEvent
  const eventType = readEventType(eventRecord) ?? rawEventType
  const index = readSelectedIndex(listEvent)
  const itemName = readSelectedName(listEvent)
  if ((index !== undefined || itemName !== undefined) && eventType === undefined) {
    return withEventSource(withOptionalSelection('selectIndex', index, itemName), normalizedEventSource)
  }

  if (eventTypeEquals(eventType, EvenEventType.doubleClick, EvenEventTypeName.doubleClick)) return withEventSource(withOptionalSelection('doublePress', index, itemName), normalizedEventSource)
  if (eventType === undefined || eventTypeEquals(eventType, EvenEventType.click, EvenEventTypeName.click)) return withEventSource(withOptionalSelection('press', index, itemName), normalizedEventSource)
  if (eventTypeEquals(eventType, EvenEventType.scrollTop, EvenEventTypeName.scrollTop)) return withEventSource({ type: 'swipeUp' }, normalizedEventSource)
  if (eventTypeEquals(eventType, EvenEventType.scrollBottom, EvenEventTypeName.scrollBottom)) return withEventSource({ type: 'swipeDown' }, normalizedEventSource)
  return undefined
}

function readEventSource(event: EvenHubEventLike | unknown): number | undefined {
  if (!isRecord(event)) return undefined
  const candidate = event as EvenHubEventLike
  const fromNested = (record: EventRecord | undefined): number | undefined => {
    if (!record) return undefined
    const value = pickValue(record, ['eventSource', 'sourceType', 'source'])
    if (typeof value === 'number' && Number.isInteger(value)) return value
    if (typeof value === 'string' && /^-?\d+$/.test(value)) {
      const parsed = Number.parseInt(value, 10)
      return Number.isInteger(parsed) ? parsed : undefined
    }
    return undefined
  }
  return (
    fromNested(candidate.listEvent) ??
    fromNested(candidate.textEvent) ??
    fromNested(candidate.sysEvent) ??
    fromNested(firstRecord(candidate.jsonData, candidate.data)) ??
    fromNested(candidate)
  )
}

function withEventSource<T extends AppInput>(input: T, eventSource: number | undefined): T {
  if (eventSource === undefined) return input
  return { ...input, eventSource }
}

function readRawEventType(event: EvenHubEventLike | unknown): number | string | undefined {
  if (!isRecord(event)) return undefined
  const candidate = event as EvenHubEventLike
  return (
    readEventType(candidate.listEvent) ??
    readEventType(candidate.textEvent) ??
    readEventType(candidate.sysEvent) ??
    readEventType(firstRecord(candidate.jsonData, candidate.data, candidate))
  )
}

function readRawRecord(event: EvenHubEventLike | unknown): EventRecord | undefined {
  if (!isRecord(event)) return undefined
  const candidate = event as EvenHubEventLike
  return candidate.listEvent
    ?? candidate.textEvent
    ?? candidate.sysEvent
    ?? firstRecord(candidate.jsonData, candidate.data, candidate)
}

function toUint8Array(value: Uint8Array | ArrayBuffer | number[]) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return Uint8Array.from(value)
}

function normalizeEvent(event: EvenHubEventLike | unknown): EvenHubEventLike {
  const original = isRecord(event) ? event : {}
  const rawPayload = firstRecord(original.jsonData, original.data)
  const raw = normalizeRawEvent(original, rawPayload)
  if (raw) return raw

  try {
    const parsed = evenHubEventFromJson(original)
    if (parsed.listEvent || parsed.textEvent || parsed.sysEvent || parsed.audioEvent) {
      return {
        ...parsed,
        listEvent: parsed.listEvent ? mergeDefined(rawPayload, parsed.listEvent as unknown as EventRecord) : undefined,
        textEvent: parsed.textEvent ? mergeDefined(rawPayload, parsed.textEvent as unknown as EventRecord) : undefined,
        sysEvent: parsed.sysEvent ? mergeDefined(rawPayload, parsed.sysEvent as unknown as EventRecord) : undefined,
      } as EvenHubEventLike
    }
  } catch {
    // Fall through to best-effort raw host payload parsing.
  }

  return original as EvenHubEventLike
}

function normalizeRawEvent(original: EventRecord, rawPayload: EventRecord): EvenHubEventLike | undefined {
  if (original.audioEvent || original.listEvent || original.textEvent || original.sysEvent) return original as EvenHubEventLike
  const eventType = typeof original.type === 'string' ? normalizeKey(original.type) : undefined
  const payload = Object.keys(rawPayload).length > 0 ? rawPayload : original
  if (eventType?.includes('LIST')) return { listEvent: payload }
  if (eventType?.includes('TEXT')) return { textEvent: payload }
  if (eventType?.includes('SYS') || eventType?.includes('SYSTEM')) return { sysEvent: payload }
  if (eventType?.includes('AUDIO')) {
    const audioPcm = pickValue(payload, ['audioPcm', 'AudioPcm', 'audio_pcm', 'audioPCM'])
    return { audioEvent: { audioPcm: audioPcm as Uint8Array | ArrayBuffer | number[] } }
  }
  return undefined
}

function readEventType(record: EventRecord | undefined): number | string | undefined {
  const value = pickValue(record, ['eventType', 'Event_Type', 'event_type', 'event', 'Event', 'action', 'Action'])
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

function readSelectedIndex(record: EventRecord | undefined): number | undefined {
  const value = pickValue(record, [
    'currentSelectItemIndex',
    'CurrentSelect_ItemIndex',
    'current_select_item_index',
    'currentSelectIndex',
    'selectedIndex',
    'selectIndex',
    'index',
  ])
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readSelectedName(record: EventRecord | undefined): string | undefined {
  const value = pickValue(record, [
    'currentSelectItemName',
    'CurrentSelect_ItemName',
    'current_select_item_name',
    'selectedItemName',
    'itemName',
    'name',
  ])
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function eventTypeEquals(value: number | string | undefined, numeric: number, name: string) {
  if (value === numeric) return true
  if (typeof value === 'string') {
    const numericValue = Number(value)
    if (Number.isFinite(numericValue) && numericValue === numeric) return true
    const normalizedValue = normalizeKey(value)
    const normalizedName = normalizeKey(name)
    if (normalizedValue === normalizedName || normalizedValue === normalizedName.replace(/_EVENT$/, '')) return true
    return eventTypeAliases(numeric).includes(normalizedValue)
  }
  return false
}

function withOptionalSelection(type: 'press' | 'doublePress' | 'selectIndex', index: number | undefined, itemName: string | undefined): AppInput {
  return {
    type,
    ...(index === undefined ? {} : { index }),
    ...(itemName === undefined ? {} : { itemName }),
  } as AppInput
}

function eventTypeAliases(numeric: number) {
  switch (numeric) {
    case EvenEventType.click:
      return ['CLICK', 'SINGLE_CLICK', 'PRESS', 'SINGLE_PRESS', 'TAP', 'SINGLE_TAP', 'TOUCH']
    case EvenEventType.doubleClick:
      return ['DOUBLE_CLICK', 'DOUBLE_PRESS', 'DOUBLE_TAP']
    case EvenEventType.scrollTop:
      return ['SCROLL_TOP', 'SCROLL_UP', 'SWIPE_UP', 'UP']
    case EvenEventType.scrollBottom:
      return ['SCROLL_BOTTOM', 'SCROLL_DOWN', 'SWIPE_DOWN', 'DOWN']
    case EvenEventType.foregroundEnter:
      return ['FOREGROUND_ENTER', 'FOREGROUND']
    default:
      return []
  }
}

function normalizeKey(value: string) {
  return value
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
}

function pickValue(record: EventRecord | undefined, keys: string[]) {
  if (!record) return undefined
  for (const key of keys) {
    if (key in record) return record[key]
    const normalizedKey = normalizeKey(key)
    const matchedKey = Object.keys(record).find((candidate) => normalizeKey(candidate) === normalizedKey)
    if (matchedKey) return record[matchedKey]
  }
  return undefined
}

function firstRecord(...values: unknown[]): EventRecord {
  for (const value of values) {
    if (isRecord(value)) return value
  }
  return {}
}

function mergeDefined(base: EventRecord, overlay: EventRecord): EventRecord {
  const output: EventRecord = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value !== undefined) output[key] = value
  }
  return output
}

function isRecord(value: unknown): value is EventRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
