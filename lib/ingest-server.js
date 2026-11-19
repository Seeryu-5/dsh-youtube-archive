import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { candidatePorts } from './config.js'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const ALLOWED_KINDS = new Set(['hello', 'meta', 'play', 'pause', 'seeked', 'heartbeat', 'ended', 'transcript', 'caption'])
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url))

const STATIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/app.js', 'app.js'],
  ['/styles.css', 'styles.css'],
  ['/favicon.svg', 'favicon.svg'],
])

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        const error = new Error('payload too large')
        error.code = 'TOO_LARGE'
        reject(error)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function validateEvent(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return '请求体必须是 JSON 对象'
  if (payload.schema !== undefined && payload.schema !== 1) return '不支持的 schema'
  const kind = String(payload.kind ?? '')
  if (!ALLOWED_KINDS.has(kind)) return `未知事件类型：${kind || '(空)'}`
  if (kind !== 'hello' || payload.videoId !== undefined) {
    const videoId = String(payload.videoId ?? '')
    if (!VIDEO_ID.test(videoId)) return 'videoId 不合法'
  }
  if (kind === 'transcript') {
    const text = payload.transcript?.text
    if (typeof text !== 'string' || !text.trim()) return 'transcript.text 不能为空'
  }
  if (kind === 'caption') {
    if (!Array.isArray(payload.segments) || payload.segments.length === 0) return 'caption.segments 不能为空'
    if (payload.segments.length > 200) return 'caption.segments 过多'
    for (const segment of payload.segments) {
      if (!segment || typeof segment.text !== 'string' || !segment.text.trim()) return 'caption.segment.text 不能为空'
      if (!Number.isFinite(Number(segment.startSec))) return 'caption.segment.startSec 必须是数字'
    }
  }
  for (const key of ['currentTime', 'duration']) {
    if (payload[key] !== undefined && !Number.isFinite(Number(payload[key]))) return `${key} 必须是数字`
  }
  return null
}

function serveStatic(req, res, pathname) {
  const name = STATIC_FILES.get(pathname)
  if (!name) return false
  try {
    const body = readFileSync(join(WEB_DIR, name))
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(name)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    res.end(body)
  } catch (error) {
    sendJson(res, 500, { ok: false, error: `UI 资源缺失：${name}` })
  }
  return true
}

/** Loopback UI may POST only from itself; the extension may post from its own origin. */
function originAllowed(req) {
  const origin = String(req.headers.origin ?? '')
  if (!origin) return true
  if (origin.startsWith('chrome-extension://')) return true
  const port = req.socket?.localPort ?? 0
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}

/**
 * Local HTTP server bound to loopback only.
 *
 * - `POST /api/events` accepts extension playback events (custom header required).
 * - `GET /` and static assets serve the archive browser UI.
 * - `GET /api/notes`, `GET /api/note?path=`, `POST /api/reveal` back the UI.
 */
