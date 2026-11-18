import {
  CreateStartUpPageContainer,
  OsEventTypeList,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import { enqueue, getBridge } from './bridge'
import { store, type FeedItem } from './store'

/**
 * Glasses display.
 *
 *  - A small connection dot in the top-right corner: ● live, ○ not live.
 *  - Messages stacked from the bottom up, newest at the bottom, each as
 *        server :: channel :: user
 *        message
 *  - Each message is its own text container so it can fade out on its own
 *    (text brightness is per container) after the configured timeout.
 *  - An invisible full-screen container captures input.
 *
 * Input: swipe up = older, swipe down = newer (history ignores fading),
 *        tap = back to live, double tap = channel menu (filter / all / exit).
 *
 * Container budget: 8 text containers max = input layer + dot + 6 messages.
 */

const SCREEN_W = 576
const SCREEN_H = 288
const LINE_H = 27
const MSG_W = 544 // leave the top-right corner for the dot
const MSG_PAD_Y = 2 // extra px per container so a rounding error never triggers firmware scroll
const GAP = 4
const MAX_SLOTS = 6
const MAX_LINES_PER_MSG = 5 // header line + up to 4 lines of message

const INPUT = { id: 1, name: 'input' }
const DOT = { id: 2, name: 'dot', x: 548, y: 0, w: 28, h: 30 }
/** Channel name shown left of the dot while a filter is active. */
const LABEL = { id: 3, name: 'label', maxW: 260 }
/** Rows the channel menu shows at once. */
const MENU_ROWS = 10
const SLOT_BASE_ID = 10

/** How long the fade itself takes once a message's timeout is reached. */
const FADE_MS = 3000
/** Brightness steps during the fade (firmware range 0..4). */
const FADE_LEVELS = [3, 2, 1, 0]
const BRIGHT = 4

export type ConnState = 'signed-out' | 'connecting' | 'live' | 'reconnecting' | 'error' | 'paused'

let conn: ConnState = 'signed-out'
/** History mode (entered by swiping up): shows past messages without fading. */
let history = false
/** In history mode, how many messages back from the newest the bottom of the view sits. */
let offset = 0
let started = false
/** Glasses off / disconnected: skip all Bluetooth rendering. */
let suspended = false
let renderTimer: ReturnType<typeof setTimeout> | undefined
let fadeTimer: ReturnType<typeof setTimeout> | undefined
let onForeground: () => void = () => {}

// Channel filter (double-tap menu).
type Mode = 'feed' | 'menu'
let mode: Mode = 'feed'
let filterKey: string | null = null
let filterLabel = ''
let menuEntries: MenuEntry[] = []
/** Paused (from the menu): messages that arrive from this moment on stay off the live view. */
let pausedAt: number | null = null
/** History returns to live after this long without input. */
const HISTORY_IDLE_MS = 30_000
let historyTimer: ReturnType<typeof setTimeout> | undefined
let menuCursor = 0
let menuTop = 0

/** Last input seen from the glasses/ring, shown in the phone's diagnostics line. */
export const inputInfo = { last: '' }
/** Drawing health, shown in the phone's diagnostics line. */
export const drawInfo = { started: false, suspended: false, rebuilds: 0, updates: 0, failed: 0 }
/** source: 1 = right arm, 2 = ring, 3 = left arm, undefined = not reported (e.g. swipes) */
const inputListeners = new Set<(source: number | undefined) => void>()
export function onGlassesInput(fn: (source: number | undefined) => void): void {
  inputListeners.add(fn)
}

// What is currently on the glasses.
interface Slot { key: string; y: number; h: number; text: string; level: number; blank: boolean }
let shown: Slot[] = []
let shownDot = ''
let shownLabel = ''

export function setConnState(s: ConnState): void {
  conn = s
  renderSoon()
}

/** Keep the view anchored on the same messages when new ones arrive while scrolled back. */
/** Stop (or restart) drawing to the glasses, e.g. while they're not being worn. */
export function setSuspended(on: boolean): void {
  if (on === suspended) return
  suspended = on
  drawInfo.suspended = on
  if (on) {
    clearTimeout(renderTimer)
    clearTimeout(fadeTimer)
  } else {
    shown = [] // the glasses may have shown something else meanwhile: full repaint
    shownDot = ''
    renderSoon(0)
  }
}

/** Keep the view anchored on the same messages when new ones arrive while scrolled back. */
export function noteNewMessage(item: FeedItem): void {
  if (history && (!filterKey || keyOf(item) === filterKey)) offset++
}

/** "server :: channel" (thread part dropped) or "DM :: user": the channel a message belongs to. */
export function channelLabel(item: FeedItem): string {
  if (item.channel) return [item.guild, item.channel.split(' > ')[0]].filter(Boolean).join(' :: ')
  if (item.where === 'DM') return `DM :: ${item.author}`
  const [guild, channel] = item.where.includes('/') ? item.where.split('/', 2) : ['', item.where]
  return [guild, channel.replace(/^#/, '').split('>')[0]].filter(Boolean).join(' :: ')
}

function keyOf(item: FeedItem): string {
  return item.chanKey ?? channelLabel(item)
}

// ---------- formatting ----------

/** "server :: channel :: user" (or "DM :: user"); handles items saved by older versions. */
export function itemHeader(item: FeedItem): string {
  if (item.channel) {
    return [item.guild, item.channel, item.author].filter(Boolean).join(' :: ')
  }
  if (item.where === 'DM') return `DM :: ${item.author}`
  const [guild, channel] = item.where.includes('/') ? item.where.split('/', 2) : ['', item.where]
  return [guild, channel.replace(/^#/, ''), item.author].filter(Boolean).join(' :: ')
}

export function formatItem(item: FeedItem): string {
  return `${itemHeader(item)}\n${item.text}`
}

const lineCache = new Map<string, number>()
function lineCount(text: string): number {
  let n = lineCache.get(text)
  if (n === undefined) {
    n = Math.max(1, measureTextWrap(text, MSG_W).lineCount)
    if (lineCache.size > 500) lineCache.clear()
    lineCache.set(text, n)
  }
  return n
}

/** Shorten text so it wraps to at most `lines` lines. */
function fitToLines(text: string, lines: number): string {
  if (lineCount(text) <= lines) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (lineCount(text.slice(0, mid) + '...') <= lines) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo).trimEnd() + '...'
}

// ---------- layout ----------

function brightnessFor(item: FeedItem, now: number): number | null {
  const fadeMs = store.config.fadeSeconds * 1000
  if (!fadeMs || history) return BRIGHT
  const into = now - item.ts - fadeMs
  if (into < 0) return BRIGHT
  if (into >= FADE_MS) return null // gone
  return FADE_LEVELS[Math.min(FADE_LEVELS.length - 1, Math.floor((into / FADE_MS) * FADE_LEVELS.length))]
}

/** Desired slots, top to bottom, bottom-anchored. */
export function computeSlots(now = Date.now()): Slot[] {
  if (mode === 'menu') return menuSlots()
  const info = infoText()
  const entries: { key: string; text: string; level: number }[] = []
  let items = filterKey ? store.feed.filter((i) => keyOf(i) === filterKey) : store.feed
  // Paused: live view keeps only what was there before the pause (history still shows everything).
  if (pausedAt !== null && !history) items = items.filter((i) => i.ts < pausedAt!)
  // The filter label takes a container and the top row.
  const maxSlots = filterKey ? MAX_SLOTS - 1 : MAX_SLOTS
  const topLimit = filterKey ? DOT.h + 2 : 0

  if (info) {
    entries.push({ key: 'info:' + info, text: info, level: BRIGHT })
  } else {
    offset = Math.max(0, Math.min(offset, items.length - 1))
    const end = items.length - 1 - (history ? offset : 0)
    for (let i = end; i >= 0 && entries.length < maxSlots; i--) {
      const item = items[i]
      const level = brightnessFor(item, now)
      if (level === null) break // older ones have faded too
      entries.push({ key: item.id, text: fitToLines(formatItem(item), MAX_LINES_PER_MSG), level })
    }
  }

  const slots: Slot[] = []
  let bottom = SCREEN_H
  for (const e of entries) {
    let text = e.text
    let h = lineCount(text) * LINE_H + MSG_PAD_Y
    if (bottom - h < topLimit) {
      // Oldest visible message only partly fits: keep its start if 2+ lines are left.
      const lines = Math.floor((bottom - topLimit - MSG_PAD_Y) / LINE_H)
      if (lines < 2) break
      text = fitToLines(text, lines)
      h = lineCount(text) * LINE_H + MSG_PAD_Y
    }
    slots.unshift({ key: e.key, y: bottom - h, h, text, level: e.level, blank: false })
    bottom -= h + GAP
  }
  return slots
}

// ---------- channel menu (double tap) ----------

type MenuEntry = { kind: 'channel'; key: string; label: string } | { kind: 'all' | 'pause' | 'exit'; label: string }

/** Channels seen in the feed, most recent last (bottom). */
function seenChannels(): MenuEntry[] {
  const seen = new Map<string, string>()
  for (let i = store.feed.length - 1; i >= 0 && seen.size < 50; i--) {
    const k = keyOf(store.feed[i])
    if (!seen.has(k)) seen.set(k, channelLabel(store.feed[i]))
  }
  return [...seen].map(([key, label]): MenuEntry => ({ kind: 'channel', key, label })).reverse()
}

/**
 * Rows: seen channels (oldest at the top, newest at the bottom), then
 * "All channels" (only while filtered), "Pause"/"Resume" and "Exit Murmur". The cursor starts on
 * the newest channel, or on "All channels" while a filter is active.
 */
function openMenu(): void {
  const channels = seenChannels()
  menuEntries = [
    ...channels,
    ...(filterKey ? [{ kind: 'all', label: 'All channels' } as MenuEntry] : []),
    { kind: 'pause', label: pausedAt ? 'Resume' : 'Pause' },
    { kind: 'exit', label: 'Exit Murmur' },
  ]
  menuCursor = filterKey ? channels.length : Math.max(0, channels.length - 1)
  // Open scrolled to the bottom; the cursor is always in the last four rows.
  menuTop = Math.max(0, menuEntries.length - MENU_ROWS)
  mode = 'menu'
  renderSoon(0)
}

function closeMenu(): void {
  mode = 'feed'
  renderSoon(0)
}

function moveCursor(delta: number): void {
  const next = Math.max(0, Math.min(menuEntries.length - 1, menuCursor + delta))
  if (next === menuCursor) return
  menuCursor = next
  if (menuCursor < menuTop) menuTop = menuCursor
  if (menuCursor > menuTop + MENU_ROWS - 1) menuTop = menuCursor - MENU_ROWS + 1
  renderSoon(0)
}

function chooseCursor(): void {
  const e = menuEntries[menuCursor]
  mode = 'feed'
  if (!e) return renderSoon(0)
  if (e.kind === 'pause') {
    pausedAt = pausedAt ? null : Date.now()
    renderSoon(0)
    return
  }
  if (e.kind === 'exit') {
    renderSoon(0)
    // System confirm dialog; cleanup happens on SYSTEM_EXIT_EVENT.
    void enqueue('shutdown', (b) => b.shutDownPageContainer(1))
    return
  }
  filterKey = e.kind === 'channel' ? e.key : null
  filterLabel = e.kind === 'channel' ? e.label : ''
  leaveHistory()
  renderSoon(0)
}

function menuSlots(): Slot[] {
  const rows = menuEntries.slice(menuTop, menuTop + MENU_ROWS).map((e, i) => {
    // Unselected rows sit flush left; the cursor row gets a solid triangle.
    // The active filter is marked with a solid triangle pointing back at it.
    const active = e.kind === 'channel' && e.key === filterKey ? '  ◀' : ''
    return fitToLines((menuTop + i === menuCursor ? '▶ ' : '') + e.label + active, 1)
  })
  const h = Math.min(MENU_ROWS, menuEntries.length) * LINE_H + MSG_PAD_Y
  // Constant key and size: moving the cursor is an in-place text update, not a rebuild.
  return [{ key: 'menu', y: SCREEN_H - h, h, text: rows.join('\n'), level: BRIGHT, blank: false }]
}

function labelText(): string {
  return mode === 'feed' && filterKey ? fitLabel(filterLabel) : ''
}

/** Truncate to fit LABEL.maxW on one line. */
function fitLabel(text: string): string {
  if (getTextWidth(text) <= LABEL.maxW) return text
  let s = text
  while (s.length > 1 && getTextWidth(s + '...') > LABEL.maxW) s = s.slice(0, -1)
  return s.trimEnd() + '...'
}

function infoText(): string {
  if (conn === 'signed-out' || conn === 'error') {
    return 'Open Murmur on your phone and sign in.\nPick servers and channels to watch there.'
  }
  if (store.config.channels.length === 0 && !store.config.watchDMs) {
    return 'Nothing watched yet.\nPick servers/channels (or DMs) in the phone app.'
  }
  return ''
}

/** ▲ in history, ■ paused, otherwise ● connected / ○ not connected. */
function dotText(): string {
  if (history && mode === 'feed') return '▲'
  if (pausedAt !== null) return '■'
  return conn === 'live' ? '●' : '○'
}

// ---------- page building ----------

function slotProps(s: Slot, i: number): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: s.y, width: MSG_W, height: s.h,
    borderWidth: 0, borderColor: 0, paddingLength: 0,
    containerID: SLOT_BASE_ID + i, containerName: `m${i}`,
    content: s.blank ? ' ' : s.text.slice(0, 950), textColor: s.level,
    isEventCapture: 0, zOrderIndex: 2 + i,
  })
}

function pageContainers(slots: Slot[], dot: string, label: string): TextContainerProperty[] {
  const labelW = label ? Math.min(LABEL.maxW, getTextWidth(label)) + 12 : 0
  return [
    ...(label
      ? [new TextContainerProperty({
          xPosition: DOT.x - labelW, yPosition: 0, width: labelW, height: DOT.h,
          borderWidth: 0, borderColor: 0, paddingLength: 0,
          containerID: LABEL.id, containerName: LABEL.name,
          content: label, textColor: 2, isEventCapture: 0, zOrderIndex: 19,
        })]
      : []),
    new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: SCREEN_W, height: SCREEN_H,
      borderWidth: 0, borderColor: 0, paddingLength: 0,
      containerID: INPUT.id, containerName: INPUT.name,
      content: ' ', isEventCapture: 1, zOrderIndex: 1,
    }),
    ...slots.map(slotProps),
    new TextContainerProperty({
      xPosition: DOT.x, yPosition: DOT.y, width: DOT.w, height: DOT.h,
      borderWidth: 0, borderColor: 0, paddingLength: 0,
      containerID: DOT.id, containerName: DOT.name,
      content: dot, isEventCapture: 0, zOrderIndex: 20,
    }),
  ]
}

