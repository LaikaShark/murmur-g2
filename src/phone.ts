import {
  CATEGORY_TYPE,
  TEXT_CHANNEL_TYPES,
  displayName,
  getGuildChannels,
  getGuilds,
  loginWithPassword,
  submitMfaCode,
  type GuildChannel,
  type PartialGuild,
} from './discord/api'
import manifest from '../app.json'
import { isDemo } from './demo'
import { drawInfo, inputInfo, itemHeader, onGlassesInput } from './glasses'
import { traffic } from './discord/gateway'
import { onPowerChange, power } from './power'
import { logout, onSessionChange, resubscribe, session, startSession, stats } from './session'
import { store } from './store'

/**
 * Phone-side UI (the WebView shown in the Even app): sign in, choose watched
 * servers/channels, and preview the feed the glasses are showing.
 */

const app = document.querySelector<HTMLDivElement>('#app')!

type View = 'loading' | 'login' | 'main'

const ui = {
  view: 'loading' as View,
  loginTab: 'token' as 'token' | 'password',
  mfaTicket: '',
  busy: false,
  error: '',
  mainTab: 'channels' as 'channels' | 'feed',
  guilds: null as PartialGuild[] | null,
  guildsError: '',
  expanded: new Set<string>(),
  channels: new Map<string, GuildChannel[] | 'loading' | { error: string }>(),
  filter: '',
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

// ---------- entry ----------

export function startPhoneUi(): void {
  onSessionChange(sync)
  store.subscribe(onStoreChange)
  onPowerChange(() => ui.view === 'main' && !document.hidden && renderStatus())
  onGlassesInput(() => ui.view === 'main' && !document.hidden && renderDiag())
  // Don't spend CPU redrawing a screen nobody sees; catch up when it's shown.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) onStoreChange()
  })
  sync()
}

/** Pick the view from session state; only re-render the whole view when it changes. */
function sync(): void {
  const signedIn = !!session.user && session.status !== 'signed-out' && session.status !== 'auth-failed'
  const next: View = signedIn ? 'main' : session.status === 'connecting' && !session.user ? 'loading' : 'login'
  if (next === 'login' && session.status === 'auth-failed' && !ui.error) {
    ui.error = session.error || 'Discord rejected the token. Sign in again.'
  }
  if (next !== ui.view) {
    ui.view = next
    renderView()
    if (next === 'main') void loadGuilds()
  } else if (next === 'main') {
    renderStatus()
  }
}

function onStoreChange(): void {
  if (ui.view !== 'main' || document.hidden) return
  renderStatus()
  renderFeed()
}

function renderView(): void {
  if (ui.view === 'loading') {
    app.innerHTML = `<h1>Murmur</h1><p class="muted">Connecting to Discord...</p>`
  } else if (ui.view === 'login') {
    renderLogin()
  } else {
    renderMain()
  }
}

// ---------- login ----------

function renderLogin(): void {
  const mfa = !!ui.mfaTicket
  app.innerHTML = `
    <h1>Murmur</h1>
    <p class="muted small">Sign in with your Discord account. Messages from the channels you pick are shown as plain text on your G2.</p>
    ${mfa ? '' : `
    <div class="tabs" role="tablist">
      <button data-tab="token" class="${ui.loginTab === 'token' ? 'active' : ''}">Token</button>
      <button data-tab="password" class="${ui.loginTab === 'password' ? 'active' : ''}">Email &amp; password</button>
    </div>`}
    <form class="card" id="login-form" autocomplete="off">
      ${mfa ? `
        <label for="mfa">Two-factor code</label>
        <input id="mfa" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6-digit code or backup code" required>
        <button type="submit" class="primary" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Checking...' : 'Verify'}</button>
        <button type="button" class="link" id="mfa-cancel">Cancel</button>
      ` : ui.loginTab === 'token' ? `
        <label for="token">Discord token</label>
        <textarea id="token" placeholder="Paste your token" spellcheck="false" required></textarea>
        <p class="muted small">Get it from the Discord web app: open developer tools, go to the Network tab, and copy the <code>Authorization</code> header from any request to <code>/api</code>. Treat it like a password.</p>
        <button type="submit" class="primary" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Signing in...' : 'Sign in'}</button>
      ` : `
        <label for="login">Email or phone</label>
        <input id="login" type="text" autocomplete="username" required>
        <label for="password">Password</label>
        <input id="password" type="password" autocomplete="current-password" required>
        <button type="submit" class="primary" ${ui.busy ? 'disabled' : ''}>${ui.busy ? 'Signing in...' : 'Sign in'}</button>
        <p class="muted small">If Discord asks for a captcha, use token sign-in instead.</p>
      `}
      ${ui.error ? `<div class="error">${esc(ui.error)}</div>` : ''}
    </form>
    <p class="muted small">Heads up: using a user account from a third-party client goes against Discord's Terms of Service and could get the account flagged. Your token is stored only on this phone.</p>
  `

  app.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.loginTab = b.dataset.tab as 'token' | 'password'
      ui.error = ''
      renderLogin()
    }),
  )
  app.querySelector('#mfa-cancel')?.addEventListener('click', () => {
    ui.mfaTicket = ''
    ui.error = ''
    renderLogin()
  })
  app.querySelector<HTMLFormElement>('#login-form')!.addEventListener('submit', (e) => {
    e.preventDefault()
    void submitLogin()
  })
}

