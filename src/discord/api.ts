/**
 * Minimal Discord REST client for a user account, modelled on discordo's
 * login flows (token / email+password). Discord's API sends permissive CORS
 * headers, so this runs directly from the WebView with no proxy.
 */

const API = 'https://discord.com/api/v9'

export interface DiscordUser {
  id: string
  username: string
  global_name?: string | null
  discriminator?: string
}

export interface PartialGuild {
  id: string
  name: string
}

export interface GuildChannel {
  id: string
  name: string
  type: number
  position: number
  parent_id?: string | null
}

/** Channel types that carry normal chat messages. */
export const TEXT_CHANNEL_TYPES = new Set([0, 5]) // GUILD_TEXT, GUILD_ANNOUNCEMENT
export const CATEGORY_TYPE = 4

export class DiscordApiError extends Error {
  status: number
  body: any
  constructor(status: number, body: any, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

/**
 * The Discord web client sends a base64 JSON "super properties" header. We send
 * an honest one describing this WebView so login looks like a normal browser.
 */
export function clientProperties(): Record<string, unknown> {
  const ua = navigator.userAgent
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Mac/i.test(ua) ? 'Mac OS X' : /Windows/i.test(ua) ? 'Windows' : 'Linux'
  const browser = /Safari/i.test(ua) && !/Chrome/i.test(ua) ? 'Safari' : 'Chrome'
  return {
    os,
    browser,
    device: '',
    system_locale: navigator.language || 'en-US',
    browser_user_agent: ua,
    browser_version: '',
    os_version: '',
    referrer: '',
    referring_domain: '',
    release_channel: 'stable',
    client_build_number: 0,
    client_event_source: null,
  }
}

function superProperties(): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(clientProperties()))))
}

async function request<T>(method: string, path: string, opts: { token?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {
    'X-Super-Properties': superProperties(),
    'X-Discord-Locale': navigator.language || 'en-US',
  }
  if (opts.token) headers['Authorization'] = opts.token
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(API + path, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  const text = await res.text()
  let body: any = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }

  if (res.status === 429) {
    const wait = Number(body?.retry_after ?? 1)
    throw new DiscordApiError(429, body, `Rate limited, try again in ${Math.ceil(wait)}s`)
  }
  if (!res.ok) throw new DiscordApiError(res.status, body, describeError(res.status, body))
  return body as T
}

function describeError(status: number, body: any): string {
  if (body?.captcha_key) {
    return 'Discord asked for a captcha, which this app cannot show. Sign in with a token instead.'
  }
  // Field errors: { errors: { login: { _errors: [{ message }] } } }
  const fieldMsgs: string[] = []
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node._errors)) node._errors.forEach((e: any) => e?.message && fieldMsgs.push(e.message))
    for (const k of Object.keys(node)) if (k !== '_errors') walk(node[k])
  }
  walk(body?.errors)
  if (fieldMsgs.length) return fieldMsgs.join(' ')
  if (status === 401) return 'Discord rejected this token. Check it and sign in again.'
  if (body?.message) return body.message
  return `Discord returned HTTP ${status}`
}

// ---------- auth ----------

export type LoginResult =
  | { kind: 'token'; token: string }
  | { kind: 'mfa'; ticket: string; totp: boolean; sms: boolean }

export async function loginWithPassword(login: string, password: string): Promise<LoginResult> {
  const res = await request<any>('POST', '/auth/login', {
    body: { login, password, undelete: false, login_source: null, gift_code_sku_id: null },
  })
  if (res?.token) return { kind: 'token', token: res.token }
  if (res?.mfa && res?.ticket) return { kind: 'mfa', ticket: res.ticket, totp: !!res.totp, sms: !!res.sms }
  throw new Error('Discord did not return a token. Try signing in with a token instead.')
}

/** Finish an MFA login with a 6-digit authenticator code (or an 8-char backup code). */
export async function submitMfaCode(ticket: string, code: string): Promise<string> {
  const clean = code.replace(/\s+/g, '')
  const kind = /^\d{6}$/.test(clean) ? 'totp' : 'backup'
  const res = await request<any>('POST', `/auth/mfa/${kind}`, {
    body: { code: clean, ticket, login_source: null, gift_code_sku_id: null },
  })
  if (!res?.token) throw new Error('Discord did not return a token')
  return res.token
}

// ---------- data ----------

export function getMe(token: string): Promise<DiscordUser> {
  return request('GET', '/users/@me', { token })
}

export function getGuilds(token: string): Promise<PartialGuild[]> {
  return request('GET', '/users/@me/guilds', { token })
}

export function getGuildChannels(token: string, guildId: string): Promise<GuildChannel[]> {
  return request('GET', `/guilds/${guildId}/channels`, { token })
}

export function displayName(u: Pick<DiscordUser, 'username' | 'global_name'>): string {
  return u.global_name || u.username
}
