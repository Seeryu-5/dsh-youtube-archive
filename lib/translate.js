import { createHash } from 'node:crypto'
import { emptyUsage, mergeUsage, usageFromChunk } from './llm-usage.js'
import { resolveModel } from './summarize.js'

const MAX_LOG_CHARS = 3000

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 20)
}

/** True when the transcript is already Chinese and does not need translation. */
export function mostlyChinese(text, lang = '') {
  if (lang && /^zh/i.test(lang)) return true
  const sample = [...String(text ?? '')].filter((char) => !/\s/.test(char)).slice(0, 3000)
  if (sample.length === 0) return false
  const cjk = sample.filter((char) => /[\u3400-\u9fff]/.test(char)).length
  const kana = sample.filter((char) => /[\u3040-\u30ff]/.test(char)).length
  return cjk / sample.length > 0.5 && kana / sample.length < 0.05
}

/** Split by lines, preserving timestamps, without exceeding maxChars per chunk. */
export function splitTranscriptChunks(text, maxChars = 6000) {
  const limit = Math.max(500, Number(maxChars) || 6000)
  const lines = String(text ?? '').split('\n')
  const chunks = []
  let buffer = []
  let size = 0

  function flush() {
    if (buffer.length) chunks.push(buffer.join('\n'))
    buffer = []
    size = 0
  }

  for (const rawLine of lines) {
    let line = rawLine
    if ([...line].length > limit) {
      flush()
      const chars = [...line]
      for (let i = 0; i < chars.length; i += limit) chunks.push(chars.slice(i, i + limit).join(''))
      continue
    }
    if (size + line.length + 1 > limit && buffer.length) flush()
    buffer.push(line)
    size += line.length + 1
  }
  flush()
  return chunks.filter((chunk) => chunk.trim())
}

function cleanModelText(text) {
  return String(text ?? '')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

async function callModel(ctx, config, system, user) {
  const model = resolveModel(ctx, config)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('翻译超时')), 120000)
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: Math.min(config.maxTokens || 8000, 5000),
      reasoningEffort: config.reasoningEffort,
      signal: ac.signal,
    })
    let text = ''
    let lastUsage = null
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      const sample = usageFromChunk(chunk)
      if (sample) lastUsage = sample
    }
    const usage = mergeUsage(emptyUsage(), lastUsage)
    const cleaned = cleanModelText(text)
    if (!cleaned) throw new Error('翻译模型返回为空（可能输出 token 不足）')
    return { text: cleaned, usage }
  } finally {
    clearTimeout(timer)
  }
}

const SYSTEM_PROMPT = [
  '你是专业的字幕翻译。把用户给出的带时间戳字幕逐行翻译成简体中文。',
  '规则：',
  '1. 保留每行开头的 [mm:ss] 或 [h:mm:ss] 时间戳，逐行对应输出。',
  '2. 只翻译，不总结、不解释、不增删内容；专有名词保留原文。',
  '3. 音乐/掌声等标记译为 [音乐] / [掌声]。',
  '4. 输出纯文本，不要 Markdown 代码围栏。',
  '5. 如果原文已经是中文，原样输出。',
].join('\n')

function splitChunkInHalf(chunk) {
  const lines = String(chunk).split('\n')
  if (lines.length > 1) {
    const mid = Math.ceil(lines.length / 2)
    return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')]
  }
  const chars = [...String(chunk)]
  const mid = Math.ceil(chars.length / 2)
  return [chars.slice(0, mid).join(''), chars.slice(mid).join('')]
}

async function translateChunk(ctx, config, chunk, label, depth = 0) {
  try {
    const response = await callModel(ctx, config, SYSTEM_PROMPT, `${label}\n\n${chunk}`)
    return { text: response.text, usage: response.usage }
  } catch (error) {
    // Empty output often means the chunk is too large for the output budget.
    // Split once and retry both halves before giving up.
    if (depth === 0 && [...chunk].length >= 800) {
      const halves = splitChunkInHalf(chunk)
      if (halves.every((half) => half.trim())) {
        let text = ''
        let usage = emptyUsage()
        for (const [index, half] of halves.entries()) {
          const result = await translateChunk(ctx, config, half, `${label}（分片 ${index + 1}/2）`, depth + 1)
          usage = mergeUsage(usage, result.usage)
          text += `${text ? '\n' : ''}${result.text}`
        }
        return { text, usage }
      }
    }
    throw error
  }
}

/**
 * Translate at most `batchSize` pending chunks and return progress.
 * Never truncates the video to a fixed chunk count: the worker calls this
 * repeatedly until every chunk is translated.
 */
