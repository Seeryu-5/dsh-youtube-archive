import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { extname, resolve, sep } from 'node:path'
import { buildSentences, sentencesToText } from './transcript.js'

const execFileP = promisify(execFile)
const MAX_NOTE_BYTES = 5 * 1024 * 1024

function httpError(message, status) {
  const error = new Error(message)
  error.status = status
  return error
}

/**
 * Read-only view of the archive used by the local web UI.
 * Paths are validated against the configured vault before reading.
 */
export function createLibrary({ config, store }) {
  const root = resolve(config.outputDir)

  function isInside(target) {
    return target === root || target.startsWith(`${root}${sep}`)
  }

  function items() {
    return store
      .allVideos()
      .filter((video) => video.notePath && existsSync(video.notePath))
      .map((video) => ({
        videoId: video.videoId,
        title: String(video.title ?? ''),
        channel: String(video.channel ?? ''),
        category: String(video.category ?? '其他'),
        tags: Array.isArray(video.tags) ? video.tags : [],
        oneLine: String(video.oneLine ?? ''),
        durationSec: Math.round(Number(video.durationSec ?? 0)),
        watchedSec: Math.round(Number(video.watchedSec ?? 0)),
        maxProgressSec: Math.round(Number(video.maxProgressSec ?? 0)),
        watchSessions: Number(video.watchSessions ?? 0),
        firstWatchedAt: String(video.firstWatchedAt ?? ''),
        lastWatchedAt: String(video.lastWatchedAt ?? ''),
        notePath: String(video.notePath),
        summaryStage: String(video.summaryStage ?? '初版'),
        summaryStatus: String(video.summaryStatus ?? ''),
        transcript: video.transcript === true,
        liveCaptions: video.liveCaptions === true,
        translated: video.translated === true,
        translationStatus: String(video.translationStatus ?? ''),
        transcriptChars: Number(video.transcriptChars ?? 0),
        contentType: String(video.contentType ?? '其他'),
        confidence: String(video.confidence ?? 'low'),
        paragraphCount: Array.isArray(video.paragraphs) ? video.paragraphs.length : 0,
        expressionCount: Array.isArray(video.expressions) ? video.expressions.length : 0,
        watchSessions: Number(video.watchSessions ?? 0),
      }))
  }

  function list() {
    const all = items()
    const counts = new Map()
    for (const item of all) counts.set(item.category, (counts.get(item.category) ?? 0) + 1)
    const categories = [
      ...config.categories.filter((name) => counts.has(name)).map((name) => ({ name, count: counts.get(name) })),
      ...[...counts.keys()].filter((name) => !config.categories.includes(name)).map((name) => ({ name, count: counts.get(name) })),
    ]
    return {
      items: all,
      categories,
      stats: {
        videos: all.length,
        watchedSec: all.reduce((sum, item) => sum + item.watchedSec, 0),
        withTranscript: all.filter((item) => item.transcript).length,
      },
      vault: config.outputDir,
      updatedAt: Date.now(),
    }
  }

  function resolveNotePath(input) {
    if (typeof input !== 'string' || !input.trim()) throw httpError('缺少笔记路径', 400)
    const target = resolve(input.trim())
    if (!isInside(target)) throw httpError('路径不在归档目录内', 403)
    if (extname(target).toLowerCase() !== '.md') throw httpError('只允许读取 Markdown 笔记', 403)
    if (!existsSync(target)) throw httpError('笔记文件不存在', 404)
    const stat = statSync(target)
    if (!stat.isFile()) throw httpError('不是文件', 404)
    if (stat.size > MAX_NOTE_BYTES) throw httpError('笔记文件过大', 413)
    return target
  }

  function readNote(input) {
    const target = resolveNotePath(input)
    const video = store.allVideos().find((item) => item.notePath === target) ?? null
    const transcript = video ? store.readTranscript(video.videoId) : null
    let sentences = Array.isArray(transcript?.sentences) ? transcript.sentences : []
    if (video && sentences.length === 0 && transcript?.text) {
      sentences = buildSentences(transcript.text)
    }
    const cleanText = transcript?.cleanText || (sentences.length ? sentencesToText(sentences) : transcript?.text || '')
    const translationCache = video ? store.readTranslation(video.videoId) : null
    const translation =
      typeof translationCache?.text === 'string'
        ? translationCache.text
        : Array.isArray(translationCache?.chunks)
          ? translationCache.chunks.map((chunk) => chunk.translated || chunk.source).join('\n')
          : ''
    return {
      path: target,
      markdown: readFileSync(target, 'utf8'),
      size: statSync(target).size,
      video: video
        ? {
            videoId: video.videoId,
            watchSessions: Number(video.watchSessions ?? 0),
            liveCaptions: video.liveCaptions === true,
            translated: video.translated === true,
            translationStatus: String(video.translationStatus ?? ''),
            summaryStatus: String(video.summaryStatus ?? ''),
            summaryError: String(video.summaryError ?? ''),
            summaryStage: String(video.summaryStage ?? ''),
            translationDoneChunks: Number(video.translationDoneChunks ?? 0),
            translationTotalChunks: Number(video.translationTotalChunks ?? 0),
            translationStale: Boolean(
              video.translationHash && video.transcriptHash && video.translationHash !== video.transcriptHash,
            ),
            tokenUsage: video.tokenUsage ?? null,
            paragraphs: Array.isArray(video.paragraphs) ? video.paragraphs : [],
            expressions: Array.isArray(video.expressions) ? video.expressions : [],
          }
        : null,
      sentences,
      cleanText,
      translation,
    }
  }

  async function reveal(input) {
    const target = resolveNotePath(input)
    await execFileP('open', ['-R', target])
    return { path: target }
  }

  return { root, list, readNote, reveal }
}
