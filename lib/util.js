import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Expand a leading `~` without touching other characters. */
export function expandHome(input) {
  if (typeof input !== 'string' || input.length === 0) return input
  if (input === '~') return homedir()
  if (input.startsWith('~/')) return join(homedir(), input.slice(2))
  return input
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/** Write a file atomically (same-directory temp file then rename). */
export function atomicWrite(path, text) {
  ensureDir(dirname(path))
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, path)
}

export function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function nowIso() {
  return new Date().toISOString()
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** `mm:ss` for under an hour, `h:mm:ss` above. */
export function formatClock(input) {
  const sec = Math.max(0, Math.floor(Number(input) || 0))
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}

/** Parse `1:02:03`, `2:03` or a raw second count. Returns null when invalid. */
export function parseClock(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.floor(input))
  const text = String(input ?? '').trim()
  if (!/^\d{1,2}(?::\d{1,2}){0,2}$/.test(text)) return null
  const parts = text.split(':').map((x) => Number(x))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0] * 3600 + parts[1] * 60 + parts[2]
}

export function formatDurationText(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0))
  if (total < 60) return `${total} 秒`
  const h = Math.floor(total / 3600)
  const m = Math.round((total % 3600) / 60)
  if (h > 0 && m > 0) return `${h} 小时 ${m} 分钟`
  if (h > 0) return `${h} 小时`
  return `${m} 分钟`
}

export function localDateString(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date)
  if (Number.isNaN(d.getTime())) return localDateString(new Date())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Filesystem-safe segment; keeps Chinese characters, strips path/reserved chars. */
export function sanitizeFilename(input, max = 80) {
  let text = String(input ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  text = text.replace(/^[.\s]+|[.\s]+$/g, '')
  if (!text) text = 'video'
  const chars = [...text]
  if (chars.length > max) text = chars.slice(0, max).join('').trim()
  return text || 'video'
}

const YT_ID = /^[A-Za-z0-9_-]{6,20}$/

/** Parse a YouTube URL or a bare video id into `{ videoId, kind, url }`. */
export function parseYouTubeUrl(input) {
  const text = String(input ?? '').trim()
  if (!text) return null
  if (YT_ID.test(text) && !text.includes('/') && !text.includes('.')) {
    return { videoId: text, kind: 'watch', url: `https://www.youtube.com/watch?v=${text}` }
  }
  let raw = text
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^www\./, '').toLowerCase()
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
    return YT_ID.test(id) ? { videoId: id, kind: 'watch', url: `https://www.youtube.com/watch?v=${id}` } : null
  }
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com' && host !== 'youtube-nocookie.com') {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean)
  let kind = 'watch'
  let id = ''
  if (parts[0] === 'watch') {
    id = url.searchParams.get('v') ?? ''
    kind = 'watch'
  } else if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
    id = parts[1] ?? ''
    kind = parts[0]
  }
  if (!YT_ID.test(id)) return null
  return { videoId: id, kind, url: `https://www.youtube.com/watch?v=${id}` }
}

/**
 * Find `marker` in a page and decode the balanced JSON object that follows it.
 * Handles braces inside strings/escapes; returns null when not found/valid.
 */
export function extractBalancedJson(text, marker) {
  if (typeof text !== 'string' || !text || typeof marker !== 'string' || !marker) return null
  const at = text.indexOf(marker)
  if (at === -1) return null
  const start = text.indexOf('{', at + marker.length)
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** Decode a JSON-escaped inner string captured by a regex (best effort). */
export function decodeJsonishString(value) {
  const text = String(value ?? '')
  try {
    return JSON.parse(`"${text.replace(/\n/g, '\\n')}"`)
  } catch {
    return text
  }
}

export function stripHtml(input) {
  return String(input ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

export function appendJsonLine(path, value) {
  try {
    ensureDir(dirname(path))
    appendFileSync(path, `${JSON.stringify({ ts: nowIso(), ...value })}\n`, 'utf8')
  } catch {
    /* logging must never break the plugin */
  }
}

export function fileExists(path) {
  return existsSync(path)
}
