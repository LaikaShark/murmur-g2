import { storageGet, storageSet } from './bridge'

/** App state shared by the phone UI and the glasses renderer, persisted via the bridge. */

export interface WatchedChannel {
  id: string
  name: string
  guildId: string
  guildName: string
}

export interface Config {
  channels: WatchedChannel[]
  watchDMs: boolean
  /** Seconds before a message fades off the glasses; 0 = never. */
  fadeSeconds: number
  /** Disconnect from Discord after the glasses have been off this long; 0 = never. */
  powerSaveMinutes: number
  /** Skip messages from channels/servers muted in Discord. */
  respectMutes: boolean
  /** Show ||spoilered|| text instead of [spoiler]. */
  showSpoilers: boolean
  /** Hide originals that PluralKit-style bots delete and repost via webhook. */
  condenseProxies: boolean
  /** Servers where proxy behaviour has been seen (messages there are held briefly). */
  proxyGuilds: string[]
}

export interface FeedItem {
  id: string
  ts: number
  /** "#general", "Server/#general" or "DM" (kept for items saved by 0.1.x) */
  where: string
  /** Server name; absent for DMs */
  guild?: string
  /** Channel name without '#', e.g. "general" or "general > thread" */
  channel?: string
  /** Stable channel identity for filtering: watched channel id (threads use their parent), or the DM channel id */
  chanKey?: string
  author: string
  text: string
}

const KEY_TOKEN = 'discordfeed.token'
const KEY_CONFIG = 'discordfeed.config'
const KEY_FEED = 'discordfeed.feed'

export const FEED_MAX = 200
const FEED_PERSIST = 60

type Listener = () => void

class Store {
  token = ''
  config: Config = { channels: [], watchDMs: false, fadeSeconds: 60, powerSaveMinutes: 5, respectMutes: true, showSpoilers: false, condenseProxies: true, proxyGuilds: [] }
  feed: FeedItem[] = []
  /** False in demo mode: nothing is written to storage. */
  persist = true

  private listeners = new Set<Listener>()
  private feedSaveTimer: ReturnType<typeof setTimeout> | undefined

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  async load(): Promise<void> {
    this.token = await storageGet(KEY_TOKEN)
    try {
      const c = JSON.parse((await storageGet(KEY_CONFIG)) || '{}')
      this.config = {
        channels: Array.isArray(c.channels) ? c.channels : [],
        watchDMs: !!c.watchDMs,
        fadeSeconds: Number.isFinite(c.fadeSeconds) ? c.fadeSeconds : 60,
        powerSaveMinutes: Number.isFinite(c.powerSaveMinutes) ? c.powerSaveMinutes : 5,
        respectMutes: c.respectMutes !== false,
        showSpoilers: c.showSpoilers === true,
        condenseProxies: c.condenseProxies !== false,
        proxyGuilds: Array.isArray(c.proxyGuilds) ? c.proxyGuilds : [],
      }
    } catch {
      /* keep defaults */
    }
    try {
      const f = JSON.parse((await storageGet(KEY_FEED)) || '[]')
      if (Array.isArray(f)) {
        // Merge with anything restored from a background snapshot before load() ran.
        const seen = new Set(this.feed.map((x) => x.id))
        this.feed = [...f.filter((x: FeedItem) => !seen.has(x.id)), ...this.feed]
          .sort((a, b) => a.ts - b.ts)
          .slice(-FEED_MAX)
      }
    } catch {
      /* keep empty */
    }
  }

  async setToken(token: string): Promise<void> {
    this.token = token
    await storageSet(KEY_TOKEN, token)
    this.emit()
  }

  async updateConfig(patch: Partial<Config>): Promise<void> {
    this.config = { ...this.config, ...patch }
    this.emit()
    if (this.persist) await storageSet(KEY_CONFIG, JSON.stringify(this.config))
  }

  isWatched(channelId: string): boolean {
    return this.config.channels.some((c) => c.id === channelId)
  }

  async toggleChannel(ch: WatchedChannel, on: boolean): Promise<void> {
    const rest = this.config.channels.filter((c) => c.id !== ch.id)
    await this.updateConfig({ channels: on ? [...rest, ch] : rest })
  }

  /** Replace every watched channel of one server at once (one storage write). */
  async setGuildChannels(guildId: string, channels: WatchedChannel[]): Promise<void> {
    const rest = this.config.channels.filter((c) => c.guildId !== guildId)
    await this.updateConfig({ channels: [...rest, ...channels] })
  }

  /** Returns false if the message was already in the feed. */
  addFeedItem(item: FeedItem): boolean {
    if (this.feed.some((f) => f.id === item.id)) return false
    this.feed.push(item)
    if (this.feed.length > FEED_MAX) this.feed.splice(0, this.feed.length - FEED_MAX)
    this.emit()
    this.saveFeedSoon()
    return true
  }

  /** Remove a deleted message. Returns true if it was in the feed. */
  removeFeedItem(id: string): boolean {
    const i = this.feed.findIndex((f) => f.id === id)
    if (i < 0) return false
    this.feed.splice(i, 1)
    this.emit()
    this.saveFeedSoon()
    return true
  }

  clearFeed(): void {
    this.feed = []
    this.emit()
    this.saveFeedSoon()
  }

  /** Debounced: storage writes share the BLE link with rendering. */
  private saveFeedSoon(): void {
    clearTimeout(this.feedSaveTimer)
    this.feedSaveTimer = setTimeout(() => this.flushFeed(), 30_000) // also flushed on exit/background
  }

  async flushFeed(): Promise<void> {
    clearTimeout(this.feedSaveTimer)
    if (!this.persist) return
    await storageSet(KEY_FEED, JSON.stringify(this.feed.slice(-FEED_PERSIST)))
  }

  async logout(): Promise<void> {
    this.token = ''
    this.feed = []
    await storageSet(KEY_TOKEN, '')
    await storageSet(KEY_FEED, '[]')
    this.emit()
  }
}

export const store = new Store()