export async function startIngestServer({
  config,
  onEvent,
  getHealth = () => ({}),
  log = () => {},
  api = {},
}) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    try {
      if (req.method === 'OPTIONS') return sendJson(res, 403, { ok: false, error: 'CORS disabled' })

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return sendJson(res, 200, {
          ok: true,
          name: 'dsh-youtube-archive',
          version: '0.4.4',
          port: req.socket?.localPort ?? config.port,
          ...getHealth(),
        })
      }

      if (req.method === 'GET' && url.pathname === '/api/notes') {
        if (typeof api.listNotes !== 'function') return sendJson(res, 404, { ok: false, error: 'UI API unavailable' })
        const data = await api.listNotes()
        return sendJson(res, 200, { ok: true, ...data })
      }

      if (req.method === 'GET' && url.pathname === '/api/note') {
        if (typeof api.readNote !== 'function') return sendJson(res, 404, { ok: false, error: 'UI API unavailable' })
        try {
          const note = await api.readNote(url.searchParams.get('path'))
          return sendJson(res, 200, { ok: true, ...note })
        } catch (error) {
          return sendJson(res, Number(error?.status) || 400, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/reveal') {
        if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
        if (req.headers['x-dsh-archive'] !== '1') {
          return sendJson(res, 403, { ok: false, error: 'missing X-DSH-Archive header' })
        }
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        }
        if (typeof api.reveal !== 'function') return sendJson(res, 404, { ok: false, error: 'UI API unavailable' })
        let payload = {}
        try {
          payload = JSON.parse(await readBody(req, 64 * 1024))
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
        }
        try {
          const result = await api.reveal(payload?.path)
          log({ type: 'reveal', path: String(payload?.path ?? '') })
          return sendJson(res, 200, { ok: true, ...result })
        } catch (error) {
          return sendJson(res, Number(error?.status) || 400, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'POST' && ['/api/retry', '/api/summarize', '/api/translate'].includes(url.pathname)) {
        if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
        if (req.headers['x-dsh-archive'] !== '1') {
          return sendJson(res, 403, { ok: false, error: 'missing X-DSH-Archive header' })
        }
        if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
        }
        if (typeof api.retry !== 'function') return sendJson(res, 404, { ok: false, error: 'retry unavailable' })
        let payload = {}
        try {
          payload = JSON.parse(await readBody(req, 64 * 1024))
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
        }
        const videoId = String(payload?.videoId ?? '')
        if (!VIDEO_ID.test(videoId)) return sendJson(res, 400, { ok: false, error: 'videoId 不合法' })
        try {
          if (url.pathname === '/api/summarize') {
            if (typeof api.summarize !== 'function') return sendJson(res, 404, { ok: false, error: 'summarize unavailable' })
            await api.summarize(videoId)
            log({ type: 'summarize-request', videoId })
          } else if (url.pathname === '/api/translate') {
            if (typeof api.translate !== 'function') return sendJson(res, 404, { ok: false, error: 'translate unavailable' })
            await api.translate(videoId)
            log({ type: 'translate-request', videoId })
          } else {
            await api.retry(videoId)
            log({ type: 'retry', videoId })
          }
          return sendJson(res, 200, { ok: true, queued: true })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      }

      if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return

      if (req.method !== 'POST' || url.pathname !== '/api/events') {
        return sendJson(res, 404, { ok: false, error: 'not found' })
      }

      if (req.headers['x-dsh-archive'] !== '1') {
        return sendJson(res, 403, { ok: false, error: 'missing X-DSH-Archive header' })
      }
      if (!originAllowed(req)) {
        return sendJson(res, 403, { ok: false, error: 'origin not allowed' })
      }
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) {
        return sendJson(res, 415, { ok: false, error: 'content-type must be application/json' })
      }

      let payload
      try {
        payload = JSON.parse(await readBody(req, MAX_BODY_BYTES))
      } catch (error) {
        if (error?.code === 'TOO_LARGE') return sendJson(res, 413, { ok: false, error: 'payload too large' })
        return sendJson(res, 400, { ok: false, error: 'invalid JSON' })
      }

      const problem = validateEvent(payload)
      if (problem) return sendJson(res, 400, { ok: false, error: problem })

      const result = await onEvent(payload)
      log({
        type: 'ingest',
        kind: payload.kind,
        videoId: payload.videoId ?? '',
        tabId: payload.tabId ?? null,
        watchedSec: Math.round(Number(result?.watchedSec ?? 0)),
        chars: payload.kind === 'transcript' ? String(payload.transcript?.text ?? '').length : undefined,
      })
      return sendJson(res, 200, {
        ok: true,
        port: req.socket?.localPort ?? config.port,
        watchedSec: Math.round(Number(result?.watchedSec ?? 0)),
      })
    } catch (error) {
      log({ type: 'error', path: url.pathname, message: String(error?.message ?? error) })
      return sendJson(res, 500, { ok: false, error: 'internal error' })
    }
  }

  const ports = candidatePorts(config)
  let lastError = null
  for (const port of ports) {
    const server = createServer(handler)
    server.keepAliveTimeout = 5000
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.removeListener('error', onError)
          resolve()
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(port, '127.0.0.1')
      })
      return { server, port }
    } catch (error) {
      lastError = error
      server.close()
      if (error?.code !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`无法绑定 127.0.0.1 端口（${ports[0]}~${ports[ports.length - 1]}）：${lastError?.message ?? '未知错误'}`)
}
