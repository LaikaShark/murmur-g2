import type { DeviceStatus } from '@evenrealities/even_hub_sdk'
import { enqueue, getBridge } from './bridge'
import { onGlassesInput, setSuspended } from './glasses'
import { pauseConnection, resumeConnection, session } from './session'
import { store } from './store'

/**
 * Battery saver driven by the glasses' state:
 *  - glasses off (in the case or disconnected): stop all Bluetooth rendering
 *    immediately;
 *  - still off after `powerSaveMinutes`: close the Discord connection too
 *    (session kept, so coming back is a cheap resume, not a full re-login);
 *  - glasses back on: reconnect and repaint.
 *
 * Only the glasses count. Ring status updates and ring input are ignored, as are
 * status updates that don't carry the glasses' serial number.
 *
 * Wear detection isn't used: the status plug-ins get reports isWearing=false
 * whether or not the glasses are on (even with wear detection enabled), and
 * foreground events don't fire on take-off either. Because status callbacks
 * aren't reliable, while
 * paused it also re-checks the glasses every 15 s, and treats any press on the
 * glasses' arms or the app returning to the glasses' foreground as "on".
 */

export const power = {
  glassesOn: true,
  connectionPaused: false,
  device: 'unknown',
  log: [] as string[],
  /** Status pushes received from the Even app, and status checks we made. */
  updates: 0,
  checks: 0,
  lastCheck: '',
}

/** Status check interval while the glasses count as on / off. */
const POLL_ON_MS = 30_000
const POLL_OFF_MS = 15_000
let glassesSn: string | null = null
let offTimer: ReturnType<typeof setTimeout> | undefined
let pollTimer: ReturnType<typeof setTimeout> | undefined
const listeners = new Set<() => void>()
export function onPowerChange(fn: () => void): void {
  listeners.add(fn)
}
const emit = () => listeners.forEach((fn) => fn())

function log(line: string): void {
  const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  power.log.push(`${t} ${line}`)
  if (power.log.length > 10) power.log.shift()
}

export async function startPowerSaver(): Promise<void> {
  const bridge = getBridge()
  if (!bridge) return

  // Presses on the glasses' arms (1 = right, 3 = left) prove they're on. Ring (2)
  // and source-less events (swipes) don't count.
  onGlassesInput((source) => {
    if (source === 1 || source === 3) {
      if (!power.glassesOn) log(`press on glasses (${source === 1 ? 'right' : 'left'} arm): on`)
      setGlassesOn(true)
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      clearTimeout(offTimer)
      wakeConnection()
    } else if (!power.glassesOn) {
      armSleep() // phone closed again while the glasses are still off
    }
  })

  const info = await enqueue('getDeviceInfo', (b) => b.getDeviceInfo())
  if (!info || !info.isGlasses?.()) {
    power.device = info ? `not glasses (${info.model}); power saver off` : 'not reported; power saver off'
    log(power.device)
    emit()
    return
  }
  glassesSn = info.sn
  log(`glasses ${info.model} found`)
  if (info.status) onStatus(info.status, 'startup', info.sn)
  bridge.onDeviceStatusChanged((st) => {
    power.updates++
    onStatus(st, 'update')
  })
  schedulePoll()
}

/** Read the glasses' status now. */
async function checkGlassesNow(): Promise<void> {
  if (!glassesSn) return
  const info = await enqueue('getDeviceInfo', (b) => b.getDeviceInfo())
  power.checks++
  power.lastCheck = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  if (info?.status) onStatus(info.status, 'check', info.sn)
}

/** Status pushes aren't reliable, so always re-check periodically (more often while off). */
function schedulePoll(): void {
  clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    await checkGlassesNow()
    schedulePoll()
  }, power.glassesOn ? POLL_ON_MS : POLL_OFF_MS)
}

/** The app came back to the foreground on the glasses: they're on. */
export function noteGlassesForeground(): void {
  if (!power.glassesOn) log('app in foreground on glasses: on')
  setGlassesOn(true)
}

/** `sn` defaults to the status's own serial; device-info lookups pass the device's serial. */
function onStatus(st: DeviceStatus, via: string, sn: string | undefined = st.sn): void {
  const desc = `conn=${String(st.connectType ?? 'none')} inCase=${st.isInCase ?? '?'}`
  if (!glassesSn || !sn || sn !== glassesSn) {
    log(`${via}: ignored (not the glasses) ${desc}`)
    emit()
    return
  }
  power.device = desc
  const conn = String(st.connectType ?? 'none')
  const off = st.isInCase === true || conn === 'disconnected' || conn === 'connectionFailed'
  if (off !== !power.glassesOn) log(`${via}: ${desc} → ${off ? 'off' : 'on'}`)
  setGlassesOn(!off)
  emit()
}

function setGlassesOn(on: boolean): void {
  if (on === power.glassesOn) return
  power.glassesOn = on
  setSuspended(!on)
  clearTimeout(offTimer)
  if (on) wakeConnection()
  else armSleep()
  if (glassesSn) schedulePoll() // switch between the on/off check intervals
  emit()
}

function armSleep(): void {
  clearTimeout(offTimer)
  const mins = store.config.powerSaveMinutes
  if (mins > 0) offTimer = setTimeout(sleepConnection, mins * 60_000)
}

function sleepConnection(): void {
  if (power.glassesOn || !session.user) return
  power.connectionPaused = true
  log('connection paused')
  pauseConnection()
  emit()
}

function wakeConnection(): void {
  if (!power.connectionPaused) return
  power.connectionPaused = false
  log('connection resumed')
  resumeConnection()
  emit()
}
