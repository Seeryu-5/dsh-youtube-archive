import { nowIso } from './util.js'

const EVENT_KINDS = new Set(['hello', 'meta', 'play', 'pause', 'seeked', 'heartbeat', 'ended', 'transcript', 'caption'])

/**
 * Accumulates real playback per tab+video and decides when a note should be
 * produced. The tracker is intentionally synchronous; note generation is
 * delegated to the caller (queue) so HTTP responses stay fast.
 */
export class Tracker {
  constructor({ config, store, onFinalize, onTranscript, now = () => Date.now() }) {
    this.config = config
    this.store = store
    this.onFinalize = typeof onFinalize === 'function' ? onFinalize : () => {}
    this.onTranscript = typeof onTranscript === 'function' ? onTranscript : () => {}
    this.now = now
    this.sessions = new Map()
    this.dirty = false
    this.lastHeartbeatAt = 0
  }

  isKnownKind(kind) {
    return EVENT_KINDS.has(kind)
  }

  /** Persist DOM metadata the extension read from the watch page. */
  storeExtensionMeta(event) {
    const videoId = String(event.videoId ?? '')
    if (!videoId) return
    const patch = {}
    if (typeof event.title === 'string' && event.title.trim()) patch.title = event.title.trim().slice(0, 300)
    if (typeof event.channel === 'string' && event.channel.trim()) patch.channel = event.channel.trim().slice(0, 200)
    if (Number.isFinite(Number(event.durationSec)) && Number(event.durationSec) > 0) {
      patch.durationSec = Number(event.durationSec)
    }
    if (typeof event.description === 'string' && event.description.trim()) {
      patch.extensionDescription = event.description.trim().slice(0, 4000)
    }
    if (Array.isArray(event.chapters)) {
      const chapters = event.chapters
        .filter((item) => item && typeof item.title === 'string' && Number.isFinite(Number(item.startSec)))
        .map((item) => ({ title: item.title.trim().slice(0, 200), startSec: Math.max(0, Math.floor(Number(item.startSec))) }))
        .slice(0, 60)
      if (chapters.length) patch.extensionChapters = chapters
    }
    if (typeof event.pageKind === 'string') patch.pageKind = event.pageKind
    if (Object.keys(patch).length) {
      this.store.upsertVideo(videoId, { ...patch, source: 'extension' })
      this.dirty = true
    }
  }

