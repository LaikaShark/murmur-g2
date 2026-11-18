/**
 * PluralKit (and Tupperbox-style) proxy detection.
 *
 * Proxy bots work by deleting the user's original message within a second or
 * so and reposting it through a webhook under the member's name. A server is
 * marked as a proxy server once a freshly-sent message is deleted and a webhook
 * message appears in the same channel within a few seconds of each other.
 */

const WINDOW_MS = 5000
const DISCORD_EPOCH = 1420070400000n

/** Creation time encoded in a Discord snowflake id. */
export function snowflakeTime(id: string): number {
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH)
  } catch {
    return 0
  }
}

const recentDeletes = new Map<string, number>() // channel -> time of last quick delete
const recentWebhooks = new Map<string, number>() // channel -> time of last webhook message

/** A message was deleted. Returns true if this pairs up with a webhook repost (proxy behaviour). */
export function noteDelete(channelId: string, messageId: string, now = Date.now()): boolean {
  if (now - snowflakeTime(messageId) > WINDOW_MS) return false // not a fresh message
  const hook = recentWebhooks.get(channelId)
  if (hook && now - hook < WINDOW_MS) return true
  recentDeletes.set(channelId, now)
  return false
}

/** A webhook message arrived. Returns true if a fresh message was just deleted in this channel. */
export function noteWebhookMessage(channelId: string, now = Date.now()): boolean {
  const del = recentDeletes.get(channelId)
  if (del && now - del < WINDOW_MS) return true
  recentWebhooks.set(channelId, now)
  return false
}