export async function startGlasses(opts: { onForeground: () => void }): Promise<boolean> {
  const bridge = getBridge()
  if (!bridge) return false
  onForeground = opts.onForeground

  const slots = computeSlots()
  const dot = dotText()
  const label = labelText()
  const textObject = pageContainers(slots, dot, label)
  const result = await enqueue('createStartUpPage', (b) =>
    b.createStartUpPageContainer(new CreateStartUpPageContainer({ containerTotalNum: textObject.length, textObject })),
  )
  started = result === 0
  drawInfo.started = started
  console.log('[glasses] startup page', started ? 'created' : `failed (${result})`)
  if (started) {
    shown = slots
    shownDot = dot
    shownLabel = label
  }

  bridge.onEvenHubEvent(handleEvent)
  store.subscribe(() => renderSoon())
  scheduleFadeTick()
  return started
}

const SOURCES = ['', 'right arm', 'ring', 'left arm']
const EVENT_NAMES: Record<number, string> = { 0: 'tap', 1: 'swipe up', 2: 'swipe down', 3: 'double tap', 9: 'long press', 10: 'long press release' }

function handleEvent(event: EvenHubEvent): void {
  routeEvent(event)
  if (event.textEvent || event.sysEvent) inputListeners.forEach((fn) => fn(event.sysEvent?.eventSource))
}

