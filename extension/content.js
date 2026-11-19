(() => {
  'use strict'

  const SOURCE = 'dsh-yt-archive'
  const HEARTBEAT_MS = 5000
  const TRANSCRIPT_MIN_SECONDS = 10

  const state = {
    videoId: '',
    pageKind: '',
    lastSentAt: 0,
    lastPos: 0,
    transcriptRequestedFor: '',
    transcriptSentFor: '',
    metaSentFor: '',
    monitoringPaused: false,
    nativeTranscript: false,
    pendingCaptions: [],
    lastCaptionFlush: 0,
    captionSeen: new Set(),
    recentCaptionBodies: [],
    captionObserverStarted: false,
  }

  let boundVideo = null

  function sendMessage(message) {
    try {
      const pending = chrome.runtime.sendMessage(message)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch {
      /* extension context may be reloading */
    }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get({ paused: false }, (value) => {
        state.monitoringPaused = value && value.paused === true
      })
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.paused) state.monitoringPaused = changes.paused.newValue === true
      })
    } catch {
      /* ignore */
    }
  }

  function parsePage() {
    let url
    try {
      url = new URL(location.href)
    } catch {
      return { id: '', kind: 'other' }
    }
    if (url.pathname === '/watch') {
      return { id: (url.searchParams.get('v') || '').trim(), kind: 'watch' }
    }
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts[0] === 'shorts') return { id: (parts[1] || '').trim(), kind: 'shorts' }
    if (parts[0] === 'live') return { id: (parts[1] || '').trim(), kind: 'live' }
    if (parts[0] === 'embed') return { id: (parts[1] || '').trim(), kind: 'embed' }
    return { id: '', kind: 'other' }
  }

  function validId(id) {
    return /^[A-Za-z0-9_-]{6,20}$/.test(String(id || ''))
  }

  function getVideo() {
    return document.querySelector('video.html5-main-video') || document.querySelector('video')
  }

  function pageTitle() {
    const element =
      document.querySelector('h1.ytd-watch-metadata yt-formatted-string') ||
      document.querySelector('h1.title yt-formatted-string') ||
      document.querySelector('#title h1') ||
      document.querySelector('.ytShortsVideoTitleViewModelShortsVideoTitle')
    const text = element && element.textContent ? element.textContent.trim() : ''
    if (text) return text
    return String(document.title || '')
      .replace(/\s*-\s*YouTube\s*$/i, '')
      .trim()
  }

  function pageChannel() {
    const element =
      document.querySelector('#owner #channel-name a') ||
      document.querySelector('#channel-name a') ||
      document.querySelector('ytd-channel-name a') ||
      document.querySelector('a.yt-simple-endpoint.style-scope.yt-formatted-string')
    return element && element.textContent ? element.textContent.trim() : ''
  }

  function parseClockText(input) {
    const match = /^(?:(\d+):)?(\d{1,2}):(\d{2})$/.exec(String(input || '').trim())
    if (!match) return null
    const hours = Number(match[1] || 0)
    const minutes = Number(match[2])
    const seconds = Number(match[3])
    if (minutes > 59 || seconds > 59) return null
    return hours * 3600 + minutes * 60 + seconds
  }

  function pageDescription() {
    const element =
      document.querySelector('#description-inline-expander yt-attributed-string') ||
      document.querySelector('ytd-text-inline-expander#description-inline-expander') ||
      document.querySelector('#description-inline-expander') ||
      document.querySelector('#description')
    let text = element ? String(element.textContent || '').trim() : ''
    text = text.replace(/\s*(Show more|Show less|显示更多|显示较少|收起)\s*$/gi, '').trim()
    return text.slice(0, 4000)
  }

  function pageChapters() {
    const chapters = []
    for (const element of document.querySelectorAll('ytd-macro-markers-list-item-renderer')) {
      const titleElement = element.querySelector('#details h4, #details yt-formatted-string, h4')
      const timeElement = element.querySelector('#time, ytd-thumbnail-overlay-time-status-renderer')
      const title = titleElement ? String(titleElement.textContent || '').trim() : ''
      const seconds = parseClockText(timeElement ? timeElement.textContent : '')
      if (!title || seconds === null) continue
      if (chapters.some((chapter) => chapter.startSec === seconds)) continue
      chapters.push({ title: title.slice(0, 200), startSec: seconds })
      if (chapters.length >= 60) break
    }
    return chapters
  }

  function isAdPlaying() {
    return Boolean(
      document.querySelector('.html5-video-player.ad-showing') ||
        document.querySelector('.ytp-ad-player-overlay'),
    )
  }

  /* ---------- live captions (YouTube auto/CC overlay) ---------- */

  const CAPTION_SEGMENT_SELECTOR = '.ytp-caption-segment'
  const CAPTION_WINDOW_SELECTOR =
    '.ytp-caption-window-container .caption-window, .ytp-caption-window-rollup, .ytp-caption-window-container'

  function normalizeCaption(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
  }

  function pushCaption(text, startSec) {
    const body = normalizeCaption(text)
    if (body.length < 2) return
    if (state.captionSeen.has(body)) return

    let delta = body
    for (const previous of state.recentCaptionBodies) {
      if (previous.length >= 6 && body.startsWith(previous) && body.length > previous.length) {
        delta = body.slice(previous.length).trim()
        break
      }
    }
    state.recentCaptionBodies.push(body)
    if (state.recentCaptionBodies.length > 10) state.recentCaptionBodies.shift()
    if (delta.length >= 2 && !state.captionSeen.has(delta)) {
      state.pendingCaptions.push({ startSec: Math.max(0, Math.floor(startSec)), text: delta.slice(0, 400) })
    }
    state.captionSeen.add(delta)
    state.captionSeen.add(body)
    if (state.captionSeen.size > 1200) {
      state.captionSeen = new Set([...state.captionSeen].slice(-600))
    }
  }

  function captionRoots() {
    const roots = [document]
    const walk = (root, depth) => {
      if (depth > 3) return
      for (const element of root.querySelectorAll('*')) {
        if (!element.shadowRoot) continue
        roots.push(element.shadowRoot)
        walk(element.shadowRoot, depth + 1)
      }
    }
    for (const host of document.querySelectorAll('#movie_player, ytd-player, #player-container')) {
      if (host.shadowRoot) {
        roots.push(host.shadowRoot)
        walk(host.shadowRoot, 1)
      }
    }
    return roots
  }

  function readCaptionSegments() {
    const elements = []
    for (const root of captionRoots()) {
      try {
        elements.push(...root.querySelectorAll(CAPTION_SEGMENT_SELECTOR))
      } catch {
        /* ignore */
      }
    }
    return elements
  }

  function readCaptionWindows() {
    const elements = []
    for (const root of captionRoots()) {
      try {
        elements.push(...root.querySelectorAll(CAPTION_WINDOW_SELECTOR))
      } catch {
        /* ignore */
      }
    }
    return elements
  }

  function scanCaptions() {
    if (state.monitoringPaused || state.nativeTranscript) return
    const page = parsePage()
    const video = getVideo()
    if (!validId(page.id) || !video || isAdPlaying()) return

    const segments = readCaptionSegments()
    if (segments.length) {
      for (const element of segments) {
        const text = element.textContent || ''
        if (text.trim()) pushCaption(text, video.currentTime)
      }
    } else {
      const windows = readCaptionWindows()
      for (const windowElement of windows) {
        const lines = String(windowElement.innerText || windowElement.textContent || '')
          .split('\n')
          .map(normalizeCaption)
          .filter(Boolean)
        if (lines.length) pushCaption(lines[lines.length - 1], video.currentTime)
      }
    }

    const now = Date.now()
    if (
      state.pendingCaptions.length >= 12 ||
      (state.pendingCaptions.length > 0 && now - state.lastCaptionFlush >= 5000)
    ) {
      flushCaptions()
    }
  }

  function flushCaptions(force = false) {
    if (!state.pendingCaptions.length) return
    if (!force && Date.now() - state.lastCaptionFlush < 4000) return
    const page = parsePage()
    if (!validId(page.id)) return
    const segments = state.pendingCaptions.splice(0, 200)
    state.lastCaptionFlush = Date.now()
    sendMessage({
      type: 'dsh-archive-event',
      event: {
        schema: 1,
        kind: 'caption',
        videoId: page.id,
        url: `https://www.youtube.com/watch?v=${page.id}`,
        lang: '',
        segments,
        ts: Date.now(),
      },
    })
  }

  let captionScanTimer = null
  function scheduleCaptionScan() {
    if (captionScanTimer) return
    captionScanTimer = setTimeout(() => {
      captionScanTimer = null
      scanCaptions()
    }, 250)
  }

  function startCaptionObserver() {
    if (state.captionObserverStarted) return
    state.captionObserverStarted = true
    try {
      const observer = new MutationObserver(scheduleCaptionScan)
      observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    } catch {
      /* ignore */
    }
    setInterval(scanCaptions, 2000)
  }

  function sendEvent(kind, extra = {}) {
    if (state.monitoringPaused) return
    const page = parsePage()
    const video = getVideo()
    if (!validId(page.id) || !video) return
    const now = Date.now()
    const event = {
      schema: 1,
      kind,
      pageKind: page.kind,
      videoId: page.id,
      url: `https://www.youtube.com/watch?v=${page.id}`,
      title: pageTitle(),
      channel: pageChannel(),
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
      paused: Boolean(video.paused),
      ended: Boolean(video.ended),
      muted: Boolean(video.muted),
      visible: document.visibilityState === 'visible',
      rate: Number.isFinite(video.playbackRate) ? video.playbackRate : 1,
      ts: now,
      ...extra,
    }
    sendMessage({ type: 'dsh-archive-event', event })
    state.lastSentAt = now
    state.lastPos = event.currentTime
  }

  function maybeHeartbeat() {
    if (state.monitoringPaused) return
    const video = getVideo()
    if (!video || video.paused || video.ended || isAdPlaying()) return
    if (Date.now() - state.lastSentAt < HEARTBEAT_MS) return
    sendEvent('heartbeat')
  }

  function maybeRequestTranscript() {
    const page = parsePage()
    const video = getVideo()
    if (!video || !validId(page.id)) return
    if (page.kind !== 'watch' && page.kind !== 'shorts' && page.kind !== 'live') return
    if (state.transcriptRequestedFor === page.id) return
    if (!(Number(video.currentTime) >= TRANSCRIPT_MIN_SECONDS)) return
    state.transcriptRequestedFor = page.id
    window.postMessage({ source: SOURCE, type: 'transcript-request', videoId: page.id }, location.origin)
  }

  function onTimeUpdate() {
    if (isAdPlaying()) return
    maybeHeartbeat()
    maybeRequestTranscript()
  }

  function onPlay() {
    sendEvent('play')
  }

  function onPause() {
    flushCaptions(true)
    sendEvent('pause')
  }

  function onSeeked() {
    sendEvent('seeked')
  }

  function onEnded() {
    flushCaptions(true)
    sendEvent('ended')
  }

  function bindVideo() {
    const video = getVideo()
    if (video === boundVideo) return
    if (boundVideo) {
      boundVideo.removeEventListener('timeupdate', onTimeUpdate)
      boundVideo.removeEventListener('play', onPlay)
      boundVideo.removeEventListener('pause', onPause)
      boundVideo.removeEventListener('seeked', onSeeked)
      boundVideo.removeEventListener('ended', onEnded)
    }
    boundVideo = video
    if (boundVideo) {
      boundVideo.addEventListener('timeupdate', onTimeUpdate)
      boundVideo.addEventListener('play', onPlay)
      boundVideo.addEventListener('pause', onPause)
      boundVideo.addEventListener('seeked', onSeeked)
      boundVideo.addEventListener('ended', onEnded)
    }
  }

  function sync() {
    const page = parsePage()
    if (page.id !== state.videoId) {
      state.videoId = page.id
      state.pageKind = page.kind
      state.lastSentAt = 0
      state.lastPos = 0
      state.transcriptRequestedFor = ''
      state.transcriptSentFor = ''
      state.metaSentFor = ''
      state.nativeTranscript = false
      state.pendingCaptions = []
      state.captionSeen = new Set()
      state.recentCaptionBodies = []
      if (validId(page.id)) {
        const video = getVideo()
        sendMessage({
          type: 'dsh-archive-event',
          event: {
            schema: 1,
            kind: 'hello',
            pageKind: page.kind,
            videoId: page.id,
            title: pageTitle(),
            channel: pageChannel(),
            durationSec: video && Number.isFinite(video.duration) ? video.duration : 0,
            extensionVersion: chrome.runtime.getManifest().version,
            ts: Date.now(),
          },
        })
      }
    }
    bindVideo()
    if (validId(page.id) && state.metaSentFor !== page.id) {
      const description = pageDescription()
      const chapters = pageChapters()
      if (description || chapters.length) {
        state.metaSentFor = page.id
        const video = getVideo()
        sendMessage({
          type: 'dsh-archive-event',
          event: {
            schema: 1,
            kind: 'meta',
            pageKind: page.kind,
            videoId: page.id,
            title: pageTitle(),
            channel: pageChannel(),
            durationSec: video && Number.isFinite(video.duration) ? video.duration : 0,
            description,
            chapters,
            ts: Date.now(),
          },
        })
      }
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.source !== SOURCE || data.type !== 'transcript-result') return
    const videoId = String(data.videoId || '')
    if (!validId(videoId) || videoId !== state.videoId) return
    if (state.transcriptSentFor === videoId) return
    state.transcriptSentFor = videoId
    const text = typeof data.text === 'string' ? data.text : ''
    if (!text.trim()) {
      state.nativeTranscript = false
      return
    }
    // A native caption track is authoritative; stop scraping the overlay to avoid duplicates.
    state.nativeTranscript = true
    state.pendingCaptions = []
    sendMessage({
      type: 'dsh-archive-event',
      event: {
        schema: 1,
        kind: 'transcript',
        videoId,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        transcript: { text: text.slice(0, 200000), lang: String(data.lang || ''), kind: String(data.kind || '') },
        ts: Date.now(),
      },
    })
  })

  document.addEventListener('yt-navigate-finish', () => {
    sync()
    setTimeout(sync, 500)
  })
  document.addEventListener('yt-page-data-updated', () => sync())
  window.addEventListener('popstate', () => sync())
  document.addEventListener('visibilitychange', () => {
    if (!state.monitoringPaused) {
      if (document.visibilityState === 'hidden') flushCaptions(true)
      sendEvent('heartbeat')
    }
  })

  loadSettings()
  sync()
  startCaptionObserver()
  setInterval(sync, 1000)
  setInterval(() => {
    maybeRequestTranscript()
  }, 5000)
})()
