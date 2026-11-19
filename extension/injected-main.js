(() => {
  'use strict'

  const SOURCE = 'dsh-yt-archive'
  const MAX_CHARS = 200000

  if (window.__dshYtArchiveMainInjected) return
  window.__dshYtArchiveMainInjected = true

  let pendingFor = ''
  let lastResultFor = ''
  let lastResultAt = 0

  function getPlayerResponse() {
    const direct = window.ytInitialPlayerResponse
    if (direct && (direct.videoDetails || direct.captions)) return direct
    const player = document.getElementById('movie_player')
    if (player && typeof player.getPlayerResponse === 'function') {
      try {
        const response = player.getPlayerResponse()
        if (response) return response
      } catch {
        /* ignore */
      }
    }
    try {
      const args = window.ytplayer && window.ytplayer.config && window.ytplayer.config.args
      if (args && args.player_response) return JSON.parse(args.player_response)
    } catch {
      /* ignore */
    }
    return null
  }

  function trackScore(track) {
    const lang = String(track.languageCode || '').toLowerCase()
    const manual = track.kind === 'asr' ? 1 : 0
    let langScore = 9
    if (lang.startsWith('zh-hans')) langScore = 0
    else if (lang.startsWith('zh-hant')) langScore = 1
    else if (lang.startsWith('zh')) langScore = 2
    else if (lang.startsWith('en')) langScore = 3
    return manual * 10 + langScore
  }

  function parseJson3(body) {
    let data
    try {
      data = JSON.parse(body)
    } catch {
      return []
    }
    const events = Array.isArray(data.events) ? data.events : []
    const segments = []
    for (const event of events) {
      const text = (Array.isArray(event.segs) ? event.segs : [])
        .map((segment) => segment.utf8 || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (!text) continue
      const previous = segments[segments.length - 1]
      if (previous && previous.text === text) continue
      segments.push({ t: Math.max(0, Number(event.tStartMs) / 1000 || 0), text })
    }
    return segments
  }

  function formatSegments(segments) {
    return segments
      .map((segment) => {
        const total = Math.floor(segment.t)
        const h = Math.floor(total / 3600)
        const m = Math.floor((total % 3600) / 60)
        const s = total % 60
        const pad = (n) => String(n).padStart(2, '0')
        const clock = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
        return `[${clock}] ${segment.text}`
      })
      .join('\n')
  }

  async function fetchTrack(baseUrl) {
    const url = new URL(baseUrl)
    url.searchParams.set('fmt', 'json3')
    const response = await fetch(url.toString(), {
      credentials: 'include',
      headers: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    })
    if (!response.ok) return []
    const body = await response.text()
    if (!body.trim()) return []
    return parseJson3(body)
  }

  function findTranscriptParams(node, depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > 30 || seen.has(node)) return ''
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = findTranscriptParams(item, depth + 1, seen)
        if (found) return found
      }
      return ''
    }
    if (node.getTranscriptEndpoint && typeof node.getTranscriptEndpoint.params === 'string') {
      return node.getTranscriptEndpoint.params
    }
    for (const value of Object.values(node)) {
      const found = findTranscriptParams(value, depth + 1, seen)
      if (found) return found
    }
    return ''
  }

  function collectTranscriptSegments(node, out = [], depth = 0, seen = new Set()) {
    if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return out
    seen.add(node)
    if (Array.isArray(node)) {
      for (const item of node) collectTranscriptSegments(item, out, depth + 1, seen)
      return out
    }
    const renderer = node.transcriptSegmentRenderer
    if (renderer) {
      const text = (Array.isArray(renderer.snippet?.runs) ? renderer.snippet.runs : [])
        .map((run) => run.text || '')
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
      if (text) out.push({ t: Math.max(0, Number(renderer.startMs) / 1000 || 0), text })
    }
    for (const value of Object.values(node)) collectTranscriptSegments(value, out, depth + 1, seen)
    return out
  }

  async function fetchViaInnertube(videoId) {
    const params = findTranscriptParams(window.ytInitialData)
    if (!params) return []
    const config = window.ytcfg && window.ytcfg.data_ ? window.ytcfg.data_ : {}
    const clientVersion = config.INNERTUBE_CLIENT_VERSION || '2.20260101.00.00'
    const visitorData = config.VISITOR_DATA || ''
    const client = { clientName: 'WEB', clientVersion, hl: 'en', gl: 'US' }
    if (visitorData) client.visitorData = visitorData
    const response = await fetch('https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-YouTube-Client-Name': '1',
        'X-YouTube-Client-Version': clientVersion,
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
      },
      body: JSON.stringify({ context: { client }, params }),
    })
    if (!response.ok) return []
    const data = await response.json()
    return collectTranscriptSegments(data)
  }

  function currentVideoId() {
    const response = getPlayerResponse()
    const id = response && response.videoDetails && response.videoDetails.videoId
    if (id) return String(id)
    const match = /[?&]v=([A-Za-z0-9_-]{6,20})/.exec(location.search)
    return match ? match[1] : ''
  }

  function post(videoId, segments, lang, kind) {
    const text = formatSegments(segments).slice(0, MAX_CHARS)
    lastResultFor = videoId
    lastResultAt = Date.now()
    window.postMessage(
      { source: SOURCE, type: 'transcript-result', videoId, text, lang, kind },
      location.origin,
    )
  }

  async function handleTranscriptRequest(requestedId) {
    if (pendingFor) return
    if (lastResultFor === requestedId && Date.now() - lastResultAt < 30000) return
    if (currentVideoId() && currentVideoId() !== requestedId) {
      return
    }
    pendingFor = requestedId
    try {
      const response = getPlayerResponse()
      const tracks =
        (response &&
          response.captions &&
          response.captions.playerCaptionsTracklistRenderer &&
          response.captions.playerCaptionsTracklistRenderer.captionTracks) ||
        []
      const candidates = [...tracks].sort((a, b) => trackScore(a) - trackScore(b)).slice(0, 3)
      for (const track of candidates) {
        if (!track || !track.baseUrl) continue
        try {
          const segments = await fetchTrack(track.baseUrl)
          if (segments.length) {
            post(requestedId, segments, track.languageCode || '', track.kind === 'asr' ? 'asr' : 'manual')
            return
          }
        } catch {
          /* try the next track */
        }
      }
      try {
        const segments = await fetchViaInnertube(requestedId)
        if (segments.length) {
          post(requestedId, segments, '', 'innertube')
          return
        }
      } catch {
        /* no transcript */
      }
      post(requestedId, [], '', '')
    } finally {
      pendingFor = ''
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.source !== SOURCE || data.type !== 'transcript-request') return
    const videoId = String(data.videoId || '')
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return
    handleTranscriptRequest(videoId)
  })
})()
