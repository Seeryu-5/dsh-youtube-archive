import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { decodeJsonishString, extractBalancedJson, formatClock, stripHtml } from './util.js'

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36'

const PAGE_HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

const MAX_DESCRIPTION = 4000

/**
 * Fetch text with Node's http client instead of undici: YouTube returns header
 * sets larger than undici's 16 KB limit (HeadersOverflowError), which silently
 * degraded metadata to oEmbed-only.
 */
export function fetchText(url, { timeoutMs = 12000, headers = PAGE_HEADERS, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(url)
    } catch {
      reject(new Error('invalid URL'))
      return
    }
    const request = target.protocol === 'http:' ? httpRequest : httpsRequest
    const req = request(
      target,
      {
        method: 'GET',
        headers: { 'Accept-Encoding': 'identity', ...headers },
        maxHeaderSize: 256 * 1024,
      },
      (res) => {
        const status = Number(res.statusCode ?? 0)
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume()
          if (redirects >= 4) {
            reject(new Error('too many redirects'))
            return
          }
          resolve(fetchText(new URL(res.headers.location, target).toString(), { timeoutMs, headers, redirects: redirects + 1 }))
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          reject(new Error(`HTTP ${status}`))
          return
        }
        const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
        let stream = res
        try {
          if (encoding.includes('br')) stream = res.pipe(createBrotliDecompress())
          else if (encoding.includes('gzip')) stream = res.pipe(createGunzip())
          else if (encoding.includes('deflate')) stream = res.pipe(createInflate())
        } catch {
          stream = res
        }
        const chunks = []
        let size = 0
        stream.on('data', (chunk) => {
          size += chunk.length
          if (size > 20 * 1024 * 1024) {
            req.destroy(new Error('response too large'))
            return
          }
          chunks.push(chunk)
        })
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        stream.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

function metaContent(html, attr, value) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']*)["']`, 'i')
  const match = re.exec(html)
  return match ? stripHtml(match[1]) : ''
}

function durationFromIso(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(value ?? ''))
  if (!match) return 0
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)
}

function collectKey(value, key, out = [], depth = 0) {
  if (depth > 30 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectKey(item, key, out, depth + 1)
    return out
  }
  if (Object.prototype.hasOwnProperty.call(value, key)) out.push(value[key])
  for (const child of Object.values(value)) collectKey(child, key, out, depth + 1)
  return out
}

function simpleTextOf(node) {
  if (!node) return ''
  if (typeof node === 'string') return node
  if (typeof node.simpleText === 'string') return node.simpleText
  if (Array.isArray(node.runs)) return node.runs.map((run) => run?.text ?? '').join('')
  if (typeof node.content === 'string') return node.content
  return ''
}

function findInitial(html, key) {
  for (const marker of [`${key} = `, `${key}=`, `window["${key}"] = `, `window.${key} = `]) {
    const value = extractBalancedJson(html, marker)
    if (value) return value
  }
  return null
}

/** Read the visible page's player/initial data and normalize video facts. */
export function parseWatchPage(html) {
  const result = {
    title: '',
    channel: '',
    durationSec: 0,
    description: '',
    chapters: [],
    keywords: [],
    published: '',
    isLive: false,
    captionTracks: [],
  }
  if (typeof html !== 'string' || !html) return result

  const player = findInitial(html, 'ytInitialPlayerResponse')
  const data = findInitial(html, 'ytInitialData')

  const details = player?.videoDetails ?? {}
  const micro = player?.microformat?.playerMicroformatRenderer ?? {}

  result.title = String(details.title ?? micro.title?.simpleText ?? '').trim()
  result.channel = String(details.author ?? micro.ownerChannelName ?? '').trim()
  result.durationSec = Number(details.lengthSeconds ?? 0) || 0
  result.isLive =
    details.isLiveContent === true ||
    details.isLive === true ||
    micro.liveBroadcastDetails?.isLiveNow === true
  result.published = String(micro.publishDate ?? micro.uploadDate ?? '').slice(0, 10)
  result.keywords = Array.isArray(details.keywords) ? details.keywords.map(String).slice(0, 20) : []

  const description = details.shortDescription ?? simpleTextOf(micro.description) ?? ''
  result.description = String(description).replace(/\r/g, '').trim().slice(0, MAX_DESCRIPTION)

  if (!result.title) result.title = metaContent(html, 'property', 'og:title')
  if (!result.title) {
    const match = /<title>([^<]*)<\/title>/i.exec(html)
    if (match) result.title = stripHtml(match[1]).replace(/\s*-\s*YouTube\s*$/i, '').trim()
  }
  if (/^YouTube$/i.test(result.title)) result.title = ''
  if (/^Enjoy the videos and music/i.test(result.description)) result.description = ''
  if (!result.channel) result.channel = metaContent(html, 'name', 'author')
  if (!result.description) result.description = metaContent(html, 'name', 'description').slice(0, MAX_DESCRIPTION)
  if (!result.durationSec) {
    const iso = /itemprop=["']duration["'][^>]*content=["']([^"']+)["']/i.exec(html)
    if (iso) result.durationSec = durationFromIso(iso[1])
  }
  if (!result.published) {
    const date = /"publishDate":"([^"]+)"/.exec(html)
    if (date) result.published = date[1].slice(0, 10)
  }

  function addChapters(items, startOf) {
    for (const item of items) {
      const title = simpleTextOf(item?.title).trim()
      const start = startOf(item)
      if (!title || !Number.isFinite(start) || start < 0) continue
      if (result.chapters.some((chapter) => chapter.startSec === start && chapter.title === title)) continue
      result.chapters.push({ title, startSec: Math.floor(start) })
    }
  }

  const chapterPanels = collectKey(data, 'macroMarkersListItemRenderer')
  addChapters(chapterPanels, (item) => {
    const seconds = item?.onTap?.innertubeCommand?.watchEndpoint?.startTimeSeconds
    if (Number.isFinite(Number(seconds))) return Number(seconds)
    const millis = Number(item?.timeRangeStartMillis)
    return Number.isFinite(millis) ? millis / 1000 : NaN
  })

  if (result.chapters.length === 0) {
    // Older/!ytInitialData pages sometimes only expose chapters in the raw JSON.
    const re = /"macroMarkersListItemRenderer":\{(.{0,2500}?)\}/gs
    let match
    while ((match = re.exec(html)) !== null) {
      const block = match[1]
      const title = /"title":\{"simpleText":"((?:[^"\\]|\\.)*)"/.exec(block)
      const start = /"startTimeSeconds":(\d+)/.exec(block) ?? /"timeRangeStartMillis":(\d+)/.exec(block)
      if (!title || !start) continue
      const seconds = /timeRangeStartMillis/.test(start[0]) ? Number(start[1]) / 1000 : Number(start[1])
      const name = decodeJsonishString(title[1]).trim()
      if (!name) continue
      if (result.chapters.some((chapter) => chapter.startSec === Math.floor(seconds))) continue
      result.chapters.push({ title: name, startSec: Math.floor(seconds) })
    }
  }

  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks
  if (Array.isArray(tracks)) {
    result.captionTracks = tracks
      .filter((track) => track && typeof track.baseUrl === 'string')
      .map((track) => ({
        baseUrl: track.baseUrl,
        lang: String(track.languageCode ?? ''),
        kind: String(track.kind ?? ''),
        name: simpleTextOf(track.name),
      }))
  }

  result.chapters.sort((a, b) => a.startSec - b.startSec)
  result.chapters = result.chapters.slice(0, 60)
  return result
}

export async function oEmbed(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
  const text = await fetchText(url, { timeoutMs: 8000 })
  const data = JSON.parse(text)
  return {
    title: String(data?.title ?? '').trim(),
    channel: String(data?.author_name ?? '').trim(),
    thumbnail: String(data?.thumbnail_url ?? ''),
  }
}

/**
 * Fetch metadata from oEmbed + the public watch page; never throws.
 * Falls back to whatever the extension already reported.
 */
export async function getVideoInfo(videoId, { fallbackTitle = '', fallbackChannel = '' } = {}) {
  const info = {
    videoId,
    title: String(fallbackTitle ?? '').trim(),
    channel: String(fallbackChannel ?? '').trim(),
    durationSec: 0,
    description: '',
    chapters: [],
    keywords: [],
    published: '',
    isLive: false,
    captionTracks: [],
    titleSource: fallbackTitle ? 'extension' : 'none',
    warnings: [],
  }

  try {
    const oembed = await oEmbed(videoId)
    if (oembed.title) {
      info.title = oembed.title
      info.titleSource = 'oembed'
    }
    if (oembed.channel) info.channel = oembed.channel
  } catch (error) {
    info.warnings.push(`oembed: ${error?.message ?? error}`)
  }

  try {
    const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, { timeoutMs: 15000 })
    const page = parseWatchPage(html)
    if (page.title) {
      info.title = page.title
      info.titleSource = 'watchpage'
    }
    for (const key of ['channel', 'description', 'published']) {
      if (page[key]) info[key] = page[key]
    }
    if (page.durationSec) info.durationSec = page.durationSec
    if (page.chapters.length) info.chapters = page.chapters
    if (page.keywords.length) info.keywords = page.keywords
    if (page.captionTracks.length) info.captionTracks = page.captionTracks
    info.isLive = page.isLive
  } catch (error) {
    info.warnings.push(`watchpage: ${error?.message ?? error}`)
  }

  if (!info.title && fallbackTitle) {
    info.title = fallbackTitle
    info.titleSource = 'extension'
  }
  if (!info.title) info.title = `YouTube 视频 ${videoId}`
  return info
}

function cleanCaptionLine(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Parse YouTube caption payloads (json3 or XML) into timed segments. */
export function parseCaptionPayload(body) {
  const text = String(body ?? '').trim()
  if (!text) return { segments: [], text: '' }

  let segments = []
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const data = JSON.parse(text)
      const events = Array.isArray(data?.events) ? data.events : []
      for (const event of events) {
        const startSec = Number(event?.tStartMs ?? event?.startMs ?? 0) / 1000
        const pieces = Array.isArray(event?.segs)
          ? event.segs.map((seg) => seg?.utf8 ?? '').join('')
          : String(event?.dText ?? '')
        const line = cleanCaptionLine(pieces)
        if (!line) continue
        segments.push({ startSec: Math.max(0, startSec), text: line })
      }
    } catch {
      segments = []
    }
  }

  if (!segments.length) {
    const re = /<text[^>]*start=["']([\d.]+)["'][^>]*>([\s\S]*?)<\/text>/g
    let match
    while ((match = re.exec(text)) !== null) {
      const line = cleanCaptionLine(match[2])
      if (!line) continue
      segments.push({ startSec: Number(match[1]) || 0, text: line })
    }
  }

  // Auto captions repeat rolling lines; drop exact consecutive duplicates.
  const deduped = []
  for (const segment of segments) {
    const previous = deduped[deduped.length - 1]
    if (previous && previous.text === segment.text) continue
    deduped.push(segment)
  }

  return { segments: deduped, text: formatTranscript(deduped) }
}

export function formatTranscript(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((segment) => segment && segment.text)
    .map((segment) => `[${formatClock(segment.startSec)}] ${segment.text}`)
    .join('\n')
}

function trackScore(track) {
  const lang = String(track.lang ?? '').toLowerCase()
  const manual = track.kind === 'asr' ? 1 : 0
  let langScore = 9
  if (lang.startsWith('zh-hans')) langScore = 0
  else if (lang.startsWith('zh-hant')) langScore = 1
  else if (lang.startsWith('zh')) langScore = 2
  else if (lang.startsWith('en')) langScore = 3
  return manual * 10 + langScore
}

/** Best-effort host-side transcript fetch; YouTube often blocks datacenter requests. */
export async function fetchTranscriptFromTracks(tracks, { maxTracks = 2 } = {}) {
  const candidates = (Array.isArray(tracks) ? [...tracks] : [])
    .filter((track) => track && typeof track.baseUrl === 'string')
    .sort((a, b) => trackScore(a) - trackScore(b))
    .slice(0, maxTracks)

  for (const track of candidates) {
    try {
      const url = new URL(track.baseUrl)
      url.searchParams.set('fmt', 'json3')
      const body = await fetchText(url.toString(), {
        timeoutMs: 10000,
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
          Referer: 'https://www.youtube.com/',
        },
      })
      const parsed = parseCaptionPayload(body)
      if (parsed.text.length > 40) {
        return { ...parsed, lang: track.lang, kind: track.kind === 'asr' ? 'asr' : 'manual', source: 'watchpage' }
      }
    } catch {
      /* try the next track */
    }
  }
  return null
}
