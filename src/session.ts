import { getMe, type DiscordUser } from './discord/api'
import { authorName, plainContent } from './discord/format'
import { Gateway, type GatewayStatus } from './discord/gateway'
import { applyGuildSettings, isMuted, loadAllSettings, muteCount, rememberParent } from './discord/mutes'
import { noteDelete, noteWebhookMessage } from './discord/pluralkit'
import { noteNewMessage, setConnState } from './glasses'
import { store } from './store'

/**
 * Owns the logged-in Discord session: validates the token, runs the gateway
 * and turns MESSAGE_CREATE events for watched channels into feed items.
 */

export interface SessionState {
  user: DiscordUser | null
  status: GatewayStatus | 'signed-out'
  error: string
}

export const session: SessionState = { user: null, status: 'signed-out', error: '' }

/** Counters shown in the phone UI to help debug missing messages. */
export const stats = { dm: 0, server: 0, watched: 0, mutedSkipped: 0, subscribedGuilds: 0, mutes: 0, proxyCondensed: 0, deleted: 0 }

/** How long messages are held in proxy servers, so a deleted original never shows. */
const PROXY_HOLD_MS = 2000
/** Messages being held: id -> timer that adds them to the feed. */
const held = new Map<string, ReturnType<typeof setTimeout>>()

const listeners = new Set<() => void>()
export function onSessionChange(fn: () => void): void {
  listeners.add(fn)
}
function emit(): void {
  for (const fn of listeners) fn()
}

let gateway: Gateway | null = null
/** channel id -> name, from READY / CHANNEL_CREATE; used for #mentions and thread parents. */
const channelNames = new Map<string, string>()
/** thread id -> parent channel id */
const threadParents = new Map<string, string>()

function setStatus(status: SessionState['status'], error = ''): void {
  session.status = status
  session.error = error
  setConnState(
    status === 'live' ? 'live'
    : status === 'connecting' ? 'connecting'
    : status === 'reconnecting' ? 'reconnecting'
    : status === 'auth-failed' ? 'error'
    : status === 'paused' ? 'paused'
    : status === 'offline' && session.user ? 'reconnecting'
    : 'signed-out',
  )
  emit()
}

/** Validate the token, then connect the gateway. Throws on an invalid token. */
export async function startSession(token: string): Promise<void> {
  stopSession()
  setStatus('connecting')
  let user: DiscordUser
  try {
    user = await getMe(token)
  } catch (err: any) {
    setStatus(err?.status === 401 ? 'auth-failed' : 'offline', err?.message ?? String(err))
    throw err
  }
  session.user = user
  await store.setToken(token)

  gateway = new Gateway(token, {
    onStatus: (s, detail) => setStatus(s, detail ?? ''),
    onDispatch: handleDispatch,
  })
  gateway.start()
  emit()
}

export function stopSession(): void {
  gateway?.stop()
  gateway = null
}

export async function logout(): Promise<void> {
  stopSession()
  session.user = null
  await store.logout()
  setStatus('signed-out')
}

/** Re-send guild subscriptions after the watch list changes. */
export function resubscribe(): void {
  const ids = [...new Set(store.config.channels.map((c) => c.guildId))]
  gateway?.subscribeGuilds(ids)
  stats.subscribedGuilds = ids.length
  emit()
}

export function wake(): void {
  gateway?.poke()
}

/** Power saver: drop the connection but keep the session resumable. */
export function pauseConnection(): void {
  gateway?.pause()
}

export function resumeConnection(): void {
  gateway?.resume()
}

function rememberChannels(channels: any[] | undefined): void {
  for (const c of channels ?? []) {
    if (c?.id && c?.name) channelNames.set(c.id, c.name)
    if (c?.id && c?.parent_id && [10, 11, 12].includes(c.type)) threadParents.set(c.id, c.parent_id)
    if (c?.id) rememberParent(c.id, c.parent_id)
  }
}

