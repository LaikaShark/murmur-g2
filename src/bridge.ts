import { waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'

/**
 * Thin wrapper around the Even Hub bridge.
 *
 * - All bridge calls go through one serial queue (concurrent BLE calls can
 *   crash the connection) with a per-call timeout.
 * - When the page runs in a plain browser (no Even app / simulator), the bridge
 *   never shows up; we fall back to window.localStorage so the phone UI can
 *   still be developed and tested.
 */

const CALL_TIMEOUT_MS = 5000
const BRIDGE_WAIT_MS = 4000

let bridge: EvenAppBridge | null = null
let queue: Promise<unknown> = Promise.resolve()

export async function initBridge(): Promise<EvenAppBridge | null> {
  bridge = await Promise.race([
    waitForEvenAppBridge(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIDGE_WAIT_MS)),
  ])
  return bridge
}

export function getBridge(): EvenAppBridge | null {
  return bridge
}

/** Run a bridge call after every previously queued call has settled. */
export function enqueue<T>(label: string, fn: (b: EvenAppBridge) => Promise<T>): Promise<T | undefined> {
  const b = bridge
  if (!b) return Promise.resolve(undefined)
  const run = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        fn(b),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => {
            console.warn(`[bridge] ${label} timed out`)
            resolve(undefined)
          }, CALL_TIMEOUT_MS)
        }),
      ])
    } catch (err) {
      console.warn(`[bridge] ${label} failed`, err)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
  const p = queue.then(run, run)
  queue = p
  return p
}

export async function storageGet(key: string): Promise<string> {
  if (!bridge) {
    try {
      return window.localStorage.getItem(key) ?? ''
    } catch {
      return ''
    }
  }
  return (await enqueue(`get ${key}`, (b) => b.getLocalStorage(key))) ?? ''
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (!bridge) {
    try {
      window.localStorage.setItem(key, value)
    } catch {
      /* ignore */
    }
    return
  }
  await enqueue(`set ${key}`, (b) => b.setLocalStorage(key, value))
}
