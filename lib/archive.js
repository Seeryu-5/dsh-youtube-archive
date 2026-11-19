import { existsSync, renameSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  atomicWrite,
  ensureDir,
  formatClock,
  formatDurationText,
  localDateString,
  nowIso,
  sanitizeFilename,
} from './util.js'

function yamlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value ?? '')
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function noteDate(rec) {
  const source = rec.firstWatchedAt || rec.createdAt || nowIso()
  return localDateString(new Date(source))
}

function watchedDate(video) {
  const source = video.lastWatchedAt || video.firstWatchedAt || video.createdAt
  if (!source) return localDateString(new Date())
  return localDateString(new Date(source))
}

function safeCategory(category, config) {
  const name = config.categories.includes(category) ? category : '其他'
  return { name, dir: sanitizeFilename(name, 40) }
}

function linkFor(videoId, seconds = null) {
  return seconds === null
    ? `https://www.youtube.com/watch?v=${videoId}`
    : `https://youtu.be/${videoId}?t=${Math.max(0, Math.floor(seconds))}`
}

function escapePipe(value) {
  return String(value ?? '')
    .replace(/\n/g, ' ')
    .replace(/\|/g, '\\|')
    .trim()
}

function descriptionExcerpt(text, max = 1200) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max)}……`
}

function clipText(text, maxChars) {
  const chars = [...String(text ?? '')]
  const limit = Math.max(1000, Number(maxChars) || 24000)
  if (chars.length <= limit) return { text: chars.join(''), truncated: false }
  return { text: chars.slice(0, limit).join(''), truncated: true }
}

/** Render the complete Markdown note (front matter + body). */
export function renderNote({
  rec,
  info,
  summary,
  transcriptAvailable,
  transcriptText = '',
  translation = null,
  liveCaptions = false,
  paragraphs = [],
  expressions = [],
  stage,
  model,
  error,
  summaryStatus = '',
  tokenUsage = null,
  maxTranscriptChars = 24000,
}) {
  const videoId = rec.videoId
  const title = info?.title || rec.title || `YouTube 视频 ${videoId}`
  const channel = info?.channel || rec.channel || ''
  const durationSec = Number(info?.durationSec || rec.durationSec || 0)
  const tags = Array.isArray(summary?.tags) && summary.tags.length ? summary.tags : rec.tags ?? []
  const category = summary?.category || rec.category || '其他'
  const confidence = summary?.confidence || 'low'
  const basis = transcriptAvailable ? '字幕' : '简介/章节'
  const stageLabel = stage || rec.summaryStage || '初版'
  const totalWatched = Number(rec.watchedSec ?? 0)
  const progress = durationSec > 0 ? Math.min(100, Math.round((Number(rec.maxProgressSec ?? 0) / durationSec) * 100)) : 0

  const front = [
    '---',
    `title: ${yamlValue(title)}`,
    `channel: ${yamlValue(channel)}`,
    `url: ${yamlValue(linkFor(videoId))}`,
    `video_id: ${yamlValue(videoId)}`,
    `duration_sec: ${Math.round(durationSec)}`,
    `category: ${yamlValue(category)}`,
    `tags: ${yamlValue(tags)}`,
    `published: ${yamlValue(info?.published || '')}`,
    `first_watched: ${yamlValue(rec.firstWatchedAt || nowIso())}`,
    `last_watched: ${yamlValue(rec.lastWatchedAt || nowIso())}`,
    `max_progress_sec: ${Math.round(Number(rec.maxProgressSec ?? 0))}`,
    `total_watched_sec: ${Math.round(totalWatched)}`,
    `watch_sessions: ${Number(rec.watchSessions ?? 0)}`,
    `summary_stage: ${yamlValue(stageLabel)}`,
    `summary_status: ${yamlValue(summaryStatus || (summary ? 'ok' : 'failed'))}`,
    `summary_error: ${yamlValue(summary ? '' : String(error || '').slice(0, 300))}`,
    `token_usage_total: ${Math.round(Number(tokenUsage?.totalTokens ?? 0))}`,
    `transcript: ${Boolean(transcriptAvailable)}`,
    `transcript_chars: ${[...String(transcriptText ?? '')].length}`,
    `live_captions: ${Boolean(liveCaptions)}`,
    `translated: ${Boolean(translation?.translated)}`,
    `translation_status: ${yamlValue(translation?.status || '')}`,
    `paragraph_count: ${Array.isArray(paragraphs) ? paragraphs.length : 0}`,
    `expression_count: ${Array.isArray(expressions) ? expressions.length : 0}`,
    `basis: ${yamlValue(basis)}`,
    `content_type: ${yamlValue(summary?.content_type || rec.contentType || '其他')}`,
    `confidence: ${yamlValue(confidence)}`,
    `model: ${yamlValue(model || rec.model || '')}`,
    '---',
    '',
  ]

  const body = [`# ${title}`, '']
  if (summary?.summary) {
    body.push(`> ${summary.summary}`, '')
  } else if (summaryStatus === 'pending') {
    body.push('> ⏳ 正在记录字幕与译文；总结可在知识库中手动生成。', '')
  } else if (summaryStatus === 'none') {
    body.push('> 字幕与译文已保存。打开知识库，在「总结」页签点击「生成总结」即可生成摘要、段落笔记和英文表达。', '')
  } else if (summaryStatus === 'stale') {
    body.push('> 字幕已更新，之前的总结已过期。可在知识库中点击「重新生成总结」。', '')
  } else {
    body.push('> （摘要生成失败：已保存元数据与观看记录，可稍后在 DSH 里用 `youtube_archive_summarize` 重试。）', '')
    if (error) body.push(`> 错误：${String(error).slice(0, 300)}`, '')
  }

  body.push(
    `- 频道：${channel || '未知'}`,
    `- 时长：${durationSec > 0 ? formatDurationText(durationSec) : '未知'}`,
    `- 分类：${category}${summary?.content_type ? ` · ${summary.content_type}` : ''}`,
    tags.length ? `- 标签：${tags.join('、')}` : '- 标签：—',
    `- 观看：有效 ${formatDurationText(totalWatched)}，进度 ${progress}%（${Number(rec.watchSessions ?? 0)} 次）`,
    `- 依据：${basis}`,
    `- 链接：${linkFor(videoId)}`,
    '',
  )

  if (Array.isArray(summary?.key_points) && summary.key_points.length) {
    body.push('## 核心要点', '')
    for (const point of summary.key_points) body.push(`- ${point}`)
    body.push('')
  }

  if (Array.isArray(summary?.outline) && summary.outline.length) {
    body.push('## 知识结构', '')
    for (const section of summary.outline) {
      body.push(`### ${section.heading}`)
      for (const point of section.points ?? []) body.push(`- ${point}`)
      body.push('')
    }
  }

  if (Array.isArray(summary?.quotes) && summary.quotes.length) {
    body.push('## 值得回看的时间点', '')
    for (const quote of summary.quotes) {
      const seconds = Number(quote.seconds ?? 0)
      body.push(`- [${quote.t}](${linkFor(videoId, seconds)}) ${quote.text}`)
    }
    body.push('')
  }

  if (Array.isArray(summary?.actions) && summary.actions.length) {
    body.push('## 我的行动项', '')
    for (const action of summary.actions) body.push(`- [ ] ${action}`)
    body.push('')
  }

  if (Array.isArray(info?.chapters) && info.chapters.length) {
    body.push('## 章节', '')
    for (const chapter of info.chapters) {
      body.push(`- [${formatClock(chapter.startSec)}](${linkFor(videoId, chapter.startSec)}) ${chapter.title}`)
    }
    body.push('')
  }

  if (Array.isArray(paragraphs) && paragraphs.length) {
    body.push('## 段落笔记', '')
    for (const paragraph of paragraphs) {
      const range = `${paragraph.start || formatClock(paragraph.startSec)}–${paragraph.end || formatClock(paragraph.endSec)}`
      body.push(`### [${range}] ${paragraph.title || '段落'}`, '')
      if (paragraph.gist) body.push(paragraph.gist, '')
      for (const point of paragraph.points ?? []) body.push(`- ${point}`)
      body.push('')
    }
  }

  if (Array.isArray(expressions) && expressions.length) {
    body.push('## 常用英文表达', '')
    body.push('| 表达 | 中文 | 用法 | 例句 |')
    body.push('| --- | --- | --- | --- |')
    for (const expression of expressions) {
      body.push(
        `| ${escapePipe(expression.phrase)} | ${escapePipe(expression.meaning)} | ${escapePipe(
          expression.usage,
        )} | ${escapePipe(expression.example)} |`,
      )
    }
    body.push('')
  }

  if (info?.description) {
    body.push('## 视频简介', '', descriptionExcerpt(info.description), '')
  }

  if (transcriptText) {
    const clippedOriginal = clipText(transcriptText, maxTranscriptChars)
    if (translation?.text) {
      body.push('## 字幕译文（中文）', '', clipText(translation.text, maxTranscriptChars).text, '')
      if (translation.status && translation.status !== 'ok') {
        body.push(`> 翻译状态：${translation.status === 'partial' ? '部分完成' : '失败'}`, '')
      }
    } else if (translation && translation.status && translation.status !== 'source-zh' && translation.status !== 'disabled') {
      body.push('## 字幕译文（中文）', '', '（本次未生成译文，稍后重试可补上）', '')
    }
    body.push(`## 字幕原文${liveCaptions ? '（实时字幕）' : ''}`, '', clippedOriginal.text, '')
    if (clippedOriginal.truncated) {
      body.push(`> 字幕较长，笔记中仅保留前 ${maxTranscriptChars} 字；完整内容见 \`.state/transcripts/${videoId}.json\`。`, '')
    }
  }

  body.push(
    '## 归档信息',
    '',
    `- 首次观看：${rec.firstWatchedAt || '—'}`,
    `- 最近观看：${rec.lastWatchedAt || '—'}`,
    `- 最大进度：${formatClock(rec.maxProgressSec ?? 0)} / ${durationSec > 0 ? formatClock(durationSec) : '未知'}`,
    `- 摘要阶段：${stageLabel}（${basis}）`,
    `- 摘要模型：${model || rec.model || '—'}`,
    '',
  )

  return [...front, ...body].join('\n')
}

