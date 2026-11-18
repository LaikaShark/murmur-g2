import { Unzlib } from 'fflate'
import { clientProperties } from './api'

/**
 * Minimal Discord gateway client for a user account, tuned for low data use:
 *
 *  - zlib-stream transport compression (JSON shrinks ~5-10x)
 *  - intents limited to servers, server messages and DMs (no presences,
 *    typing, reactions, voice); falls back to defaults if Discord refuses
 *  - capabilities that shrink the READY payload
 *  - low large_threshold, so unwatched big servers stay quiet
 *  - resumes on Discord's resume_gateway_url instead of re-identifying
 *
 * Handles heartbeat, zombie-connection detection, resume and reconnect with
 * backoff, and can be paused (socket closed, session kept for resuming).
 */

const DEFAULT_URL = 'wss://gateway.discord.gg'
const QUERY = '/?v=9&encoding=json&compress=zlib-stream'

const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
  GUILD_SUBSCRIPTIONS_BULK: 37,
} as const

/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15)

/**
 * LAZY_USER_NOTES | VERSIONED_USER_GUILD_SETTINGS | DEDUPE_USER_OBJECTS |
 * USER_SETTINGS_PROTO | DEBOUNCE_MESSAGE_REACTIONS | PASSIVE_GUILD_UPDATE_V2
 * (values as in arikawa/gateway/identify.go). None of these change the parts
 * of READY that Murmur reads (user, guilds[].channels, user_guild_settings).
 */
const CAPABILITIES = (1 << 0) | (1 << 3) | (1 << 4) | (1 << 9) | (1 << 13) | (1 << 14)

/** Servers above this member count only send events once subscribed (users: 50-250). */
const LARGE_THRESHOLD = 50

/** Close codes after which reconnecting cannot help. */
const FATAL_CLOSE = new Set([4004, 4010, 4011, 4012])
/** Invalid / disallowed intents: retry once without intents. */
const INTENT_CLOSE = new Set([4013, 4014])

/** zlib SYNC_FLUSH marker that ends every complete zlib-stream message. */
const ZLIB_SUFFIX = [0x00, 0x00, 0xff, 0xff]

export type GatewayStatus = 'offline' | 'connecting' | 'live' | 'reconnecting' | 'auth-failed' | 'paused'

export interface GatewayHandlers {
  onDispatch: (type: string, data: any) => void
  onStatus: (status: GatewayStatus, detail?: string) => void
}

/** Running totals, shown in the phone UI's diagnostics line. */
export const traffic = { wireBytes: 0, jsonBytes: 0, identifies: 0, resumes: 0, intentsRefused: false }

export class Gateway {
  private token: string
  private handlers: GatewayHandlers
  private ws: WebSocket | null = null
  private seq: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private awaitingAck = false
  private backoff = 1000
  private stopped = false
  private paused = false
  private useIntents = true
  private gotHello = false

  // zlib-stream state (one inflater per connection)
  private inflater: Unzlib | null = null
  private pending: Uint8Array[] = []
  private out: Uint8Array[] = []
  private decoder = new TextDecoder()

  constructor(token: string, handlers: GatewayHandlers) {
    this.token = token
    this.handlers = handlers
  }

  start(): void {
    this.stopped = false
    this.paused = false
    this.connect()
  }

  /** Close for good (logout): the session is invalidated. */
  stop(): void {
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.teardown(1000)
    this.handlers.onStatus('offline')
  }

  /** Close the socket but keep the session so resume() can pick up without a new READY. */
  pause(): void {
    if (this.stopped || this.paused) return
    this.paused = true
    clearTimeout(this.reconnectTimer)
    this.teardown(4000) // non-1000 close keeps the session resumable
    this.handlers.onStatus('paused')
  }

  resume(): void {
    if (this.stopped || !this.paused) return
    this.paused = false
    this.connect()
  }

  get isPaused(): boolean {
    return this.paused
  }

  /** Ask Discord to stream events for these guilds (needed for large guilds). */
  subscribeGuilds(guildIds: string[]): void {
    if (!guildIds.length) return
    const subscriptions: Record<string, unknown> = {}
    // Same flags discordo (via ningen) sends. In large servers Discord only
    // dispatches message events once the server has an active subscription.
    // With our intents, the typing/activity events this enables aren't sent.
    for (const id of guildIds) subscriptions[id] = { typing: true, activities: true, threads: true }
    this.send(OP.GUILD_SUBSCRIPTIONS_BULK, { subscriptions })
  }

  private connect(): void {
    this.teardown()
    this.handlers.onStatus(this.sessionId ? 'reconnecting' : 'connecting')
    const base = this.sessionId && this.resumeUrl ? this.resumeUrl : DEFAULT_URL
    const ws = new WebSocket(base.replace(/\/+$/, '') + QUERY)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    this.gotHello = false
    this.pending = []
    this.out = []
    this.inflater = new Unzlib((chunk) => {
      this.out.push(chunk)
    })
    ws.onmessage = (ev) => this.onFrame(ev.data)
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      // Couldn't even reach the resume host (e.g. blocked): use the default host next time.
      if (!this.gotHello && base !== DEFAULT_URL) this.resumeUrl = null
      this.onClose(ev.code, ev.reason)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private teardown(code = 4000): void {
    clearTimeout(this.heartbeatTimer)
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    this.awaitingAck = false
    this.inflater = null
    const ws = this.ws
    this.ws = null
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.onclose = null
      try {
        ws.close(code)
      } catch {
        /* ignore */
      }
    }
  }