function routeEvent(event: EvenHubEvent): void {
  if (event.textEvent) {
    const t = event.textEvent.eventType ?? 0
    inputInfo.last = EVENT_NAMES[t] ?? `event ${t}`
    if (mode === 'menu') {
      if (t === OsEventTypeList.SCROLL_TOP_EVENT) moveCursor(-1)
      else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) moveCursor(1)
      return
    }
    if (t === OsEventTypeList.SCROLL_TOP_EVENT) scrollBy(1)
    else if (t === OsEventTypeList.SCROLL_BOTTOM_EVENT) scrollBy(-1)
    return
  }
  if (event.sysEvent) {
    const t = event.sysEvent.eventType ?? 0
    if (EVENT_NAMES[t]) inputInfo.last = `${EVENT_NAMES[t]} (${SOURCES[event.sysEvent.eventSource ?? 0] || 'unknown source'})`
    if (mode === 'menu') {
      if (t === OsEventTypeList.CLICK_EVENT) return chooseCursor()
      if (t === OsEventTypeList.DOUBLE_CLICK_EVENT) return closeMenu()
    }
    switch (t) {
      case OsEventTypeList.CLICK_EVENT:
        if (history) {
          leaveHistory()
          renderSoon(0)
        }
        break
      case OsEventTypeList.DOUBLE_CLICK_EVENT:
        openMenu() // channel filter + exit; long press belongs to the system
        break
      case OsEventTypeList.FOREGROUND_ENTER_EVENT:
        shown = [] // force a full rebuild
        shownDot = ''
        renderSoon(0)
        onForeground()
        break
      case OsEventTypeList.FOREGROUND_EXIT_EVENT:
      case OsEventTypeList.ABNORMAL_EXIT_EVENT:
      case OsEventTypeList.SYSTEM_EXIT_EVENT:
        void store.flushFeed()
        break
    }
  }
}