/**
 * Write (or move + rewrite) the note for a video. Returns the absolute path.
 */
export function writeNote({
  config,
  rec,
  info,
  summary,
  transcriptAvailable,
  transcriptText = '',
  translation = null,
  liveCaptions = false,
  paragraphs = [],
  expressions = [],
  stage,
  model,
  error,
  summaryStatus = '',
  tokenUsage = null,
}) {
  const category = safeCategory(summary?.category || rec.category || '其他', config)
  const dir = join(config.outputDir, category.dir)
  ensureDir(dir)
  const title = info?.title || rec.title || rec.videoId
  const filename = `${noteDate(rec)}-${sanitizeFilename(title, 70)}-${rec.videoId}.md`
  const target = join(dir, filename)
  const content = renderNote({
    rec,
    info,
    summary,
    transcriptAvailable,
    transcriptText,
    translation,
    liveCaptions,
    paragraphs,
    expressions,
    stage,
    model,
    error,
    summaryStatus,
    tokenUsage,
    maxTranscriptChars: config.noteTranscriptMaxChars,
  })

  if (rec.notePath && rec.notePath !== target && existsSync(rec.notePath)) {
    try {
      if (existsSync(target)) renameSync(target, `${target}.old-${Date.now()}`)
      renameSync(rec.notePath, target)
    } catch {
      /* fall through: the new file below is still written */
    }
  }
  atomicWrite(target, `${content}\n`)
  return target
}

