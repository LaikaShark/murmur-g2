/**
 * Tracks the user's Discord mute settings (server, category, channel and DM
 * mutes, including timed ones) from READY.user_guild_settings and
 * USER_GUILD_SETTINGS_UPDATE.
 */

interface MuteState {
  muted: boolean
  /** ms epoch when a timed mute ends; null = until turned off */
  until: number | null
}

/** key: guild id ('@me' for DMs) */
const guildMutes = new Map<string, MuteState>()
/** key: channel or category id */
const channelMutes = new Map<string, MuteState>()
/** channel id -> parent id (thread -> channel, channel -> category) */
const parents = new Map<string, string>()

function toState(muted: unknown, muteConfig: any): MuteState {
  const end = muteConfig?.end_time ? Date.parse(muteConfig.end_time) : NaN
  return { muted: !!muted, until: Number.isFinite(end) ? end : null }
}

function active(s: MuteState | undefined): boolean {
  return !!s?.muted && (s.until === null || s.until > Date.now())
}

/** Apply one guild's settings object (as sent in READY or USER_GUILD_SETTINGS_UPDATE). */
export function applyGuildSettings(entry: any): void {
  if (!entry) return
  const gid = entry.guild_id ?? '@me'
  guildMutes.set(gid, toState(entry.muted, entry.mute_config))
  for (const o of entry.channel_overrides ?? []) {
    if (o?.channel_id) channelMutes.set(o.channel_id, toState(o.muted, o.mute_config))
  }
}

/** READY.user_guild_settings is an array, or { entries: [...] } with newer capabilities. */
export function loadAllSettings(raw: any): number {
  const entries: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.entries) ? raw.entries : []
  entries.forEach(applyGuildSettings)
  return entries.length
}

export function rememberParent(channelId: string, parentId: string | null | undefined): void {
  if (parentId) parents.set(channelId, parentId)
}

export function parentOf(channelId: string): string | undefined {
  return parents.get(channelId)
}

/** True if this channel (or its parent channel / category, or its server) is muted in Discord. */
export function isMuted(guildId: string | undefined, channelId: string): boolean {
  if (active(guildMutes.get(guildId ?? '@me')) && guildId) return true
  let id: string | undefined = channelId
  for (let depth = 0; id && depth < 3; depth++) {
    if (active(channelMutes.get(id))) return true
    id = parents.get(id)
  }
  return false
}

export function muteCount(): number {
  let n = 0
  for (const s of guildMutes.values()) if (active(s)) n++
  for (const s of channelMutes.values()) if (active(s)) n++
  return n
}
