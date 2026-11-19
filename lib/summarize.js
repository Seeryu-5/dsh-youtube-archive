import { emptyUsage, mergeUsage, usageFromChunk } from './llm-usage.js'
import { formatClock, formatDurationText, parseClock } from './util.js'

export const PROMPT_VERSION = '2026-11-19.3'

const CONTENT_TYPES = ['课程', '访谈', '新闻', '娱乐', '音乐', '其他']
const CONFIDENCE = ['high', 'medium', 'low']

export function resolveModel(ctx, config) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model }
  try {
    const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* ignore */
  }
  try {
    const providers = ctx.llm?.listProviders?.() ?? []
    for (const provider of providers) {
      const id = provider?.id
      const model = provider?.models?.[0]?.id ?? provider?.defaultModel ?? provider?.model
      if (id && model) return { provider: id, model }
    }
  } catch {
    /* ignore */
  }
  return { provider: 'deepseek-official', model: 'deepseek-flash' }
}

export function resolveModelLabel(ctx, config) {
  const model = resolveModel(ctx, config)
  return `${model.provider}/${model.model}`
}

async function callLlm(ctx, config, { system, messages }) {
  const model = resolveModel(ctx, config)
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('dsh-youtube-archive: LLM 调用超时')), 120000)
  try {
    const stream = ctx.llm.stream({
      provider: model.provider,
      model: model.model,
      system,
      messages,
      maxTokens: config.maxTokens,
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
    if (!text.trim()) {
      const error = new Error('LLM 返回为空（输出预算不足）')
      error.usage = usage
      throw error
    }
    return { text, model, usage }
  } finally {
    clearTimeout(timer)
  }
}

function clipTranscript(text, maxChars) {
  const chars = [...String(text ?? '')]
  if (chars.length <= maxChars) return chars.join('')
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${chars.slice(0, head).join('')}\n\n……（字幕过长，已省略中间部分）……\n\n${chars.slice(-tail).join('')}`
}

function buildMessages(config, { info, transcript, watch }) {
  const categories = config.categories.join(' / ')
  const system = [
    '你是「YouTube 观看归档助手」，负责把用户刚看过的视频整理成一篇可检索的中文知识笔记。',
    '硬性要求：',
    '1. 只依据给出的元数据、章节、简介和字幕，不编造事实、数字、人物或引语。',
    '2. 字幕可能来自自动识别，存在错别字；按上下文合理修正，不确定时降低 confidence。',
    '3. 输出必须是单个 JSON 对象，不要 Markdown 代码围栏，不要任何解释文字。',
    `4. 摘要语言：${config.summaryLanguage}。专有名词/产品名保留原文。`,
    `5. category 只能从这些分类中选择一个：${categories}。`,
    '6. quotes 的时间点必须来自字幕时间戳或章节，格式 "mm:ss" 或 "h:mm:ss"，且不超过视频时长；没有字幕时 quotes 必须为空数组。',
    '7. outline 为 2~4 个一级主题，每个主题 2~6 个要点；key_points 5~10 条；quotes 最多 5 条；actions 最多 5 条。',
    '8. 若视频信息不足（无字幕且简介很短），summary 要明确说明依据有限，confidence 设为 low。',
    '9. paragraphs：把内容按时间顺序分成 3~6 个段落笔记，start/end 必须来自字幕时间戳；每段给出标题、一句话要点和 2~5 个细点；没有字幕时返回空数组。',
    '10. expressions：仅当字幕是英文时，提取 4~8 个对中文学习者有用的常用英文表达/搭配/地道说法（优先短语/搭配，不要单个常用单词）；必须是字幕中真实出现的表达，给中文释义、使用场景和一个简短英文例句；中文字幕时返回空数组。',
    'JSON 结构：',
    '{"summary":"2~4 句总结","content_type":"课程|访谈|新闻|娱乐|音乐|其他","category":"分类名","tags":["标签"],"key_points":["要点"],"outline":[{"heading":"主题","points":["要点"]}],"quotes":[{"t":"12:34","text":"原话要点"}],"actions":["可执行动作"],"confidence":"high|medium|low","paragraphs":[{"start":"0:00","end":"1:20","title":"段落标题","gist":"一句话","points":["细点"]}],"expressions":[{"phrase":"come up with","meaning":"想出","usage":"提出想法/方案","example":"She came up with a good plan."}]}',
  ].join('\n')

  const chapterLines = (info.chapters ?? [])
    .slice(0, 40)
    .map((chapter) => `[${formatClock(chapter.startSec)}] ${chapter.title}`)
    .join('\n')
  const description = String(info.description ?? '').trim().slice(0, 3000)
  const duration = Number(info.durationSec ?? 0)
  const progress = duration > 0 ? Math.min(100, Math.round((Number(watch?.maxProgressSec ?? 0) / duration) * 100)) : 0

  const user = [
    `视频标题：${info.title || '（未知）'}`,
    `频道：${info.channel || '（未知）'}`,
    `时长：${duration > 0 ? formatClock(duration) : '未知'}`,
    `发布日期：${info.published || '未知'}`,
    `分类候选：${categories}`,
    '',
    '章节：',
    chapterLines || '（无章节）',
    '',
    '简介：',
    description || '（无简介）',
    '',
    `观看情况：有效观看 ${formatDurationText(watch?.totalWatchedSec ?? 0)}，进度 ${progress}%。`,
    '',
    transcript
      ? `字幕（带时间戳，可能被截断）：\n${transcript}`
      : '字幕：无可用字幕。只能依据标题、频道、简介和章节整理；不要编造具体内容、数字或引语。',
  ].join('\n')

  return { system, messages: [{ role: 'user', content: [{ type: 'text', text: user }] }] }
}

function firstJsonObject(text) {
  const at = text.indexOf('{')
  if (at === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = at; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(at, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function stringArray(value, max) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const text = item.trim()
    if (!text || out.includes(text)) continue
    out.push(text)
    if (out.length >= max) break
  }
  return out
}

function normalizeParagraphs(value, durationSec) {
  if (!Array.isArray(value)) return []
  const paragraphs = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const title = typeof item.title === 'string' ? item.title.trim() : ''
    const gist = typeof item.gist === 'string' ? item.gist.trim() : ''
    const points = stringArray(item.points, 6)
    if (!title && !gist) continue
    let startSec = parseClock(item.start)
    let endSec = parseClock(item.end)
    if (startSec === null) startSec = 0
    if (endSec === null) endSec = startSec
    if (durationSec > 0) {
      startSec = Math.min(startSec, durationSec)
      endSec = Math.min(Math.max(endSec, startSec), durationSec)
    }
    paragraphs.push({
      startSec,
      endSec: Math.max(startSec, endSec),
      start: formatClock(startSec),
      end: formatClock(Math.max(startSec, endSec)),
      title: title || `段落 ${paragraphs.length + 1}`,
      gist,
      points,
    })
    if (paragraphs.length >= 6) break
  }
  return paragraphs
}

function normalizeExpressions(value) {
  if (!Array.isArray(value)) return []
  const expressions = []
  const seen = new Set()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const phrase = typeof item.phrase === 'string' ? item.phrase.trim() : ''
    if (!phrase || !/[A-Za-z]/.test(phrase)) continue
    const key = phrase.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    expressions.push({
      phrase,
      meaning: typeof item.meaning === 'string' ? item.meaning.trim() : '',
      usage: typeof item.usage === 'string' ? item.usage.trim() : '',
      example: typeof item.example === 'string' ? item.example.trim() : '',
    })
    if (expressions.length >= 8) break
  }
  return expressions
}

/** Validate and normalize the model JSON; returns null when unusable. */
export function normalizeSummary(raw, { config, durationSec = 0, hasTranscript = false }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
  const keyPoints = stringArray(raw.key_points, 10)
  if (!summary && keyPoints.length === 0) return null

  const category = config.categories.includes(raw.category) ? raw.category : '其他'
  const contentType = CONTENT_TYPES.includes(raw.content_type) ? raw.content_type : '其他'

  const outline = []
  if (Array.isArray(raw.outline)) {
    for (const item of raw.outline) {
      if (!item || typeof item !== 'object') continue
      const heading = typeof item.heading === 'string' ? item.heading.trim() : ''
      const points = stringArray(item.points, 8)
      if (!heading && points.length === 0) continue
      outline.push({ heading: heading || '主题', points })
      if (outline.length >= 6) break
    }
  }

  const quotes = []
  if (hasTranscript && Array.isArray(raw.quotes)) {
    for (const item of raw.quotes) {
      if (!item || typeof item !== 'object') continue
      const text = typeof item.text === 'string' ? item.text.trim() : ''
      const seconds = parseClock(item.t)
      if (!text || seconds === null) continue
      if (durationSec > 0 && seconds > durationSec + 5) continue
      quotes.push({ t: formatClock(seconds), seconds, text })
      if (quotes.length >= 5) break
    }
  }

  const tags = stringArray(raw.tags, 10)
  const actions = stringArray(raw.actions, 5)
  const paragraphs = hasTranscript ? normalizeParagraphs(raw.paragraphs, durationSec) : []
  const expressions = hasTranscript ? normalizeExpressions(raw.expressions) : []

  return {
    summary,
    content_type: contentType,
    category,
    tags,
    key_points: keyPoints,
    outline,
    quotes,
    actions,
    paragraphs,
    expressions,
    confidence: CONFIDENCE.includes(raw.confidence) ? raw.confidence : 'medium',
  }
}

/** Ask the model for a structured note; retries once on malformed JSON. */
export async function summarizeVideo(ctx, config, { info, transcript, watch }) {
  const clipped = clipTranscript(transcript, config.transcriptMaxChars)
  const hasTranscript = Boolean(clipped.trim())
  const { system, messages } = buildMessages(config, { info, transcript: clipped, watch })

  let lastText = ''
  let lastError = null
  let usage = emptyUsage()
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const requestMessages =
        attempt === 0
          ? messages
          : [
              ...messages,
              { role: 'assistant', content: [{ type: 'text', text: lastText.slice(0, 4000) }] },
              {
                role: 'user',
                content: [{ type: 'text', text: '上面的输出不是合法 JSON。请只输出一个合法的 JSON 对象，不要代码围栏或解释。' }],
              },
            ]
      const { text, model, usage: callUsage } = await callLlm(ctx, config, { system, messages: requestMessages })
      usage = mergeUsage(usage, callUsage)
      lastText = text
      const parsed = firstJsonObject(text)
      const normalized = normalizeSummary(parsed, {
        config,
        durationSec: Number(info.durationSec ?? 0),
        hasTranscript,
      })
      if (normalized) return { ok: true, data: normalized, model, raw: text, usage }
      lastError = new Error('模型输出无法解析为有效摘要 JSON')
    } catch (error) {
      // Empty output usually means the model exhausted its output budget;
      // retrying immediately would spend the same tokens again for nothing.
      return { ok: false, error: String(error?.message ?? error), raw: lastText, usage: error?.usage ? mergeUsage(usage, error.usage) : usage }
    }
  }
  return { ok: false, error: String(lastError?.message ?? lastError ?? '未知错误'), raw: lastText, usage }
}