function handleDispatch(type: string, d: any): void {
  switch (type) {
    case 'READY':
      if (d.user) session.user = d.user
      for (const g of d.guilds ?? []) {
        rememberChannels(g.channels)
        rememberChannels(g.threads)
      }
      loadAllSettings(d.user_guild_settings)
      stats.mutes = muteCount()
      resubscribe()
      emit()
      break
    case 'GUILD_CREATE':
      rememberChannels(d.channels)
      rememberChannels(d.threads)
      break
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      rememberChannels([d])
      break
    case 'THREAD_LIST_SYNC':
      rememberChannels(d.threads)
      break
    case 'USER_GUILD_SETTINGS_UPDATE':
      applyGuildSettings(d)
      stats.mutes = muteCount()
      emit()
      break
    case 'MESSAGE_CREATE':
      onMessage(d)
      break
    case 'MESSAGE_DELETE':
      onDelete(d.id, d.channel_id, d.guild_id)
      break
    case 'MESSAGE_DELETE_BULK':
      for (const id of d.ids ?? []) onDelete(id, d.channel_id, d.guild_id)
      break
  }
}

function onDelete(id: string, channelId: string, guildId: string | undefined): void {
  const cfg = store.config
  if (guildId && cfg.condenseProxies && noteDelete(channelId, id)) markProxyGuild(guildId)
  const timer = held.get(id)
  if (timer) {
    // Deleted while held: a proxied original that never needs to be shown.
    clearTimeout(timer)
    held.delete(id)
    stats.proxyCondensed++
    emit()
    return
  }
  if (store.removeFeedItem(id)) {
    stats.deleted++
    emit()
  }
}

function markProxyGuild(guildId: string): void {
  if (store.config.proxyGuilds.includes(guildId)) return
  void store.updateConfig({ proxyGuilds: [...store.config.proxyGuilds, guildId] })
}

function onMessage(msg: any): void {
  // Only normal messages and replies (skip joins, pins, boosts, etc.).
  if (msg.type !== 0 && msg.type !== 19) return
  if (msg.webhook_id && msg.guild_id && store.config.condenseProxies && noteWebhookMessage(msg.channel_id)) {
    markProxyGuild(msg.guild_id)
  }

  const cfg = store.config
  let where: string | null = null
  let guild: string | undefined
  let channel: string | undefined
  let chanKey: string = msg.channel_id

  if (msg.guild_id) stats.server++
  else stats.dm++

  if (!msg.guild_id) {
    if (!cfg.watchDMs) return
    if (msg.author?.id === session.user?.id) return
    if (cfg.respectMutes && isMuted(undefined, msg.channel_id)) {
      stats.mutedSkipped++
      emit()
      return
    }
    where = 'DM'
  } else {
    let watched = cfg.channels.find((c) => c.id === msg.channel_id)
    let threadSuffix = ''
    if (!watched) {
      const parent = threadParents.get(msg.channel_id)
      watched = parent ? cfg.channels.find((c) => c.id === parent) : undefined
      if (watched) threadSuffix = '>' + (channelNames.get(msg.channel_id) ?? 'thread')
    }
    if (!watched) {
      emit()
      return
    }
    stats.watched++
    if (cfg.respectMutes && isMuted(msg.guild_id, msg.channel_id)) {
      stats.mutedSkipped++
      emit()
      return
    }
    where = `${watched.guildName}/#${watched.name}${threadSuffix}`
    guild = watched.guildName
    chanKey = watched.id
    channel = watched.name + (threadSuffix ? ` > ${threadSuffix.slice(1)}` : '')
  }

  const text = plainContent(msg, (id) => channelNames.get(id), { showSpoilers: cfg.showSpoilers })
  if (!text) return

  const item = {
    id: msg.id,
    ts: Date.parse(msg.timestamp) || Date.now(),
    where,
    guild,
    channel,
    chanKey,
    author: authorName(msg),
    text,
  }
  const show = () => {
    held.delete(item.id)
    if (store.addFeedItem(item)) noteNewMessage(item)
  }
  // In proxy servers, hold non-webhook messages briefly: if the proxy bot deletes
  // the original, it's dropped in onDelete and only the webhook repost shows.
  if (cfg.condenseProxies && msg.guild_id && !msg.webhook_id && cfg.proxyGuilds.includes(msg.guild_id)) {
    held.set(item.id, setTimeout(show, PROXY_HOLD_MS))
  } else {
    show()
  }
}