  handleEvent(event) {
    if (!event || typeof event !== 'object') return { ok: false, reason: 'invalid' }
    const kind = String(event.kind ?? '')
    if (!this.isKnownKind(kind)) return { ok: false, reason: 'kind' }

    this.lastHeartbeatAt = this.now()
    this.store.noteEvent(event)

    if (kind === 'hello') {
      this.store.state.extension = {
        version: String(event.extensionVersion ?? '').slice(0, 40),
        lastHelloAt: Date.now(),
      }
      this.storeExtensionMeta(event)
      return { ok: true, watchedSec: 0 }
    }

    if (kind === 'meta') {
      this.storeExtensionMeta(event)
      return { ok: true, watchedSec: 0 }
    }

    if (kind === 'transcript') {
      const videoId = String(event.videoId ?? '')
      const text = String(event.transcript?.text ?? '')
      if (videoId && text.trim()) {
        this.store.writeTranscript(videoId, {
          text,
          lang: event.transcript?.lang ?? '',
          kind: event.transcript?.kind ?? '',
          source: 'extension',
        })
        const rec = this.store.getVideo(videoId)
        // Notify before marking the cache as present so the callback can tell
        // whether the existing summary was produced without a transcript.
        try {
          this.onTranscript(videoId)
        } catch {
          /* ignore callback errors */
        }
        if (rec) {
          this.store.upsertVideo(videoId, { transcript: true })
          this.dirty = true
        }
      }
      return { ok: true, watchedSec: this.videoStats(videoId).totalWatchedSec }
    }

    if (kind === 'caption') {
      const videoId = String(event.videoId ?? '')
      if (!videoId) return { ok: false, reason: 'videoId' }
      const segments = Array.isArray(event.segments) ? event.segments.slice(0, 200) : []
      if (segments.length === 0) return { ok: true, watchedSec: this.videoStats(videoId).totalWatchedSec }
      this.store.appendTranscript(videoId, {
        segments,
        lang: event.lang ?? '',
        kind: 'live',
        source: 'live-dom',
      })
      this.store.upsertVideo(videoId, { transcript: true, liveCaptions: true })
      this.dirty = true
      return { ok: true, watchedSec: this.videoStats(videoId).totalWatchedSec }
    }

    const videoId = String(event.videoId ?? '')
    if (!videoId) return { ok: false, reason: 'videoId' }

    const tabId = Number.isFinite(Number(event.tabId)) ? Number(event.tabId) : 0
    const key = `${tabId}:${videoId}`

    // Navigating the same tab to another video closes the previous session.
    for (const [otherKey, other] of this.sessions) {
      if (other.tabId === tabId && other.videoId !== videoId) this.closeSession(otherKey, 'switch')
    }

    let session = this.sessions.get(key)
    if (!session) {
      session = {
        key,
        tabId,
        videoId,
        startedAt: this.now(),
        lastSeenAt: this.now(),
        lastPos: Math.max(0, Number(event.currentTime) || 0),
        watchedSec: 0,
        maxProgressSec: 0,
        durationSec: 0,
        title: '',
        channel: '',
        pageKind: String(event.pageKind || 'watch'),
        initialQueued: false,
        finalQueued: false,
      }
      this.sessions.set(key, session)
    }

    const now = this.now()
    const pos = Math.max(0, Number(event.currentTime) || 0)
    const duration = Math.max(0, Number(event.duration) || 0)
    const paused = event.paused === true
    const ended = event.ended === true || kind === 'ended'
    const muted = event.muted === true
    const visible = event.visible !== false
    const wallDelta = now - session.lastSeenAt
    const mediaDelta = pos - session.lastPos

    if (!paused && !ended && mediaDelta > 0 && mediaDelta <= 30 && wallDelta <= 120000) {
      const backgroundMuted = muted && !visible && this.config.skipMutedBackground
      if (!backgroundMuted) {
        const budget = duration > 0 ? Math.min(mediaDelta, Math.max(0, duration - session.watchedSec)) : mediaDelta
        session.watchedSec += Math.max(0, budget)
      }
    }

    session.lastPos = pos
    session.lastSeenAt = now
    session.maxProgressSec = Math.max(session.maxProgressSec, pos)
    session.durationSec = duration || session.durationSec
    session.title = String(event.title ?? session.title ?? '')
    session.channel = String(event.channel ?? session.channel ?? '')

    const rec = this.store.getVideo(videoId) ?? {}
    const stats = this.videoStats(videoId)
    this.store.upsertVideo(videoId, {
      title: session.title || rec.title || '',
      channel: session.channel || rec.channel || '',
      durationSec: session.durationSec || rec.durationSec || 0,
      firstWatchedAt: rec.firstWatchedAt || nowIso(),
      lastWatchedAt: nowIso(),
      maxProgressSec: Math.max(rec.maxProgressSec ?? 0, session.maxProgressSec),
      watchedSec: stats.totalWatchedSec,
      pageKind: session.pageKind,
      source: 'extension',
    })
    this.dirty = true

    const total = this.videoStats(videoId).totalWatchedSec
    const hasSummary = Boolean(this.store.getVideo(videoId)?.summaryStage)
    if (!session.initialQueued && total >= this.config.minWatchSeconds && !hasSummary) {
      session.initialQueued = true
      this.queueFinalize(videoId, 'initial', { kind: session.pageKind })
    }

    if (!session.finalQueued && (ended || (duration > 0 && pos / duration >= 0.9))) {
      session.finalQueued = true
      this.queueFinalize(videoId, 'final', { kind: session.pageKind })
    }

    if (ended) {
      this.closeSession(key, 'ended')
    }

    return { ok: true, watchedSec: this.videoStats(videoId).totalWatchedSec }
  }

  queueFinalize(videoId, stage, options = {}) {
    try {
      const result = this.onFinalize(videoId, stage, options)
      if (result && typeof result.catch === 'function') result.catch(() => {})
    } catch {
      /* note generation must never break ingest */
    }
  }

