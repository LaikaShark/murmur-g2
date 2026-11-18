/**
 * Turn a Discord MESSAGE_CREATE payload into a single line of plain text that
 * the G2 firmware font can render: mentions resolved to names, custom emoji to
 * :name:, markdown stripped, attachments/embeds summarised.
 */

export function plainContent(
  msg: any,
  channelName: (id: string) => string | undefined,
  opts: { showSpoilers?: boolean } = {},
): string {
  const users = new Map<string, string>()
  for (const u of msg.mentions ?? []) users.set(u.id, u.member?.nick || u.global_name || u.username)

  let text: string = msg.content ?? ''

  text = text
    .replace(/<@!?(\d+)>/g, (_, id) => '@' + (users.get(id) ?? 'user'))
    .replace(/<@&(\d+)>/g, '@role')
    .replace(/<#(\d+)>/g, (_, id) => '#' + (channelName(id) ?? 'channel'))
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (_, s) => new Date(Number(s) * 1000).toLocaleString())
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    // Links: masked links keep their label; bare URLs become [image]/[video]/[gif]/[link]
    .replace(/\[([^\]]+)\]\(<?https?:[^)]+>?\)/g, '$1')
    .replace(URL_RE, (url) => linkTag(url))
    // Markdown
    .replace(/```[\w-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\|\|([\s\S]+?)\|\|/g, opts.showSpoilers ? '$1' : '[spoiler]')
    .replace(/\*\*([\s\S]+?)\*\*/g, '$1')
    .replace(/__([\s\S]+?)__/g, '$1')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/~~([\s\S]+?)~~/g, '$1')
    .replace(/^#{1,3}\s+/gm, '')
    .replace(/^(?:>>>|>) /gm, '') // quotes need a space after the > in Discord

  const extras: string[] = []
  for (const a of msg.attachments ?? []) {
    const type = String(a.content_type ?? '')
    extras.push(mediaTag(type.split('/')[0], a.filename ?? '') ?? '[file]')
  }
  if (msg.sticker_items?.length) extras.push(`[sticker ${msg.sticker_items[0].name}]`)
  if (!text.trim() && msg.embeds?.length) {
    const e = msg.embeds[0]
    extras.push(e.title || e.description ? `[${(e.title || e.description).slice(0, 80)}]` : '[embed]')
  }
  if (msg.poll) extras.push(`[poll ${msg.poll.question?.text ?? ''}]`)

  return collapseTags(
    [text, ...extras]
      .join(' ')
      .replace(/\s+/g, ' ') // keep each message on one logical line
      .trim(),
  )
}

const URL_RE = /\bhttps?:\/\/[^\s<>]+[^\s<>.,;:!?'")\]]/gi
/** Links at most this long (without scheme/www) are kept as text. */
const SHORT_LINK = 24

const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|avif|heic)$/i
const GIF_EXT = /\.gif$/i
const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|flac|opus)$/i
const GIF_HOSTS = /(^|\.)(tenor\.com|giphy\.com|gfycat\.com)$/i
const DISCORD_MEDIA_HOSTS = /^(cdn\.discordapp\.com|media\.discordapp\.net|images-ext-\d+\.discordapp\.net)$/i

function mediaTag(kind: string, path: string): string | null {
  if (kind === 'image' || IMAGE_EXT.test(path)) return GIF_EXT.test(path) ? '[gif]' : '[image]'
  if (GIF_EXT.test(path)) return '[gif]'
  if (kind === 'video' || VIDEO_EXT.test(path)) return '[video]'
  if (kind === 'audio' || AUDIO_EXT.test(path)) return '[audio]'
  return null
}

/** Replace a URL with a short tag, or keep it if it's short and not media. */
export function linkTag(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return url
  }
  const host = u.hostname.toLowerCase()
  const path = u.pathname.toLowerCase()
  const media = mediaTag('', path)
  if (media) return media
  if (GIF_HOSTS.test(host)) return '[gif]'
  if (DISCORD_MEDIA_HOSTS.test(host)) return '[file]'
  const bare = url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')
  return bare.length <= SHORT_LINK ? bare : '[link]'
}

/** "[image] [image] [image]" -> "[image x3]" */
function collapseTags(text: string): string {
  return text.replace(/(\[(?:image|gif|video|audio|file|link)\])(?:\s+\1)+/g, (run, tag: string) => {
    const n = run.split(tag).length - 1
    return `${tag.slice(0, -1)} x${n}]`
  })
}

export function authorName(msg: any): string {
  return msg.member?.nick || msg.author?.global_name || msg.author?.username || 'unknown'
}