const val = (id: string) => (app.querySelector<HTMLInputElement | HTMLTextAreaElement>('#' + id)?.value ?? '').trim()

async function submitLogin(): Promise<void> {
  if (ui.busy) return
  const mfaCode = val('mfa')
  const token = val('token').replace(/^"|"$/g, '')
  const login = val('login')
  const password = app.querySelector<HTMLInputElement>('#password')?.value ?? ''

  ui.busy = true
  ui.error = ''
  setBusyButton()
  try {
    if (ui.mfaTicket) {
      const t = await submitMfaCode(ui.mfaTicket, mfaCode)
      ui.mfaTicket = ''
      await startSession(t)
    } else if (ui.loginTab === 'token') {
      await startSession(token)
    } else {
      const res = await loginWithPassword(login, password)
      if (res.kind === 'mfa') {
        if (!res.totp) throw new Error('This account uses SMS or security-key 2FA only. Use token sign-in instead.')
        ui.mfaTicket = res.ticket
      } else {
        await startSession(res.token)
      }
    }
  } catch (err: any) {
    ui.error = err?.message ?? String(err)
  } finally {
    ui.busy = false
  }
  if (ui.view === 'login') renderLogin()
}

function setBusyButton(): void {
  const b = app.querySelector<HTMLButtonElement>('button[type=submit]')
  if (b) {
    b.disabled = true
    b.textContent = 'Working...'
  }
}

// ---------- main ----------