  private send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }))
  }

  /** Collect compressed frames until a full message (ending in the SYNC_FLUSH marker) is in, then inflate it. */
  private onFrame(data: ArrayBuffer | string): void {
    if (typeof data === 'string') {
      // Uncompressed fallback (shouldn't happen with compress=zlib-stream).
      traffic.wireBytes += data.length
      traffic.jsonBytes += data.length
      return this.onPayload(data)
    }
    const bytes = new Uint8Array(data)
    traffic.wireBytes += bytes.length
    this.pending.push(bytes)
    const n = bytes.length
    if (n < 4 || ZLIB_SUFFIX.some((b, i) => bytes[n - 4 + i] !== b)) return

    const inflater = this.inflater
    if (!inflater) return
    for (const p of this.pending) inflater.push(p)
    this.pending = []
    const parts = this.out
    this.out = []
    const total = parts.reduce((s, p) => s + p.length, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const p of parts) {
      merged.set(p, off)
      off += p.length
    }
    traffic.jsonBytes += total
    this.onPayload(this.decoder.decode(merged))
  }

  private onPayload(text: string): void {
    let msg: { op: number; d: any; s: number | null; t: string | null }
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.s != null) this.seq = msg.s

    switch (msg.op) {
      case OP.HELLO:
        this.gotHello = true
        this.startHeartbeat(msg.d.heartbeat_interval)
        if (this.sessionId && this.seq != null) {
          traffic.resumes++
          this.send(OP.RESUME, { token: this.token, session_id: this.sessionId, seq: this.seq })
        } else {
          this.identify()
        }
        break
      case OP.HEARTBEAT:
        this.send(OP.HEARTBEAT, this.seq)
        break
      case OP.HEARTBEAT_ACK:
        this.awaitingAck = false
        break
      case OP.RECONNECT:
        this.scheduleReconnect(0)
        break
      case OP.INVALID_SESSION:
        if (!msg.d) {
          this.sessionId = null
          this.seq = null
          this.resumeUrl = null
        }
        this.scheduleReconnect(1000 + Math.random() * 4000)
        break
      case OP.DISPATCH:
        if (msg.t === 'READY') {
          this.sessionId = msg.d.session_id
          this.resumeUrl = msg.d.resume_gateway_url ?? null
          this.backoff = 1000
          this.handlers.onStatus('live')
        } else if (msg.t === 'RESUMED') {
          this.backoff = 1000
          this.handlers.onStatus('live')
        }
        if (msg.t) this.handlers.onDispatch(msg.t, msg.d)
        break
    }
  }

  private identify(): void {
    traffic.identifies++
    this.send(OP.IDENTIFY, {
      token: this.token,
      capabilities: CAPABILITIES,
      ...(this.useIntents ? { intents: INTENTS } : {}),
      large_threshold: LARGE_THRESHOLD,
      properties: clientProperties(),
      presence: { status: 'unknown', since: 0, activities: [], afk: false },
      compress: false, // transport compression (zlib-stream) is used instead
      client_state: { guild_versions: {} },
    })
  }

  private startHeartbeat(interval: number): void {
    clearTimeout(this.heartbeatTimer)
    clearInterval(this.heartbeatTimer)
    const beat = () => {
      if (this.awaitingAck) {
        // No ACK since last beat: zombie connection. Resume on a fresh socket.
        this.scheduleReconnect(0)
        return
      }
      this.awaitingAck = true
      this.send(OP.HEARTBEAT, this.seq)
    }
    // First beat after a random jitter, then every `interval` ms.
    this.heartbeatTimer = setTimeout(() => {
      beat()
      this.heartbeatTimer = setInterval(beat, interval)
    }, interval * Math.random())
  }

  private onClose(code: number, reason: string): void {
    this.teardown()
    if (this.stopped || this.paused) return
    if (INTENT_CLOSE.has(code) && this.useIntents) {
      // Discord refused intents for this account: fall back to the defaults.
      this.useIntents = false
      traffic.intentsRefused = true
      this.sessionId = null
      this.seq = null
      this.scheduleReconnect(1000)
      return
    }
    if (FATAL_CLOSE.has(code) || INTENT_CLOSE.has(code)) {
      this.handlers.onStatus('auth-failed', reason || `Gateway closed (${code})`)
      return
    }
    if (code === 4007 || code === 4009) {
      // Bad sequence / session timed out: start a new session.
      this.sessionId = null
      this.seq = null
      this.resumeUrl = null
    }
    this.scheduleReconnect(this.backoff)
    this.backoff = Math.min(this.backoff * 2, 60_000)
  }

  private scheduleReconnect(delay: number): void {
    if (this.stopped || this.paused) return
    this.teardown()
    this.handlers.onStatus('reconnecting')
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  /** Reconnect right away (e.g. app returned to foreground). */
  poke(): void {
    if (this.stopped || this.paused) return
    if (!this.ws || this.ws.readyState > WebSocket.OPEN) this.scheduleReconnect(0)
  }
}
