import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { appendJsonLine, atomicWrite, formatClock, nowIso, readJson } from './util.js'
import { compactLines, lineBody, normalizeTimeline } from './transcript.js'

const STATE_VERSION = 1

function emptyState() {
  return {
    version: STATE_VERSION,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    port: null,
    lastEventAt: 0,
    lastHeartbeatAt: 0,
    extension: { version: '', lastHelloAt: 0 },
    videos: {},
  }
}

/**
 * Persistent state + transcript/session log storage.
 * All writes are atomic; a corrupt state file is moved aside instead of crashing.
 */
export function createStore(config) {
  const outputDir = config.outputDir
  const stateDir = join(outputDir, '.state')
  const transcriptsDir = join(stateDir, 'transcripts')
  const translationsDir = join(stateDir, 'translations')
  const cleanedDir = join(stateDir, 'cleaned')
  const summariesDir = join(stateDir, 'summaries')
  const statePath = join(stateDir, 'state.json')
  const sessionsPath = join(stateDir, 'sessions.jsonl')
  const logPath = join(stateDir, 'ingest.log')

  mkdirSync(transcriptsDir, { recursive: true })
  mkdirSync(translationsDir, { recursive: true })
  mkdirSync(cleanedDir, { recursive: true })
  mkdirSync(summariesDir, { recursive: true })

  let state = loadState()

  function loadState() {
    const loaded = readJson(statePath, null)
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) || loaded.version !== STATE_VERSION) {
      if (loaded !== null && existsSync(statePath)) {
        try {
          renameSync(statePath, join(stateDir, `state.corrupt-${Date.now()}.json`))
        } catch {
          /* ignore */
        }
      }
      return emptyState()
    }
    if (!loaded.videos || typeof loaded.videos !== 'object' || Array.isArray(loaded.videos)) loaded.videos = {}
    if (!loaded.extension || typeof loaded.extension !== 'object') loaded.extension = { version: '', lastHelloAt: 0 }
    for (const key of ['lastEventAt', 'lastHeartbeatAt']) {
      if (typeof loaded[key] !== 'number') loaded[key] = 0
    }
    if (typeof loaded.port !== 'number') loaded.port = null
    return loaded
  }

  function save() {
    state.updatedAt = nowIso()
    atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }

  function getVideo(videoId) {
    return state.videos[videoId] ?? null
  }

  function upsertVideo(videoId, patch) {
    const previous = state.videos[videoId] ?? { videoId, createdAt: nowIso() }
    const next = { ...previous, ...patch, videoId, updatedAt: nowIso() }
    state.videos[videoId] = next
    return next
  }

  function allVideos() {
    return Object.values(state.videos)
  }

  function noteEvent(event) {
    state.lastEventAt = Date.now()
    state.lastHeartbeatAt = Date.now()
    if (event?.kind === 'hello' || event?.kind === 'heartbeat') {
      state.lastHeartbeatAt = Date.now()
    }
  }

  function transcriptPath(videoId) {
    return join(transcriptsDir, `${videoId}.json`)
  }

  function writeTranscript(videoId, payload) {
    const text = normalizeTimeline(String(payload?.text ?? ''))
    if (!text.trim()) return false
    atomicWrite(
      transcriptPath(videoId),
      `${JSON.stringify(
        {
          videoId,
          lang: payload.lang ?? '',
          kind: payload.kind ?? '',
          source: payload.source ?? 'extension',
          chars: [...text].length,
          updatedAt: nowIso(),
          text,
        },
        null,
        2,
      )}\n`,
    )
    return true
  }

  function readTranscript(videoId) {
    const data = readJson(transcriptPath(videoId), null)
    if (!data || typeof data.text !== 'string' || !data.text.trim()) return null
    return data
  }

  /**
   * Append live caption segments to the cached transcript.
   * Native-track transcripts (source != live-dom) win over partial DOM scraping.
   */
  function appendTranscript(videoId, payload) {
    const incomingSource = String(payload?.source ?? 'live-dom')
    const existing = readTranscript(videoId)
    if (existing && incomingSource === 'live-dom' && existing.source !== 'live-dom' && existing.text.length > 200) {
      return existing
    }
    const existingText = existing?.text ? `${existing.text}\n` : ''
    const lines = []
    if (Array.isArray(payload?.segments)) {
      for (const segment of payload.segments) {
        const text = String(segment?.text ?? '').replace(/\s+/g, ' ').trim()
        if (!text) continue
        const seconds = Math.max(0, Math.floor(Number(segment?.startSec) || 0))
        lines.push(`[${formatClock(seconds)}] ${text}`)
      }
    } else if (typeof payload?.text === 'string') {
      lines.push(...payload.text.split('\n').map((line) => line.trim()).filter(Boolean))
    }
    if (lines.length === 0) return existing

    const recent = new Set(
      existingText
        .split('\n')
        .slice(-50)
        .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
        .filter(Boolean),
    )
    const appended = []
    for (const line of lines) {
      const body = lineBody(line)
      if (!body || recent.has(body)) continue
      recent.add(body)
      appended.push(line)
    }
    if (appended.length === 0) return existing

    let text = normalizeTimeline(compactLines(`${existingText}${appended.join('\n')}`.split('\n')).join('\n'))
    if ([...text].length > 500000) text = [...text].slice(-500000).join('')
    const next = {
      videoId,
      lang: payload?.lang || existing?.lang || '',
      kind: payload?.kind || existing?.kind || 'live',
      source: incomingSource,
      chars: [...text].length,
      updatedAt: nowIso(),
      text,
    }
    atomicWrite(transcriptPath(videoId), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  function translationPath(videoId) {
    return join(translationsDir, `${videoId}.json`)
  }

  function readTranslation(videoId) {
    return readJson(translationPath(videoId), null)
  }

  function readClean(videoId) {
    return readJson(join(cleanedDir, `${videoId}.json`), null)
  }

  function readSummary(videoId) {
    return readJson(join(summariesDir, `${videoId}.json`), null)
  }

  function writeSummary(videoId, summary) {
    atomicWrite(join(summariesDir, `${videoId}.json`), `${JSON.stringify({ videoId, updatedAt: nowIso(), summary }, null, 2)}\n`)
  }

  function writeClean(videoId, data) {
    atomicWrite(join(cleanedDir, `${videoId}.json`), `${JSON.stringify({ videoId, updatedAt: nowIso(), ...data }, null, 2)}\n`)
  }

  function writeTranslation(videoId, data) {
    atomicWrite(translationPath(videoId), `${JSON.stringify({ videoId, updatedAt: nowIso(), ...data }, null, 2)}\n`)
  }

  function compactTranscript(videoId) {
    const data = readTranscript(videoId)
    if (!data) return null
    const original = data.text.split('\n').filter((line) => line.trim())
    const normalized = normalizeTimeline(data.text).split('\n').filter((line) => line.trim())
    const compacted = compactLines(normalized)
    if (compacted.length === original.length && compacted.every((line, index) => line === original[index])) {
      return data
    }
    const text = compacted.join('\n')
    return updateTranscript(videoId, { text, chars: [...text].length })
  }

  function updateTranscript(videoId, patch) {
    const data = readTranscript(videoId)
    if (!data) return null
    const next = { ...data, ...patch, updatedAt: nowIso() }
    atomicWrite(transcriptPath(videoId), `${JSON.stringify(next, null, 2)}\n`)
    return next
  }

  function appendSession(session) {
    try {
      appendFileSync(sessionsPath, `${JSON.stringify({ ts: nowIso(), ...session })}\n`, 'utf8')
    } catch {
      /* ignore */
    }
  }

  function log(entry) {
    appendJsonLine(logPath, entry)
  }

  return {
    config,
    outputDir,
    stateDir,
    transcriptsDir,
    translationsDir,
    cleanedDir,
    summariesDir,
    statePath,
    sessionsPath,
    logPath,
    get state() {
      return state
    },
    save,
    getVideo,
    upsertVideo,
    allVideos,
    noteEvent,
    writeTranscript,
    readTranscript,
    appendTranscript,
    compactTranscript,
    updateTranscript,
    readTranslation,
    writeTranslation,
    readClean,
    writeClean,
    readSummary,
    writeSummary,
    appendSession,
    log,
  }
}
