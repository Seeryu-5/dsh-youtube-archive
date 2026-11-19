import { createHash } from 'node:crypto'
import { resolveConfig } from './config.js'
import { createStore } from './store.js'
import { Tracker } from './tracker.js'
import { startIngestServer } from './ingest-server.js'
import { fetchTranscriptFromTracks, getVideoInfo } from './youtube.js'
import { emptyUsage, mergeUsage, totalTokensOf } from './llm-usage.js'
import { PROMPT_VERSION, resolveModelLabel, summarizeVideo } from './summarize.js'
import { updateIndexes, writeNote } from './archive.js'
import { cleanTranscript } from './clean.js'
import { createLibrary } from './library.js'
import { buildSentences, fallbackParagraphs, sentencesToText } from './transcript.js'
import { mostlyChinese, translatePending } from './translate.js'
import { parseYouTubeUrl } from './util.js'

export const name = 'dsh-youtube-archive'
export const inject = ['llm', 'tools']

const VERSION = '0.4.4'

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 24)
}

export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const store = createStore(config)
  const library = createLibrary({ config, store })

  let server = null
  let actualPort = config.port
  let serverError = ''
  let disposed = false

  const locks = new Map()
  const rerun = new Map()
  let chain = Promise.resolve()

  const tracker = new Tracker({
    config,
    store,
    onFinalize: (videoId, stage, options) => schedule(videoId, stage, options).catch(() => {}),
    // Transcript arrival only updates the cache; note generation is deferred to
    // the final pass so one video never costs two summary/translation rounds.
    onTranscript: () => {},
  })

  function schedule(videoId, stage, options = {}) {
    if (!config.enabled) return Promise.resolve({ skipped: 'disabled' })
    if (locks.has(videoId)) {
      rerun.set(videoId, options)
      return locks.get(videoId)
    }
    const run = chain.then(() => processVideo(videoId, stage, options))
    chain = run.catch(() => {})
    locks.set(videoId, run)
    const cleanup = () => {
      locks.delete(videoId)
      const next = rerun.get(videoId)
      rerun.delete(videoId)
      if (next && !disposed) schedule(videoId, 'final', next).catch(() => {})
    }
    run.then(cleanup, (error) => {
      store.log({ type: 'error', where: 'summarize', videoId, message: String(error?.message ?? error) })
      cleanup()
    })
    return run
  }

  function refreshIndexes() {
    try {
      updateIndexes(config, store)
    } catch (error) {
      store.log({ type: 'error', where: 'index', message: String(error?.message ?? error) })
    }
  }

  function statsOnly(videoId, info) {
    tracker.flush()
    if (info) {
      store.upsertVideo(videoId, {
        title: info.title || store.getVideo(videoId)?.title || '',
        channel: info.channel || store.getVideo(videoId)?.channel || '',
        durationSec: info.durationSec || store.getVideo(videoId)?.durationSec || 0,
      })
    }
    store.save()
    refreshIndexes()
    return { skipped: 'up-to-date' }
  }

  const translationJobs = new Set()
  const translationAttempts = new Map()

  function refreshNoteFromState(videoId) {
    const rec = store.getVideo(videoId)
    if (!rec?.notePath || locks.has(videoId)) return
    const transcript = store.readTranscript(videoId)
    const cache = store.readTranslation(videoId)
    const summary = store.readSummary(videoId)?.summary ?? null
    const info = {
      title: rec.title || '',
      channel: rec.channel || '',
      durationSec: rec.durationSec || 0,
      description: rec.description || rec.extensionDescription || '',
      chapters: Array.isArray(rec.chapters) ? rec.chapters : Array.isArray(rec.extensionChapters) ? rec.extensionChapters : [],
      published: rec.published || '',
    }
    const translation = cache
      ? {
          translated: Boolean(cache.text),
          status: cache.status || 'translating',
          text: cache.text || '',
        }
      : null
    const notePath = writeNote({
      config,
      rec,
      info,
      summary,
      transcriptAvailable: Boolean(transcript?.cleanText || transcript?.text),
      transcriptText: transcript?.cleanText || transcript?.text || '',
      translation,
      liveCaptions: rec.liveCaptions === true,
      paragraphs: summary?.paragraphs ?? rec.paragraphs ?? [],
      expressions: summary?.expressions ?? rec.expressions ?? [],
      stage: rec.summaryStage || '初版',
      model: rec.model || '',
      error: rec.summaryError || '',
      summaryStatus: rec.summaryStatus || 'none',
      tokenUsage: rec.tokenUsage || null,
    })
    store.upsertVideo(videoId, { notePath })
    store.save()
    refreshIndexes()
  }

  async function translationTick(videoId) {
    if (!config.enabled || !config.translateTranscript || !config.autoTranslate) return
    if (translationJobs.has(videoId) || locks.has(videoId)) return
    const rec = store.getVideo(videoId)
    if (!rec?.transcript) return
    const transcript = store.readTranscript(videoId)
    const text = transcript?.cleanText || transcript?.text || ''
    if (!text.trim()) return
    if (mostlyChinese(text, transcript?.lang || '')) {
      store.upsertVideo(videoId, { translationStatus: 'source-zh', translated: false })
      store.save()
      return
    }

    translationJobs.add(videoId)
    try {
      const before = Number(store.getVideo(videoId)?.translationDoneChunks ?? 0)
      const result = await translatePending(ctx, config, {
        store,
        videoId,
        text,
        lang: transcript?.lang || '',
        batchSize: config.translationBatchChunks,
      })
      const latest = store.getVideo(videoId) ?? rec
      const progress = result.doneChunks > before
      const attempts = progress ? 0 : Number(translationAttempts.get(videoId) ?? 0) + 1
      if (result.done) translationAttempts.delete(videoId)
      else translationAttempts.set(videoId, attempts)

      store.upsertVideo(videoId, {
        translationStatus: attempts >= 4 && !result.done ? 'failed' : result.status,
        translationHash: result.done ? hashText(text) : '',
        translationChars: [...String(result.text ?? '')].length,
        translationDoneChunks: result.doneChunks,
        translationTotalChunks: result.total,
        translated: result.doneChunks > 0,
        tokenUsage: mergeUsage(latest.tokenUsage, result.usage),
      })
      store.save()
      if (store.getVideo(videoId)?.notePath) refreshNoteFromState(videoId)
      store.log({
        type: 'translate-tick',
        videoId,
        status: result.status,
        done: result.doneChunks,
        total: result.total,
        failed: result.failedChunks,
        tokens: result.usage?.totalTokens ?? 0,
      })

      if (!result.done) {
        if (attempts >= 4) return
        setTimeout(() => translationTick(videoId), attempts >= 2 ? 30000 : 2000)
      }
    } catch (error) {
      store.log({ type: 'error', where: 'translate-worker', videoId, message: String(error?.message ?? error) })
    } finally {
      translationJobs.delete(videoId)
    }
  }

  async function runManualTranslation(videoId) {
    if (!config.enabled || !config.translateTranscript) throw new Error('翻译功能未启用')
    if (translationJobs.has(videoId)) return
    const rec = store.getVideo(videoId)
    if (!rec) throw new Error('未找到该视频记录')
    const transcript = store.readTranscript(videoId)
    const text = transcript?.cleanText || transcript?.text || ''
    if (!text.trim()) throw new Error('还没有抓到字幕，暂时不能翻译')
    if (mostlyChinese(text, transcript?.lang || '')) {
      store.upsertVideo(videoId, { translationStatus: 'source-zh', translated: false })
      store.save()
      refreshNoteFromState(videoId)
      return
    }

    translationJobs.add(videoId)
    try {
      const textHash = hashText(text)
      let noProgress = 0
      for (let round = 0; round < 200; round++) {
        const before = Number(store.getVideo(videoId)?.translationDoneChunks ?? 0)
        const result = await translatePending(ctx, config, {
          store,
          videoId,
          text,
          lang: transcript?.lang || '',
          batchSize: config.translationBatchChunks,
        })
        const latest = store.getVideo(videoId) ?? rec
        const progressed = result.doneChunks > before
        if (progressed) noProgress = 0
        else noProgress++
        const failed = noProgress >= 3 && !result.done
        store.upsertVideo(videoId, {
          translationStatus: failed ? 'failed' : result.status,
          translationHash: result.done ? textHash : '',
          translationChars: [...String(result.text ?? '')].length,
          translationDoneChunks: result.doneChunks,
          translationTotalChunks: result.total,
          translated: result.doneChunks > 0,
          tokenUsage: mergeUsage(latest.tokenUsage, result.usage),
        })
        store.save()
        refreshNoteFromState(videoId)
        store.log({
          type: 'translate-manual',
          videoId,
          status: failed ? 'failed' : result.status,
          done: result.doneChunks,
          total: result.total,
          failed: result.failedChunks,
          tokens: result.usage?.totalTokens ?? 0,
        })
        if (result.done || failed) return
      }
    } finally {
      translationJobs.delete(videoId)
    }
  }

  function kickTranslation(videoId) {
    if (!config.enabled || !config.translateTranscript || !config.autoTranslate) return
    translationAttempts.delete(videoId)
    if (translationJobs.has(videoId)) return
    if (locks.has(videoId)) {
      setTimeout(() => kickTranslation(videoId), 2000)
      return
    }
    translationTick(videoId).catch(() => {})
  }

  async function processVideo(videoId, stage, options = {}) {
    const force = options.force === true
    let rec = store.getVideo(videoId) ?? { videoId, createdAt: new Date().toISOString() }
    if (options.kind === 'shorts' && config.skipShorts) {
      store.log({ type: 'skip', reason: 'shorts', videoId })
      return { skipped: 'shorts' }
    }

    let info
    if (config.fetchMetadata) {
      try {
        info = await getVideoInfo(videoId, { fallbackTitle: rec.title, fallbackChannel: rec.channel })
      } catch (error) {
        info = {
          videoId,
          title: rec.title || `YouTube 视频 ${videoId}`,
          channel: rec.channel || '',
          durationSec: rec.durationSec || 0,
          description: '',
          chapters: [],
          keywords: [],
          published: '',
          isLive: false,
          captionTracks: [],
          titleSource: 'fallback',
          warnings: [String(error?.message ?? error)],
        }
      }
    } else {
      info = {
        videoId,
        title: rec.title || `YouTube 视频 ${videoId}`,
        channel: rec.channel || '',
        durationSec: rec.durationSec || 0,
        description: '',
        chapters: [],
        keywords: [],
        published: '',
        isLive: false,
        captionTracks: [],
        titleSource: 'extension',
        warnings: ['fetchMetadata=false'],
      }
    }

    // The watch page is sometimes served as a stripped/bot-limited shell;
    // prefer DOM metadata reported by the extension when it is richer.
    const liveRec = store.getVideo(videoId) ?? rec
    if (liveRec.extensionDescription && (!info.description || /Enjoy the videos and music/i.test(info.description))) {
      info.description = liveRec.extensionDescription
    }
    if ((!info.chapters || info.chapters.length === 0) && Array.isArray(liveRec.extensionChapters)) {
      info.chapters = liveRec.extensionChapters
    }
    if (!info.durationSec && liveRec.durationSec) info.durationSec = liveRec.durationSec
    if (info.titleSource === 'none' && liveRec.title) info.title = liveRec.title
    if (/^Enjoy the videos and music/i.test(String(info.description ?? ''))) info.description = ''

    if (info.isLive && config.skipLive) {
      store.log({ type: 'skip', reason: 'live', videoId })
      return { skipped: 'live' }
    }

    let transcript = store.readTranscript(videoId)
    if (transcript) transcript = store.compactTranscript(videoId) ?? transcript
    if (!transcript && Array.isArray(info.captionTracks) && info.captionTracks.length) {
      try {
        const fetched = await fetchTranscriptFromTracks(info.captionTracks)
        if (fetched?.text) {
          store.writeTranscript(videoId, { ...fetched, source: 'watchpage' })
          transcript = store.readTranscript(videoId)
        }
      } catch {
        /* host-side caption fetch is best effort */
      }
    }
    const currentRec = store.getVideo(videoId) ?? rec
    const liveCaptions = currentRec.liveCaptions === true
    let sentences = []
    let transcriptText = transcript?.text?.trim() ?? ''
    let cleanStatus = ''
    let usage = mergeUsage(currentRec.tokenUsage, null)
    if (transcriptText && config.cleanTranscript) {
      try {
        const cleaned = await cleanTranscript(ctx, config, { store, videoId, text: transcriptText })
        cleanStatus = cleaned.status
        usage = mergeUsage(usage, cleaned.usage)
        if (cleaned.text) transcriptText = cleaned.text
      } catch (error) {
        cleanStatus = 'failed'
        store.log({ type: 'error', where: 'clean', videoId, message: String(error?.message ?? error) })
      }
    }
    if (transcriptText) {
      sentences = buildSentences(transcriptText)
      const rebuilt = sentencesToText(sentences)
      if (rebuilt) transcriptText = rebuilt
      store.updateTranscript(videoId, { cleanText: transcriptText, sentences, cleanStatus })
    }
    const hasTranscript = Boolean(transcriptText)
    const transcriptChars = [...transcriptText].length
    const textHash = hasTranscript ? hashText(transcriptText) : ''
    const modelLabel = resolveModelLabel(ctx, config)
    const summaryFingerprint = hashText(
      [PROMPT_VERSION, modelLabel, config.reasoningEffort, config.summaryLanguage, transcriptText].join('\n'),
    )
    const isFinal = stage === 'final'
    const summaryCached =
      !force && currentRec.summaryStatus === 'ok' && currentRec.summaryHash === summaryFingerprint

    // One-pass default: the 45s milestone only saves metadata/transcript and a
    // placeholder note. Model calls happen once at the final pass.
    if (!config.initialSummary && !isFinal && !force) {
      if (currentRec.summaryStatus === 'ok') return statsOnly(videoId, info)
      if (currentRec.summaryStatus === 'pending' && currentRec.notePath) return statsOnly(videoId, info)

      tracker.flush()
      const liveStats = tracker.videoStats(videoId)
      store.upsertVideo(videoId, {
        title: info.title || currentRec.title || '',
        channel: info.channel || currentRec.channel || '',
        durationSec: info.durationSec || currentRec.durationSec || 0,
        published: info.published || currentRec.published || '',
        description: info.description || currentRec.description || '',
        chapters: info.chapters ?? currentRec.chapters ?? [],
        watchedSec: liveStats.totalWatchedSec,
        maxProgressSec: liveStats.maxProgressSec,
        watchSessions: liveStats.watchSessions,
        transcript: hasTranscript,
        transcriptChars,
        transcriptHash: textHash,
        summaryTranscript: false,
        summaryTranscriptChars: 0,
        liveCaptions,
        summaryStage: '初版',
        summaryStatus: 'pending',
        summaryError: '',
        summaryHash: '',
        translated: false,
        translationStatus: 'none',
        translationHash: '',
        translationChars: 0,
        paragraphs: [],
        expressions: [],
        tokenUsage: usage,
        model: modelLabel,
      })
      const pending = store.getVideo(videoId)
      const pendingNote = writeNote({
        config,
        rec: pending,
        info,
        summary: null,
        transcriptAvailable: hasTranscript,
        transcriptText,
        translation: null,
        liveCaptions,
        paragraphs: [],
        expressions: [],
        stage: '初版',
        model: modelLabel,
        error: '',
        summaryStatus: 'pending',
        tokenUsage: usage,
      })
      store.upsertVideo(videoId, { notePath: pendingNote })
      store.save()
      refreshIndexes()
      store.log({ type: 'pending', videoId, transcript: hasTranscript, notePath: pendingNote })
      if (config.autoTranslate && hasTranscript) kickTranslation(videoId)
      return { notePath: pendingNote, pending: true, summaryStatus: 'pending' }
    }

    const summaryRequested = options.summaryOnly === true || config.autoSummary === true
    let summary = null
    let summaryError = ''
    if (summaryRequested) {
      if (!force && summaryCached) summary = store.readSummary(videoId)?.summary ?? null
      if (!summary) {
        const watch = tracker.videoStats(videoId)
        try {
          const result = await summarizeVideo(ctx, config, {
            info,
            transcript: transcriptText,
            watch,
          })
          usage = mergeUsage(usage, result.usage)
          if (result.ok) {
            summary = result.data
            store.writeSummary(videoId, summary)
          } else {
            summaryError = result.error
          }
        } catch (error) {
          summaryError = String(error?.message ?? error)
        }
      }
    } else if (currentRec.summaryStatus === 'ok' && currentRec.summaryHash === summaryFingerprint) {
      summary = store.readSummary(videoId)?.summary ?? null
    }
    if (summary && (!summary.paragraphs || summary.paragraphs.length === 0)) {
      summary.paragraphs = fallbackParagraphs(sentences)
    }

    let summaryStatus = 'none'
    if (summary) summaryStatus = 'ok'
    else if (summaryRequested) summaryStatus = 'failed'
    else if (currentRec.summaryStatus === 'ok') summaryStatus = 'stale'
    else if (currentRec.summaryStatus === 'failed') {
      summaryStatus = 'failed'
      summaryError = currentRec.summaryError || summaryError
    } else if (currentRec.summaryStatus === 'stale') summaryStatus = 'stale'

    const summaryStage = summary ? (isFinal ? '精读' : hasTranscript && !liveCaptions ? '精读' : '初版') : '初版'

    const cachedTranslation = store.readTranslation(videoId)
    let translation = null
    if (config.translateTranscript && hasTranscript) {
      if (currentRec.translationStatus === 'source-zh') {
        translation = { translated: false, status: 'source-zh', text: '', chars: 0 }
      } else if (cachedTranslation && currentRec.translationHash === textHash) {
        translation = {
          translated: Boolean(cachedTranslation.text),
          status: cachedTranslation.status || 'none',
          text: cachedTranslation.text || '',
          chars: [...String(cachedTranslation.text ?? '')].length,
        }
      } else if (cachedTranslation && currentRec.translationStatus === 'translating' && !currentRec.translationHash) {
        translation = {
          translated: Boolean(cachedTranslation.text),
          status: 'translating',
          text: cachedTranslation.text || '',
          chars: [...String(cachedTranslation.text ?? '')].length,
        }
      } else {
        // Transcript changed after the cached translation, or nothing has been
        // translated yet. Manual translation starts from the current text.
        translation = { translated: false, status: 'none', text: '', chars: 0 }
      }
    }

    tracker.flush()
    const liveStats = tracker.videoStats(videoId)
    store.upsertVideo(videoId, {
      title: info.title || currentRec.title || '',
      channel: info.channel || currentRec.channel || '',
      durationSec: info.durationSec || currentRec.durationSec || 0,
      published: info.published || currentRec.published || '',
      description: info.description || currentRec.description || '',
      chapters: info.chapters ?? currentRec.chapters ?? [],
      watchedSec: liveStats.totalWatchedSec,
      maxProgressSec: liveStats.maxProgressSec,
      watchSessions: liveStats.watchSessions,
      transcript: hasTranscript,
      transcriptChars,
      transcriptHash: textHash,
      summaryTranscript: hasTranscript,
      summaryTranscriptChars: transcriptChars,
      liveCaptions,
      translated: Boolean(translation?.translated),
      translationStatus: translation?.status || '',
      translationHash: translation?.text ? textHash : '',
      translationChars: [...String(translation?.text ?? '')].length,
      paragraphs: summary?.paragraphs ?? [],
      expressions: summary?.expressions ?? [],
      category: summary?.category || currentRec.category || '其他',
      tags: summary?.tags ?? currentRec.tags ?? [],
      oneLine: summary?.summary || currentRec.oneLine || '',
      contentType: summary?.content_type || currentRec.contentType || '其他',
      confidence: summary?.confidence || currentRec.confidence || 'low',
      summaryStage,
      summaryStatus,
      summaryError: summary ? '' : String(summaryError).slice(0, 500),
      summaryHash: summary ? summaryFingerprint : currentRec.summaryHash || '',
      tokenUsage: usage,
      basis: hasTranscript ? '字幕' : '简介/章节',
      model: modelLabel,
    })

    const fresh = store.getVideo(videoId)
    const notePath = writeNote({
      config,
      rec: fresh,
      info,
      summary,
      transcriptAvailable: hasTranscript,
      transcriptText,
      translation,
      liveCaptions,
      paragraphs: summary?.paragraphs ?? [],
      expressions: summary?.expressions ?? [],
      stage: fresh.summaryStage,
      model: fresh.model,
      error: summaryError,
      summaryStatus: fresh.summaryStatus,
      tokenUsage: usage,
    })
    store.upsertVideo(videoId, { notePath })
    store.save()
    refreshIndexes()
    if (!options.summaryOnly && config.translateTranscript && hasTranscript) {
      kickTranslation(videoId)
    }
    store.log({
      type: 'archive',
      videoId,
      stage: fresh.summaryStage,
      summaryStatus: fresh.summaryStatus,
      transcript: hasTranscript,
      translationStatus: fresh.translationStatus,
      tokens: totalTokensOf(usage),
      notePath,
    })
    return {
      notePath,
      category: fresh.category,
      transcript: hasTranscript,
      summaryStatus: fresh.summaryStatus,
      translationStatus: fresh.translationStatus,
      summaryStage: fresh.summaryStage,
      tokens: totalTokensOf(usage),
    }
  }

  function health() {
    const now = Date.now()
    const lastHeartbeatAt = tracker.lastHeartbeatAt || store.state.lastHeartbeatAt || 0
    return {
      ok: true,
      enabled: config.enabled,
      outputDir: config.outputDir,
      port: actualPort,
      notes: store.allVideos().filter((video) => video.notePath).length,
      queue: locks.size,
      activeSessions: tracker.sessions.size,
      extensionConnected: lastHeartbeatAt > 0 && now - lastHeartbeatAt < 120_000,
      extensionVersion: store.state.extension?.version ?? '',
      lastHeartbeatAt,
      lastEventAt: store.state.lastEventAt || 0,
      tokens: store.allVideos().reduce((sum, video) => sum + Number(video.tokenUsage?.totalTokens ?? 0), 0),
      serverError,
      ui: config.enabled && !serverError,
    }
  }

  // ---- lifecycle: ingest server + timers -----------------------------------
  ctx.effect(() => {
    if (!config.enabled) {
      serverError = '插件已禁用（config.enabled=false）'
      console.log('[dsh-youtube-archive] 插件已禁用，未启动本地服务。')
    } else startIngestServer({
      config,
      onEvent: (event) => tracker.handleEvent(event),
      getHealth: health,
      log: store.log,
      api: {
        listNotes: () => {
          tracker.flush()
          return library.list()
        },
        readNote: (path) => library.readNote(path),
        reveal: (path) => library.reveal(path),
        retry: (videoId) => {
          if (!store.getVideo(videoId)) throw new Error('未找到该视频记录')
          schedule(videoId, 'final', { force: true }).catch(() => {})
        },
        summarize: (videoId) => {
          if (!store.getVideo(videoId)) throw new Error('未找到该视频记录')
          if (locks.has(videoId)) throw new Error('该视频正在处理，请稍候再试')
          schedule(videoId, 'final', { force: true, summaryOnly: true }).catch(() => {})
        },
        translate: (videoId) => {
          if (!store.getVideo(videoId)) throw new Error('未找到该视频记录')
          runManualTranslation(videoId).catch((error) => {
            store.log({ type: 'error', where: 'translate-manual', videoId, message: String(error?.message ?? error) })
          })
        },
      },
    })
      .then(({ server: started, port }) => {
        if (disposed) {
          started.close()
          return
        }
        server = started
        actualPort = port
        store.state.port = port
        store.save()
        if (port !== config.port) {
          store.log({ type: 'warn', message: `端口 ${config.port} 被占用，已改用 ${port}；请在扩展选项页同步端口。` })
        }
        console.log(`[dsh-youtube-archive] 监听 127.0.0.1:${port}，输出目录 ${config.outputDir}`)
      })
      .catch((error) => {
        serverError = String(error?.message ?? error)
        store.log({ type: 'error', where: 'server', message: serverError })
        console.error('[dsh-youtube-archive] 启动本地服务失败：', error)
      })

    const tickTimer = setInterval(() => {
      try {
        tracker.tick()
      } catch (error) {
        store.log({ type: 'error', where: 'tick', message: String(error?.message ?? error) })
      }
    }, 30_000)
    const flushTimer = setInterval(() => {
      try {
        tracker.flush()
      } catch {
        /* ignore */
      }
    }, 10_000)
    const recoverTimer = setTimeout(() => {
      if (disposed) return
      for (const video of store.allVideos()) {
        if (!config.autoTranslate && video.translationStatus === 'translating') {
          store.upsertVideo(video.videoId, {
            translationStatus: Number(video.translationDoneChunks ?? 0) > 0 ? 'partial' : 'failed',
          })
        }
        if (video.summaryStatus !== 'pending' && video.summaryStatus !== 'stale') continue
        schedule(video.videoId, 'final').catch(() => {})
      }
      store.save()
    }, 4000)
    const translationTimer = setInterval(() => {
      if (!config.translateTranscript || !config.autoTranslate) return
      const candidate = store
        .allVideos()
        .find(
          (video) =>
            video.transcript &&
            video.translationStatus !== 'ok' &&
            video.translationStatus !== 'source-zh' &&
            video.translationStatus !== 'failed' &&
            !translationJobs.has(video.videoId) &&
            !locks.has(video.videoId),
        )
      if (candidate) translationTick(candidate.videoId).catch(() => {})
    }, 15_000)

    return () => {
      disposed = true
      clearInterval(tickTimer)
      clearInterval(flushTimer)
      clearInterval(translationTimer)
      clearTimeout(recoverTimer)
      try {
        tracker.closeAll('shutdown')
      } catch {
        /* ignore */
      }
      try {
        server?.close()
      } catch {
        /* ignore */
      }
    }
  }, 'dsh-youtube-archive: ingest server and timers')

  // ---- tools ---------------------------------------------------------------
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'youtube_archive_status',
        description:
          '查看 YouTube 播放监测/归档插件状态：本地服务端口、Brave 扩展是否连接、输出目录、已归档视频与分类统计、任务队列和最近事件。',
        parameters: { type: 'object', properties: {} },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              enabled: { type: 'boolean' },
              port: { type: 'integer' },
              outputDir: { type: 'string' },
              extensionConnected: { type: 'boolean' },
              lastHeartbeatAt: { type: 'integer' },
              notes: { type: 'integer' },
              queue: { type: 'integer' },
              serverError: { type: 'string' },
              tokens: { type: 'integer' },
              categories: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: { name: { type: 'string' }, count: { type: 'integer' } },
                  required: ['name', 'count'],
                },
              },
              message: { type: 'string' },
            },
            required: ['ok'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        async execute() {
          tracker.flush()
          const archived = store.allVideos().filter((video) => video.notePath)
          const counts = new Map()
          for (const video of archived) {
            const category = config.categories.includes(video.category) ? video.category : '其他'
            counts.set(category, (counts.get(category) ?? 0) + 1)
          }
          const categories = [...counts.entries()].map(([categoryName, count]) => ({ name: categoryName, count }))
          const healthInfo = health()
          const lastSeen = healthInfo.lastHeartbeatAt
            ? `${Math.max(0, Math.round((Date.now() - healthInfo.lastHeartbeatAt) / 1000))} 秒前`
            : '从未'
          const message = [
            'YouTube 归档插件状态：',
            `- 启用：${config.enabled}`,
            `- 本地服务：127.0.0.1:${actualPort}${serverError ? `（异常：${serverError}）` : '（正常）'}`,
            `- Brave 扩展：${healthInfo.extensionConnected ? `已连接（最后心跳 ${lastSeen}）` : `未连接（最后心跳：${lastSeen}）`}`,
            `- 输出目录：${config.outputDir}`,
            `- 浏览界面：http://127.0.0.1:${actualPort}/`,
            `- 已归档：${archived.length} 个视频`,
            ...categories.map((item) => `  · ${item.name}：${item.count}`),
            `- Token：约 ${store.allVideos().reduce((sum, video) => sum + Number(video.tokenUsage?.totalTokens ?? 0), 0)}（所有笔记累计）`,
            `- 队列：${locks.size} 个任务；进行中会话：${tracker.sessions.size}`,
            `- 最近事件：${store.state.lastEventAt ? new Date(store.state.lastEventAt).toLocaleString('zh-CN', { hour12: false }) : '（无）'}`,
            config.enabled ? '' : '- 插件已关闭（config.enabled=false）',
          ]
            .filter(Boolean)
            .join('\n')
          return {
            ok: true,
            enabled: config.enabled,
            port: actualPort,
            outputDir: config.outputDir,
            extensionConnected: healthInfo.extensionConnected,
            lastHeartbeatAt: healthInfo.lastHeartbeatAt,
            notes: archived.length,
            queue: locks.size,
            serverError,
            tokens: healthInfo.tokens || 0,
            categories,
            message,
          }
        },
      }),
    'dsh-youtube-archive: status tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'youtube_archive_summarize',
        description:
          '按 YouTube 链接或 videoId 立即抓取视频信息、已缓存字幕并生成/更新归档笔记；force=true 可强制重新摘要。',
        parameters: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'YouTube 链接（watch/shorts/live/youtu.be 均可）' },
            videoId: { type: 'string', description: '也可直接给 11 位左右的视频 ID' },
            force: { type: 'boolean', description: '强制重新生成摘要（默认 false）' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              notePath: { type: 'string' },
              category: { type: 'string' },
              transcript: { type: 'boolean' },
            },
            required: ['ok'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        async execute(args) {
          const parsed = parseYouTubeUrl(args?.videoId || args?.url)
          if (!parsed) {
            return { ok: false, message: '请提供合法的 YouTube 链接或 videoId。' }
          }
          if (!config.enabled) {
            return { ok: false, message: '插件已关闭（config.enabled=false）。' }
          }
          if (parsed.kind === 'shorts' && config.skipShorts) {
            return { ok: false, message: '当前配置跳过 Shorts（skipShorts=true），可关闭后重试。' }
          }
          try {
            const result = await schedule(parsed.videoId, 'final', {
              force: args?.force === true,
              kind: parsed.kind,
              summaryOnly: true,
            })
            if (result.skipped) {
              return {
                ok: true,
                message: `未重新生成：${result.skipped === 'live' ? '直播默认跳过' : '已有最新归档'}。`,
              }
            }
            return {
              ok: true,
              notePath: result.notePath,
              category: result.category,
              transcript: result.transcript,
              message: `已归档：${result.notePath}\n分类：${result.category}｜字幕：${
                result.transcript ? '有' : '无（依据简介/章节）'
              }｜摘要：${result.summaryStatus === 'ok' ? '成功' : '失败（稍后可 force 重试）'}`,
            }
          } catch (error) {
            return { ok: false, message: `归档失败：${String(error?.message ?? error)}` }
          }
        },
      }),
    'dsh-youtube-archive: summarize tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'youtube_archive_list',
        description: '查询已归档的 YouTube 笔记，可按分类、关键词过滤，返回标题、分类、观看时间与笔记路径。',
        parameters: {
          type: 'object',
          properties: {
            category: { type: 'string', description: '只看某个分类' },
            query: { type: 'string', description: '按标题/频道/标签/一句话摘要搜索' },
            limit: { type: 'integer', minimum: 1, maximum: 100, description: '最多返回条数，默认 20' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    videoId: { type: 'string' },
                    title: { type: 'string' },
                    channel: { type: 'string' },
                    category: { type: 'string' },
                    lastWatchedAt: { type: 'string' },
                    watchedSec: { type: 'integer' },
                    notePath: { type: 'string' },
                    oneLine: { type: 'string' },
                  },
                  required: ['videoId', 'title', 'category', 'notePath'],
                },
              },
            },
            required: ['ok'],
          },
          render: (_args, value) => [{ type: 'text', text: value.message ?? '' }],
        },
        async execute(args) {
          const limit = Math.min(100, Math.max(1, Number(args?.limit) || 20))
          const category = typeof args?.category === 'string' ? args.category.trim() : ''
          const query = typeof args?.query === 'string' ? args.query.trim().toLowerCase() : ''
          const videos = store
            .allVideos()
            .filter((video) => video.notePath)
            .filter((video) => (category ? video.category === category : true))
            .filter((video) => {
              if (!query) return true
              const haystack = [video.title, video.channel, video.oneLine, ...(video.tags ?? [])]
                .join(' ')
                .toLowerCase()
              return haystack.includes(query)
            })
            .sort((a, b) => String(b.lastWatchedAt ?? '').localeCompare(String(a.lastWatchedAt ?? '')))
            .slice(0, limit)

          const items = videos.map((video) => ({
            videoId: video.videoId,
            title: String(video.title ?? ''),
            channel: String(video.channel ?? ''),
            category: String(video.category ?? '其他'),
            lastWatchedAt: String(video.lastWatchedAt ?? ''),
            watchedSec: Math.round(Number(video.watchedSec ?? 0)),
            notePath: String(video.notePath),
            oneLine: String(video.oneLine ?? ''),
          }))
          const message = items.length
            ? [`共找到 ${items.length} 条：`, ...items.map((item) => `- [${item.category}] ${item.title} — ${item.notePath}`)].join('\n')
            : '没有符合条件的归档笔记。'
          return { ok: true, message, items }
        },
      }),
    'dsh-youtube-archive: list tool',
  )

  console.log(
    `[dsh-youtube-archive] v${VERSION} 已加载：输出目录 ${config.outputDir}，等待 Brave 扩展事件（127.0.0.1:${config.port}）。`,
  )
}