function scrollBy(delta: number): void {
  const count = filterKey ? store.feed.filter((i) => keyOf(i) === filterKey).length : store.feed.length
  if (!count) return
  if (delta > 0 && !history) {
    // First swipe up: show recent messages again (unfaded), newest at the bottom.
    history = true
    offset = 0
  } else if (delta < 0 && history && offset === 0) {
    leaveHistory() // swiped back down past the newest: live again
    return renderSoon(0)
  } else if (history) {
    offset = Math.min(count - 1, Math.max(0, offset + delta))
  } else {
    return
  }
  armHistoryTimer()
  renderSoon(0)
}

function leaveHistory(): void {
  history = false
  offset = 0
  clearTimeout(historyTimer)
}

/** Back to live after HISTORY_IDLE_MS without a swipe. */
function armHistoryTimer(): void {
  clearTimeout(historyTimer)
  historyTimer = setTimeout(() => {
    if (!history) return
    leaveHistory()
    renderSoon(0)
  }, HISTORY_IDLE_MS)
}

export function renderSoon(delay = 150): void {
  if (!started || suspended) return
  clearTimeout(renderTimer)
  renderTimer = setTimeout(() => void render(), delay)
}

let rendering = false
async function render(): Promise<void> {
  if (rendering) return renderSoon(100)
  rendering = true
  try {
    await renderNow()
  } finally {
    rendering = false
    scheduleFadeTick()
  }
}