function relativeLink(outputDir, path) {
  const rel = relative(outputDir, path).split('\\').join('/')
  return /\s|[()<>]/.test(rel) ? `<${rel}>` : rel
}

function videosWithNotes(store) {
  return store
    .allVideos()
    .filter((video) => video.notePath && existsSync(video.notePath))
    .sort((a, b) => String(b.lastWatchedAt ?? '').localeCompare(String(a.lastWatchedAt ?? '')))
}

/** Rebuild index.md from state (no note re-parsing). */
export function rebuildIndex(config, store) {
  const videos = videosWithNotes(store)
  const groups = new Map()
  for (const video of videos) {
    const category = config.categories.includes(video.category) ? video.category : '其他'
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category).push(video)
  }
  const ordered = [
    ...config.categories.filter((category) => groups.has(category)),
    ...[...groups.keys()].filter((category) => !config.categories.includes(category)),
  ]

  const totalWatched = videos.reduce((sum, video) => sum + Number(video.watchedSec ?? 0), 0)
  const lines = [
    '# YouTube 知识库',
    '',
    `> 共 ${videos.length} 个视频，累计有效观看 ${formatDurationText(totalWatched)}。`,
    `> 更新于 ${new Date().toLocaleString('zh-CN', { hour12: false })}。`,
    '',
    '## 分类',
    '',
    '| 分类 | 视频数 |',
    '| --- | ---: |',
  ]
  for (const category of ordered) {
    lines.push(`| ${escapeCell(category)} | ${groups.get(category).length} |`)
  }
  lines.push('')

  for (const category of ordered) {
    lines.push(`## ${category}（${groups.get(category).length}）`, '')
    lines.push('| 日期 | 标题 | 频道 | 时长 | 观看 | 标签 |')
    lines.push('| --- | --- | --- | ---: | ---: | --- |')
    for (const video of groups.get(category)) {
      const date = watchedDate(video)
      const link = relativeLink(config.outputDir, video.notePath)
      lines.push(
        `| ${escapeCell(date)} | [${escapeCell(video.title)}](${link}) | ${escapeCell(video.channel)} | ${
          Number(video.durationSec) > 0 ? formatClock(video.durationSec) : '—'
        } | ${formatDurationText(video.watchedSec ?? 0)} | ${escapeCell((video.tags ?? []).join('、'))} |`,
      )
    }
    lines.push('')
  }

  atomicWrite(join(config.outputDir, 'index.md'), `${lines.join('\n')}\n`)
}