function renderMain(): void {
  app.innerHTML = `
    <div class="topbar">
      <div>
        <div class="who">${esc(session.user ? displayName(session.user) : '')}</div>
        <div id="status"></div>
      </div>
      <button id="logout">Sign out</button>
    </div>
    <div class="tabs">
      <button data-main="channels" class="${ui.mainTab === 'channels' ? 'active' : ''}">Channels</button>
      <button data-main="feed" class="${ui.mainTab === 'feed' ? 'active' : ''}">Feed</button>
    </div>
    <section id="tab-channels" ${ui.mainTab === 'channels' ? '' : 'hidden'}>
      <h2>Options</h2>
      <div class="card">
        <div class="row"><span>Direct messages</span>${toggle('opt-dms', store.config.watchDMs)}</div>
        <div class="row"><span>Fade messages on glasses after</span>${fadeSelect()}</div>
        <div class="row"><span>Disconnect when glasses are off for<br><span class="muted small">In the case or disconnected. Saves battery and data; reconnects when they're back</span></span>${powerSelect()}</div>
        <div class="row"><span>Always show spoilers<br><span class="muted small">Show spoilered text instead of [spoiler]</span></span>${toggle('opt-spoilers', store.config.showSpoilers)}</div>
        <div class="row"><span>Condense PluralKit messages<br><span class="muted small">Hide originals that PluralKit or Tupperbox replace, so each message shows once</span></span>${toggle('opt-proxy', store.config.condenseProxies)}</div>
        <div class="row"><span>Respect Discord mutes<br><span class="muted small">Skip channels, categories, servers and DMs you've muted in Discord</span></span>${toggle('opt-mutes', store.config.respectMutes)}</div>
      </div>
      <h2>Servers</h2>
      <input type="search" id="filter" placeholder="Filter servers" value="${esc(ui.filter)}">
      <div class="card" id="guilds"></div>
    </section>
    <section id="tab-feed" ${ui.mainTab === 'feed' ? '' : 'hidden'}>
      <div class="topbar"><h2>Latest on glasses</h2><button id="clear-feed">Clear</button></div>
      <div class="card feed" id="feed"></div>
      <p class="muted small">On the glasses: swipe to scroll back, tap to return to live, double-tap for the menu (filter to one channel, show all, pause, or exit). The corner shows ● connected, ○ not connected, ■ paused, ▲ history.</p>
      <details class="diag">
        <summary class="muted small">Diagnostics</summary>
        <p class="muted small" id="diag"></p>
        <p class="muted small" id="devlog" style="white-space:pre-line"></p>
      </details>
      <p class="muted small">Murmur v${esc(manifest.version)}</p>
    </section>
  `

  app.querySelector('#logout')!.addEventListener('click', () => {
    ui.guilds = null
    ui.channels.clear()
    ui.expanded.clear()
    ui.error = ''
    void logout()
  })
  app.querySelectorAll<HTMLButtonElement>('[data-main]').forEach((b) =>
    b.addEventListener('click', () => {
      ui.mainTab = b.dataset.main as 'channels' | 'feed'
      app.querySelectorAll<HTMLButtonElement>('[data-main]').forEach((x) => x.classList.toggle('active', x === b))
      app.querySelector<HTMLElement>('#tab-channels')!.hidden = ui.mainTab !== 'channels'
      app.querySelector<HTMLElement>('#tab-feed')!.hidden = ui.mainTab !== 'feed'
    }),
  )
  app.querySelector<HTMLInputElement>('#opt-dms')!.addEventListener('change', (e) =>
    void store.updateConfig({ watchDMs: (e.target as HTMLInputElement).checked }),
  )
  app.querySelector<HTMLSelectElement>('#opt-fade')!.addEventListener('change', (e) =>
    void store.updateConfig({ fadeSeconds: Number((e.target as HTMLSelectElement).value) }),
  )
  app.querySelector<HTMLSelectElement>('#opt-power')!.addEventListener('change', (e) =>
    void store.updateConfig({ powerSaveMinutes: Number((e.target as HTMLSelectElement).value) }),
  )
  app.querySelector<HTMLInputElement>('#opt-spoilers')!.addEventListener('change', (e) =>
    void store.updateConfig({ showSpoilers: (e.target as HTMLInputElement).checked }),
  )
  app.querySelector<HTMLInputElement>('#opt-proxy')!.addEventListener('change', (e) =>
    void store.updateConfig({ condenseProxies: (e.target as HTMLInputElement).checked }),
  )
  app.querySelector<HTMLInputElement>('#opt-mutes')!.addEventListener('change', (e) =>
    void store.updateConfig({ respectMutes: (e.target as HTMLInputElement).checked }),
  )
  app.querySelector<HTMLInputElement>('#filter')!.addEventListener('input', (e) => {
    ui.filter = (e.target as HTMLInputElement).value
    renderGuilds()
  })
  app.querySelector('#clear-feed')!.addEventListener('click', () => store.clearFeed())

  // Event delegation for the dynamic lists.
  app.querySelector('#guilds')!.addEventListener('click', onGuildsClick)
  app.querySelector('#guilds')!.addEventListener('change', onGuildsChange)

  renderStatus()
  renderGuilds()
  renderFeed()
}

