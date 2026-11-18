import './style.css'
import { initBridge } from './bridge'
import { isDemo, startDemo } from './demo'
import { startGlasses, renderSoon } from './glasses'
import { startPhoneUi } from './phone'
import { noteGlassesForeground, startPowerSaver } from './power'
import { session, startSession, wake } from './session'
import { store, type FeedItem } from './store'

/**
 * Murmur: sign in to Discord on the phone, pick channels to watch, and
 * read new messages as a rolling plain-text feed on the G2 glasses.
 */

registerBackgroundSnapshot()

const bridge = await initBridge()
if (!bridge) console.info('[main] No Even Hub bridge; running phone UI only (browser dev mode)')

if (isDemo()) {
  startDemo()
} else {
  await store.load()
}
startPhoneUi()
await startGlasses({
  onForeground: () => {
    noteGlassesForeground()
    wake()
  },
})
void startPowerSaver()

if (!isDemo() && store.token) void resumeSession(store.token)

/** Reconnect with the saved token; retry while Discord is unreachable. */
async function resumeSession(token: string, attempt = 0): Promise<void> {
  try {
    await startSession(token)
  } catch (err: any) {
    if (err?.status === 401) return // phone UI shows the login form with the error
    const delay = Math.min(60_000, 2000 * 2 ** attempt)
    console.warn(`[main] could not reach Discord, retrying in ${delay / 1000}s`, err)
    setTimeout(() => {
      if (store.token === token && !session.user) void resumeSession(token, attempt + 1)
    }, delay)
  }
}

/**
 * When the phone goes to the background, the Even app snapshots
 * window.__getStateSnapshot() and replays it into a headless WebView via
 * window.__restoreState(). SDK 0.0.16 has no helper for this, so register the
 * hooks directly (only if nothing else has). Keeps the newest feed items that
 * may not have been flushed to storage yet.
 */
function registerBackgroundSnapshot(): void {
  const w = window as any
  if (typeof w.__getStateSnapshot !== 'function') {
    w.__getStateSnapshot = () => JSON.stringify({ discordFeed: { feed: store.feed.slice(-60) } })
  }
  if (typeof w.__restoreState !== 'function') {
    w.__restoreState = (snapshot: unknown) => {
      try {
        const s = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot
        const feed = (s as any)?.discordFeed?.feed as FeedItem[] | undefined
        if (!Array.isArray(feed)) return
        for (const item of feed) store.addFeedItem(item)
        store.feed.sort((a, b) => a.ts - b.ts)
        renderSoon()
      } catch (err) {
        console.warn('[main] restore failed', err)
      }
    }
  }
}
