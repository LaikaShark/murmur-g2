import { noteNewMessage, setConnState } from './glasses'
import { session } from './session'
import { store } from './store'

/**
 * Demo mode (open the app with `?demo`): no Discord connection, just fake
 * messages every few seconds so the glasses layout and input can be tried in
 * the simulator. Nothing is persisted.
 */

const SAMPLES: [string, string, string][] = [
  ['#general', 'alice', 'anyone up for a game tonight?'],
  ['#general', 'bob', 'sure, after 9'],
  ['#announcements', 'Mod Bot', 'Server maintenance this Saturday 10:00-12:00 UTC. Expect a few minutes of downtime while we migrate the database to new hardware.'],
  ['#dev', 'carol', 'PR is up for the gateway reconnect fix, could use a review'],
  ['DM', 'dave', 'did you see the patch notes? :eyes:'],
  ['#general', 'erin', '[image]'],
  ['#dev', 'frank', 'CI is green again'],
]

export function isDemo(): boolean {
  return new URLSearchParams(location.search).has('demo')
}

export function startDemo(): void {
  store.persist = false
  session.user = { id: 'demo', username: 'demo', global_name: 'Demo mode' }
  session.status = 'live'
  store.config = {
    channels: [{ id: 'demo', name: 'general', guildId: 'demo', guildName: 'Demo' }],
    watchDMs: true,
    fadeSeconds: 20,
    powerSaveMinutes: 0,
    respectMutes: true,
    showSpoilers: false,
    condenseProxies: true,
    proxyGuilds: [],
  }
  store.feed = []
  setConnState('live')
  let i = 0
  const tick = () => {
    const [where, author, text] = SAMPLES[i % SAMPLES.length]
    const dm = where === 'DM'
    const item = { id: `demo-${i}`, ts: Date.now(), where, author, text, guild: dm ? undefined : 'Demo', channel: dm ? undefined : where.slice(1) }
    if (store.addFeedItem(item)) noteNewMessage(item)
    i++
  }
  for (let n = 0; n < 4; n++) tick()
  setInterval(tick, 4000)
}