const FADE_OPTIONS: [number, string][] = [
  [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [120, '2 minutes'],
  [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [0, 'Never'],
]

function fadeSelect(): string {
  const cur = store.config.fadeSeconds
  const opts = FADE_OPTIONS.some(([v]) => v === cur) ? FADE_OPTIONS : [...FADE_OPTIONS, [cur, `${cur} seconds`] as [number, string]]
  return `<select id="opt-fade">${opts.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`
}

const POWER_OPTIONS: [number, string][] = [[1, '1 minute'], [5, '5 minutes'], [15, '15 minutes'], [60, '1 hour'], [0, 'Never']]

function powerSelect(): string {
  const cur = store.config.powerSaveMinutes
  return `<select id="opt-power">${POWER_OPTIONS.map(([v, l]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${l}</option>`).join('')}</select>`
}

function toggle(id: string, on: boolean): string {
  return `<label class="switch" style="margin:0"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`
}

function renderDiag(): void {
  const el = app.querySelector('#diag')
  if (!el) return
  const mb = (n: number) => (n / 1048576).toFixed(n < 1048576 ? 2 : 1) + ' MB'
  const saved = traffic.jsonBytes ? Math.round((1 - traffic.wireBytes / traffic.jsonBytes) * 100) : 0
  el.textContent = `Data: ${mb(traffic.wireBytes)} received (${mb(traffic.jsonBytes)} uncompressed, ${saved}% saved); ${traffic.identifies} full logins, ${traffic.resumes} resumes${traffic.intentsRefused ? '; event filter refused by Discord' : ''}. Glasses ${power.glassesOn ? 'on' : 'off'} (${power.device})${power.connectionPaused ? ', connection paused' : ''}. Drawing: ${!drawInfo.started ? 'startup failed' : drawInfo.suspended ? 'paused' : 'active'}, ${drawInfo.rebuilds} redraws, ${drawInfo.updates} updates, ${drawInfo.failed} failed. Last glasses input: ${inputInfo.last || 'none yet'}. Since connecting: ${stats.server} server messages seen (${stats.watched} in watched channels, ${stats.mutedSkipped} skipped as muted), ${stats.dm} DMs, ${stats.deleted} removed after deletion, ${stats.proxyCondensed} PluralKit originals hidden (${store.config.proxyGuilds.length} proxy server(s) learned). Subscribed to ${stats.subscribedGuilds} server(s). ${stats.mutes} active Discord mutes.`
}

function renderDevLog(): void {
  const el = app.querySelector('#devlog')
  if (!el) return
  const head = `Glasses status: ${power.updates} updates pushed by the Even app, ${power.checks} checks${power.lastCheck ? ` (last ${power.lastCheck})` : ''}.`
  el.textContent = head + (power.log.length ? '\nGlasses events:\n' + power.log.join('\n') : '')
}

function renderStatus(): void {
  renderDiag()
  renderDevLog()
  const el = app.querySelector('#status')
  if (!el) return
  const label =
    session.status === 'live' ? 'Live'
    : session.status === 'connecting' ? 'Connecting...'
    : session.status === 'reconnecting' ? 'Reconnecting...'
    : session.status === 'offline' ? `Offline${session.error ? ': ' + session.error : ''}`
    : session.status === 'paused' ? 'Paused while glasses are off'
    : session.status
  el.innerHTML = `<span class="pill"><span class="dot ${session.status}"></span>${esc(label)}</span>`
}

async function loadGuilds(): Promise<void> {
  ui.guildsError = ''
  if (isDemo()) {
    ui.guildsError = 'Demo mode: not connected to Discord. Remove ?demo from the URL to sign in.'
    renderGuilds()
    return
  }
  try {
    const guilds = await getGuilds(store.token)
    // Servers with watched channels first, then alphabetical. Sorted once here so
    // a server doesn't jump around while you tick its channels.
    const watchedGuilds = new Set(store.config.channels.map((c) => c.guildId))
    ui.guilds = guilds.sort(
      (a, b) => Number(watchedGuilds.has(b.id)) - Number(watchedGuilds.has(a.id)) || a.name.localeCompare(b.name),
    )
    for (const id of watchedGuilds) if (!ui.channels.has(id)) void loadChannels(id)
  } catch (err: any) {
    ui.guildsError = err?.message ?? String(err)
  }
  renderGuilds()
}

function renderGuilds(): void {
  const el = app.querySelector('#guilds')
  if (!el) return
  if (ui.guildsError) {
    el.innerHTML = `<div class="error">${esc(ui.guildsError)}</div><button data-retry>Retry</button>`
    return
  }
  if (!ui.guilds) {
    el.innerHTML = `<p class="muted small" style="margin:0">Loading servers...</p>`
    return
  }
  const q = ui.filter.trim().toLowerCase()
  const list = ui.guilds.filter((g) => !q || g.name.toLowerCase().includes(q))
  if (!list.length) {
    el.innerHTML = `<p class="muted small" style="margin:0">No servers match.</p>`
    return
  }
  el.innerHTML = list
    .map((g) => {
      const count = store.config.channels.filter((c) => c.guildId === g.id).length
      const total = textChannels(g.id)?.length
      const all = count > 0 && (total === undefined || count >= total)
      const open = ui.expanded.has(g.id)
      const busy = ui.channels.get(g.id) === 'loading'
      return `<div class="guild">
        <div class="guild-head">
          <button data-guild="${g.id}" aria-expanded="${open}">
            <span>${open ? '▾' : '▸'} ${esc(g.name)}</span>
            ${count ? `<span class="count">${all ? 'all' : total ? `${count} of ${total}` : count} watched</span>` : ''}
          </button>
          <label class="switch" title="Watch every text channel">
            <input type="checkbox" data-guild-all="${g.id}" aria-label="Watch all of ${esc(g.name)}" ${all ? 'checked' : ''} ${busy ? 'disabled' : ''}><span></span>
          </label>
        </div>
        ${open ? `<div class="channels">${renderChannels(g)}</div>` : ''}
      </div>`
    })
    .join('')
}

/** Text channels of a server, or undefined if they haven't been fetched. */
function textChannels(guildId: string): GuildChannel[] | undefined {
  const entry = ui.channels.get(guildId)
  return Array.isArray(entry) ? entry.filter((c) => TEXT_CHANNEL_TYPES.has(c.type)) : undefined
}

function renderChannels(g: PartialGuild): string {
  const entry = ui.channels.get(g.id)
  if (!entry || entry === 'loading') return `<p class="muted small">Loading channels...</p>`
  if (!Array.isArray(entry)) return `<div class="error">${esc(entry.error)}</div>`

  const byPos = (a: GuildChannel, b: GuildChannel) => a.position - b.position
  const text = entry.filter((c) => TEXT_CHANNEL_TYPES.has(c.type))
  if (!text.length) return `<p class="muted small">No text channels.</p>`
  const cats = entry.filter((c) => c.type === CATEGORY_TYPE).sort(byPos)
  const groups: { name: string; chans: GuildChannel[] }[] = [
    { name: '', chans: text.filter((c) => !c.parent_id).sort(byPos) },
    ...cats.map((cat) => ({ name: cat.name, chans: text.filter((c) => c.parent_id === cat.id).sort(byPos) })),
  ]
  return groups
    .filter((grp) => grp.chans.length)
    .map(
      (grp) => `${grp.name ? `<div class="category">${esc(grp.name)}</div>` : ''}
      ${grp.chans
        .map(
          (c) => `<label class="channel"><input type="checkbox" data-channel="${c.id}" data-guild-id="${g.id}" ${store.isWatched(c.id) ? 'checked' : ''}>#${esc(c.name)}</label>`,
        )
        .join('')}`,
    )
    .join('')
}

function onGuildsClick(e: Event): void {
  const target = e.target as HTMLElement
  if (target.closest('[data-retry]')) {
    ui.guilds = null
    renderGuilds()
    void loadGuilds()
    return
  }
  const id = target.closest<HTMLElement>('[data-guild]')?.dataset.guild
  if (!id) return
  if (ui.expanded.has(id)) {
    ui.expanded.delete(id)
  } else {
    ui.expanded.add(id)
    if (!Array.isArray(ui.channels.get(id))) void loadChannels(id)
  }
  renderGuilds()
}

async function loadChannels(guildId: string): Promise<void> {
  ui.channels.set(guildId, 'loading')
  try {
    ui.channels.set(guildId, await getGuildChannels(store.token, guildId))
  } catch (err: any) {
    ui.channels.set(guildId, { error: err?.message ?? String(err) })
  }
  renderGuilds()
}

function onGuildsChange(e: Event): void {
  const input = e.target as HTMLInputElement
  if (input.dataset.guildAll) {
    void toggleWholeGuild(input.dataset.guildAll, input.checked)
    return
  }
  const channelId = input.dataset.channel
  const guildId = input.dataset.guildId
  if (!channelId || !guildId) return
  const guild = ui.guilds?.find((g) => g.id === guildId)
  const chans = ui.channels.get(guildId)
  const ch = Array.isArray(chans) ? chans.find((c) => c.id === channelId) : undefined
  if (!guild || !ch) return
  void store
    .toggleChannel({ id: ch.id, name: ch.name, guildId: guild.id, guildName: guild.name }, input.checked)
    .then(() => {
      resubscribe()
      renderGuilds()
    })
}

async function toggleWholeGuild(guildId: string, on: boolean): Promise<void> {
  const guild = ui.guilds?.find((g) => g.id === guildId)
  if (!guild) return
  if (on && !textChannels(guildId)) {
    await loadChannels(guildId)
    if (!textChannels(guildId)) return // fetch failed; renderGuilds shows the error when expanded
  }
  const chans = on
    ? textChannels(guildId)!.map((c) => ({ id: c.id, name: c.name, guildId: guild.id, guildName: guild.name }))
    : []
  await store.setGuildChannels(guildId, chans)
  resubscribe()
  renderGuilds()
}

function renderFeed(): void {
  const el = app.querySelector('#feed')
  if (!el) return
  const items = store.feed.slice(-50).reverse()
  if (!items.length) {
    el.innerHTML = `<p class="muted small" style="margin:0;font-family:system-ui">No messages yet. New messages in watched channels show up here and on the glasses.</p>`
    return
  }
  el.innerHTML = items
    .map((it) => {
      const t = new Date(it.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return `<div><time>${t}</time><span class="where">${esc(itemHeader(it))}</span><br>${esc(it.text)}</div>`
    })
    .join('')
}