  /** Close sessions that stopped reporting, so short views still get archived. */
  tick() {
    const now = this.now()
    const idleMs = this.config.idleFinalizeMinutes * 60_000
    for (const [key, session] of [...this.sessions]) {
      if (now - session.lastSeenAt < idleMs) continue
      const total = this.videoStats(session.videoId).totalWatchedSec
      const rec = this.store.getVideo(session.videoId)
      const pageKind = rec?.pageKind || session.pageKind || 'watch'
      // A pending placeholder has summaryStage='初版' but no final content yet.
      // Queue final for pending/failed/stale notes; only skip when the final
      // pass already completed (ok) or the note is deliberately summary-free.
      const needsFinal = rec?.summaryStatus !== 'ok' && rec?.summaryStatus !== 'none'
      if (total >= this.config.minWatchSeconds && needsFinal) {
        this.queueFinalize(session.videoId, 'final', { kind: pageKind })
      }
      this.closeSession(key, 'idle')
    }
    if (this.dirty) this.flush()
  }

  closeSession(key, reason) {
    const session = this.sessions.get(key)
    if (!session) return
    const rec = this.store.getVideo(session.videoId) ?? {}
    const closed = (rec.closedWatchedSec ?? 0) + session.watchedSec
    const sessionsCount = (rec.watchSessions ?? 0) + (session.watchedSec >= 1 ? 1 : 0)
    this.store.upsertVideo(session.videoId, {
      closedWatchedSec: closed,
      watchSessions: sessionsCount,
      maxProgressSec: Math.max(rec.maxProgressSec ?? 0, session.maxProgressSec),
      watchedSec: closed,
      title: rec.title || session.title,
      channel: rec.channel || session.channel,
      durationSec: rec.durationSec || session.durationSec,
    })
    this.store.appendSession({
      videoId: session.videoId,
      tabId: session.tabId,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: new Date(this.now()).toISOString(),
      watchedSec: Math.round(session.watchedSec),
      maxProgressSec: Math.round(session.maxProgressSec),
      durationSec: Math.round(session.durationSec),
      reason,
    })
    this.sessions.delete(key)
    this.dirty = true
    this.flush()
  }

  /** Persist aggregate fields and state; called on a timer and on shutdown. */
  flush() {
    const active = new Map()
    for (const session of this.sessions.values()) {
      const current = active.get(session.videoId) ?? { watchedSec: 0, maxProgressSec: 0, count: 0 }
      current.watchedSec += session.watchedSec
      current.maxProgressSec = Math.max(current.maxProgressSec, session.maxProgressSec)
      current.count += session.watchedSec >= 1 ? 1 : 0
      active.set(session.videoId, current)
    }
    for (const rec of this.store.allVideos()) {
      const live = active.get(rec.videoId)
      const closed = rec.closedWatchedSec ?? 0
      const watched = closed + (live?.watchedSec ?? 0)
      if (rec.watchedSec !== watched) {
        rec.watchedSec = watched
        this.dirty = true
      }
      const maxProgress = Math.max(rec.maxProgressSec ?? 0, live?.maxProgressSec ?? 0)
      if (rec.maxProgressSec !== maxProgress) {
        rec.maxProgressSec = maxProgress
        this.dirty = true
      }
      if (rec.activeWatchedSec !== (live?.watchedSec ?? 0)) {
        rec.activeWatchedSec = live?.watchedSec ?? 0
        this.dirty = true
      }
    }
    if (this.dirty) {
      this.dirty = false
      this.store.save()
    }
  }

  videoStats(videoId) {
    const rec = this.store.getVideo(videoId) ?? {}
    let activeWatched = 0
    let activeMax = 0
    let activeCount = 0
    for (const session of this.sessions.values()) {
      if (session.videoId !== videoId) continue
      activeWatched += session.watchedSec
      activeMax = Math.max(activeMax, session.maxProgressSec)
      if (session.watchedSec >= 1) activeCount++
    }
    return {
      totalWatchedSec: (rec.closedWatchedSec ?? 0) + activeWatched,
      maxProgressSec: Math.max(rec.maxProgressSec ?? 0, activeMax),
      watchSessions: (rec.watchSessions ?? 0) + activeCount,
    }
  }

  closeAll(reason = 'shutdown') {
    for (const key of [...this.sessions.keys()]) this.closeSession(key, reason)
    this.flush()
  }

  snapshot() {
    return {
      activeSessions: this.sessions.size,
      lastHeartbeatAt: this.lastHeartbeatAt,
      videos: this.store.allVideos().length,
    }
  }
}
