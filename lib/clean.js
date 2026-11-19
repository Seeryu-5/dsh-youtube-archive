import { createHash } from 'node:crypto'
import { emptyUsage, mergeUsage, usageFromChunk } from './llm-usage.js'
import { resolveModel } from './summarize.js'
import { splitTranscriptChunks } from './translate.js'

function hashText(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 20)
}

function cleanModelText(text) {
  return String(text ?? '')
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

async function callModel(ctx, config, user) {
  const model = resolveModel(ctx, config)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('字幕校对超时')), 120000)
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system: [
        '你是字幕校对编辑。把碎片化、逐词滚动、错误断句的自动字幕整理成通顺、完整的句子。',
        '规则：',
        '1. 保留每行开头的 [mm:ss] 或 [h:mm:ss] 时间戳；时间戳顺序不变，不重复。',
        '2. 合并被错误切开的句子；删除 uh/um 等填充词、口吃与重复词、>> 等说话人标记；补全大小写和标点。',
        '3. 不增加原文没有的事实、数字或观点；不确定时保留原意。',
        '4. 输出纯文本，每行一个完整句子并以 [时间戳] 开头；不要解释、不要 Markdown 代码块。',
        '5. 输出语言与原文一致。',
      ].join('\n'),
      messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
      maxTokens: Math.min(config.maxTokens || 8000, 4000),
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
    return { text: cleanModelText(text), usage }
  } finally {
    clearTimeout(timer)
  }
}

function validateCleaned(output, source) {
  const lines = String(output || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''
  const timed = lines.filter((line) => /^\[[0-9:.]+\]/.test(line))
  if (timed.length === 0) return ''
  // If the model drops most timestamps, keep the original chunk instead.
  if (timed.length / lines.length < 0.6) return ''
  return timed.join('\n')
}

/**
 * LLM pass that turns fragmented ASR lines into complete sentences while
 * preserving timestamps. Cached per source chunk so growing live captions only
 * clean the newly appended part.
 */
export async function cleanTranscript(ctx, config, { store, videoId, text }) {
  if (!config.cleanTranscript) return { text: '', status: 'disabled', chunks: 0, truncated: false }
  const source = String(text ?? '').trim()
  if (!source) return { text: '', status: 'empty', chunks: 0, truncated: false }

  const allChunks = splitTranscriptChunks(source, config.cleanChunkChars)
  const selected = allChunks.slice(0, config.cleanMaxChunks)
  const truncated = allChunks.length > selected.length
  const cache = store.readClean(videoId) ?? { chunks: [] }
  const cacheByHash = new Map((cache.chunks ?? []).map((entry) => [entry.hash, entry]))
  const results = []
  let failed = 0
  let usage = emptyUsage()

  for (const chunk of selected) {
    const hash = hashText(chunk)
    let entry = cacheByHash.get(hash)
    if (!entry || !entry.cleaned) {
      try {
        const response = await callModel(ctx, config, `请整理下面这段自动字幕：\n\n${chunk}`)
        usage = mergeUsage(usage, response.usage)
        const cleaned = validateCleaned(response.text, chunk)
        if (!cleaned) throw new Error('模型输出缺少时间戳')
        entry = { hash, source: chunk, cleaned, createdAt: new Date().toISOString() }
      } catch (error) {
        failed++
        entry = { hash, source: chunk, cleaned: '', error: String(error?.message ?? error).slice(0, 200) }
      }
      cacheByHash.set(hash, entry)
      store.writeClean(videoId, { ...cache, chunks: [...cacheByHash.values()], truncated })
    }
    results.push(entry)
  }

  const textOut = results
    .map((entry) => entry.cleaned || entry.source)
    .filter(Boolean)
    .join('\n')
  let status = 'ok'
  if (failed > 0) status = failed === selected.length ? 'failed' : 'partial'
  if (truncated && status === 'ok') status = 'partial'
  if (status === 'failed') return { text: '', status, chunks: selected.length, truncated, usage }

  const output = truncated
    ? `${textOut}\n\n……（字幕较长，仅校对了前 ${selected.length} 段；完整原文见 .state/transcripts）……`
    : textOut
  store.writeClean(videoId, {
    ...cache,
    chunks: [...cacheByHash.values()],
    text: output,
    status,
    truncated,
    updatedAt: new Date().toISOString(),
  })
  return { text: output, status, chunks: selected.length, truncated, usage }
}