/**
 * Wake up exactly when the next fade step of a visible message is due,
 * instead of polling (keeps the CPU asleep between steps).
 */
function scheduleFadeTick(): void {
  clearTimeout(fadeTimer)
  const fadeMs = store.config.fadeSeconds * 1000
  if (!fadeMs || history || suspended) return
  const now = Date.now()
  let next = Infinity
  for (const s of shown) {
    if (s.blank) continue
    const item = store.feed.find((f) => f.id === s.key)
    if (!item) continue
    const start = item.ts + fadeMs
    for (let k = 0; k <= FADE_LEVELS.length; k++) {
      const t = start + (k * FADE_MS) / FADE_LEVELS.length
      if (t > now) {
        next = Math.min(next, t)
        break
      }
    }
  }
  if (next < Infinity) fadeTimer = setTimeout(() => renderSoon(0), next - now + 20)
}

async function renderNow(): Promise<void> {
  const want = computeSlots()
  const dot = dotText()
  const label = labelText()

  // Messages that faded away leave from the top of a bottom-anchored stack, so
  // if `want` is the bottom part of what's shown we can just blank the rest
  // instead of rebuilding the page (rebuilds flicker). Containers that keep
  // their key and size get in-place text updates.
  const tail = shown.slice(shown.length - want.length)
  const sameLayout =
    shown.length > 0 &&
    want.length <= shown.length &&
    label === shownLabel &&
    want.every((s, i) => s.key === tail[i].key && s.y === tail[i].y && s.h === tail[i].h)

  if (!sameLayout) {
    const textObject = pageContainers(want, dot, label)
    const ok = await enqueue('rebuild', (b) =>
      b.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: textObject.length, textObject })),
    )
    drawInfo.rebuilds++
    if (!ok) drawInfo.failed++
    shown = want
    shownDot = dot
    shownLabel = label
    return
  }

  const firstKept = shown.length - want.length
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i]
    const target = i < firstKept ? null : want[i - firstKept]
    if (!target) {
      if (!s.blank) {
        s.blank = true
        await upgrade(SLOT_BASE_ID + i, `m${i}`, ' ', 0)
      }
    } else if (target.level !== s.level || target.text !== s.text || s.blank) {
      s.level = target.level
      s.text = target.text
      s.blank = false
      await upgrade(SLOT_BASE_ID + i, `m${i}`, s.text.slice(0, 1900), s.level)
    }
  }
  if (dot !== shownDot) {
    shownDot = dot
    await upgrade(DOT.id, DOT.name, dot)
  }
}

async function upgrade(containerID: number, containerName: string, content: string, textColor?: number) {
  const ok = await enqueue(`upgrade ${containerName}`, (b) =>
    b.textContainerUpgrade(new TextContainerUpgrade({ containerID, containerName, content, contentOffset: 0, contentLength: 0, textColor })),
  )
  drawInfo.updates++
  if (!ok) drawInfo.failed++
  return ok
}