export async function translatePending(ctx, config, { store, videoId, text, lang = '', batchSize = 2 }) {
  if (!config.translateTranscript) return { translated: false, status: 'disabled', text: '', done: true, total: 0, doneChunks: 0 }
  const source = String(text ?? '').trim()
  if (!source) return { translated: false, status: 'empty', text: '', done: true, total: 0, doneChunks: 0 }
  if (mostlyChinese(source, lang)) return { translated: false, status: 'source-zh', text: '', done: true, total: 0, doneChunks: 0 }

  const allChunks = splitTranscriptChunks(source, config.translationChunkChars)
  const cache = store.readTranslation(videoId) ?? { chunks: [] }
  const cacheByHash = new Map((cache.chunks ?? []).filter(Boolean).map((entry) => [entry.hash, entry]))
  const entries = allChunks.map((chunk) => ({ chunk, hash: hashText(chunk) }))
  const pending = entries.filter((entry) => !cacheByHash.get(entry.hash)?.translated)
  const selected = pending.slice(0, Math.max(1, Number(batchSize) || 1))
  let usage = emptyUsage()

  for (const [index, entry] of selected.entries()) {
    try {
      const result = await translateChunk(
        ctx,
        config,
        entry.chunk,
        `这是第 ${index + 1}/${Math.max(1, selected.length)} 段字幕，请翻译：`,
      )
      usage = mergeUsage(usage, result.usage)
      cacheByHash.set(entry.hash, {
        hash: entry.hash,
        source: entry.chunk,
        translated: result.text,
        createdAt: new Date().toISOString(),
      })
    } catch (error) {
      cacheByHash.set(entry.hash, {
        hash: entry.hash,
        source: entry.chunk,
        translated: '',
        error: String(error?.message ?? error).slice(0, 200),
      })
    }
    store.writeTranslation(videoId, {
      sourceLang: lang || cache.sourceLang || '',
      chunks: entries.map((item) => cacheByHash.get(item.hash)).filter(Boolean),
      doneChunks: entries.filter((item) => cacheByHash.get(item.hash)?.translated).length,
      totalChunks: entries.length,
      status: 'translating',
    })
  }

  const results = entries.map((entry) => cacheByHash.get(entry.hash)).filter(Boolean)
  const doneCount = results.filter((entry) => entry?.translated).length
  const failedCount = results.filter((entry) => !entry?.translated && entry?.error).length
  const done = doneCount === entries.length
  const textOut = results.map((entry) => entry?.translated).filter(Boolean).join('\n')
  let status = 'translating'
  if (done) status = 'ok'
  else if (selected.length === pending.length && pending.length > 0) {
    status = doneCount === 0 ? 'failed' : failedCount > 0 ? 'partial' : 'translating'
  }

  store.writeTranslation(videoId, {
    sourceLang: lang || cache.sourceLang || '',
    chunks: results,
    text: textOut,
    status,
    done,
    totalChunks: entries.length,
    doneChunks: doneCount,
    failedChunks: failedCount,
    updatedAt: new Date().toISOString(),
  })

  return {
    translated: doneCount > 0,
    status,
    text: textOut,
    lang,
    done,
    total: entries.length,
    doneChunks: doneCount,
    failedChunks: failedCount,
    pending: entries.length - doneCount,
    chunks: entries.length,
    chars: [...textOut].length,
    usage,
  }
}

/** Synchronous full translation used by tests/manual code. */
export async function translateTranscript(ctx, config, { store, videoId, text, lang = '' }) {
  const result = await translatePending(ctx, config, {
    store,
    videoId,
    text,
    lang,
    batchSize: Number.MAX_SAFE_INTEGER,
  })
  return {
    ...result,
    translated: result.status === 'ok' || result.doneChunks > 0,
    truncated: false,
    chunks: result.total || 0,
  }
}

export function logTranslation(store, videoId, result) {
  if (!result) return
  store.log({
    type: 'translate',
    videoId,
    status: result.status,
    chunks: result.chunks ?? 0,
    chars: result.chars ?? 0,
    truncated: Boolean(result.truncated),
  })
}

export function clipForNote(text, maxChars) {
  const chars = [...String(text ?? '')]
  const limit = Math.max(1000, Number(maxChars) || 24000)
  if (chars.length <= limit) return { text: chars.join(''), truncated: false }
  return {
    text: chars.slice(0, limit).join(''),
    truncated: true,
    omitted: chars.length - limit,
  }
}

export { MAX_LOG_CHARS }