/** Rebuild daily/YYYY-MM-DD.md digests for every date present in state. */
export function rebuildDaily(config, store) {
  const videos = videosWithNotes(store)
  const groups = new Map()
  for (const video of videos) {
    const date = watchedDate(video)
    if (!groups.has(date)) groups.set(date, [])
    groups.get(date).push(video)
  }
  for (const [date, items] of groups) {
    const watched = items.reduce((sum, video) => sum + Number(video.watchedSec ?? 0), 0)
    const categories = new Map()
    for (const video of items) categories.set(video.category ?? '其他', (categories.get(video.category ?? '其他') ?? 0) + 1)
    const lines = [
      `# ${date} 观看摘要`,
      '',
      `> ${items.length} 个视频，累计有效观看 ${formatDurationText(watched)}。`,
      `> 分类：${[...categories.entries()].map(([name, count]) => `${name} ${count}`).join(' · ')}`,
      '',
    ]
    for (const video of items) {
      lines.push(
        `- [${video.title}](https://www.youtube.com/watch?v=${video.videoId}) — ${video.oneLine || '（未生成摘要）'}（${formatDurationText(
          video.watchedSec ?? 0,
        )}）`,
      )
    }
    lines.push('')
    atomicWrite(join(config.outputDir, 'daily', `${date}.md`), `${lines.join('\n')}\n`)
  }
}

export function updateIndexes(config, store) {
  rebuildIndex(config, store)
  rebuildDaily(config, store)
}
