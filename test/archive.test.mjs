import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { rebuildDaily, rebuildIndex, renderNote, writeNote } from '../lib/archive.js'
import { cleanup, tempDir } from './helpers.mjs'

function setup() {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir })
  const store = createStore(config)
  store.upsertVideo('abc123DEF45', {
    videoId: 'abc123DEF45',
    title: '微积分入门',
    channel: '测试频道',
    durationSec: 600,
    firstWatchedAt: '2026-11-19T04:00:00.000Z',
    lastWatchedAt: '2026-11-19T05:00:00.000Z',
    watchedSec: 300,
    maxProgressSec: 240,
    watchSessions: 1,
    category: '教育与学习',
    tags: ['数学'],
    oneLine: '一句话总结',
  })
  return { dir, config, store }
}

const info = {
  videoId: 'abc123DEF45',
  title: '微积分入门',
  channel: '测试频道',
  durationSec: 600,
  description: '这是一节微积分课程。',
  chapters: [{ title: '极限', startSec: 65 }],
  published: '2026-11-12',
}

const summary = {
  summary: '一句话总结。',
  content_type: '课程',
  category: '教育与学习',
  tags: ['数学', '微积分'],
  key_points: ['极限的定义', '导数的直觉'],
  outline: [{ heading: '极限', points: ['趋近', '连续'] }],
  quotes: [{ t: '1:05', seconds: 65, text: '极限是……' }],
  actions: ['复习第一章'],
  confidence: 'high',
}

test('writeNote renders front matter, body, category folder and links', () => {
  const { dir, config, store } = setup()
  try {
    const rec = store.getVideo('abc123DEF45')
    const path = writeNote({ config, rec, info, summary, transcriptAvailable: true, stage: '精读', model: 'p/m' })
    assert.ok(existsSync(path))
    assert.match(path, /教育与学习/)
    const text = readFileSync(path, 'utf8')
    assert.match(text, /^---\n/)
    assert.match(text, /title: "微积分入门"/)
    assert.match(text, /summary_stage: "精读"/)
    assert.match(text, /transcript: true/)
    assert.match(text, /## 核心要点/)
    assert.match(text, /## 值得回看的时间点/)
    assert.match(text, /\[1:05\]\(https:\/\/youtu\.be\/abc123DEF45\?t=65\)/)
    assert.match(text, /## 章节/)
    assert.match(text, /## 归档信息/)
    assert.equal(readFileSync(path, 'utf8').includes('一句话总结。'), true)
  } finally {
    cleanup(dir)
  }
})

test('writeNote includes paragraph notes and English expressions', () => {
  const { dir, config, store } = setup()
  try {
    const rec = store.getVideo('abc123DEF45')
    const path = writeNote({
      config,
      rec,
      info,
      summary,
      transcriptAvailable: true,
      transcriptText: '[0:00] Hello world.',
      paragraphs: [
        { start: '0:00', end: '1:20', startSec: 0, endSec: 80, title: '开场', gist: '介绍主题', points: ['细节'] },
      ],
      expressions: [{ phrase: 'come up with', meaning: '想出', usage: '提出想法', example: 'She came up with a plan.' }],
      stage: '精读',
      model: 'p/m',
    })
    const text = readFileSync(path, 'utf8')
    assert.match(text, /paragraph_count: 1/)
    assert.match(text, /expression_count: 1/)
    assert.match(text, /## 段落笔记/)
    assert.match(text, /\[0:00–1:20\] 开场/)
    assert.match(text, /## 常用英文表达/)
    assert.match(text, /come up with/)
  } finally {
    cleanup(dir)
  }
})

test('writeNote includes live transcript and Chinese translation', () => {
  const { dir, config, store } = setup()
  try {
    const rec = store.getVideo('abc123DEF45')
    const path = writeNote({
      config,
      rec,
      info,
      summary,
      transcriptAvailable: true,
      transcriptText: '[0:01] Hello world\n[0:03] Second line',
      translation: { translated: true, status: 'ok', text: '[0:01] 你好世界\n[0:03] 第二行' },
      liveCaptions: true,
      stage: '精读',
      model: 'p/m',
    })
    const text = readFileSync(path, 'utf8')
    assert.match(text, /transcript_chars: \d+/)
    assert.match(text, /live_captions: true/)
    assert.match(text, /translated: true/)
    assert.match(text, /translation_status: "ok"/)
    assert.match(text, /## 字幕译文（中文）/)
    assert.match(text, /## 字幕原文（实时字幕）/)
    assert.match(text, /你好世界/)
    assert.match(text, /Hello world/)
  } finally {
    cleanup(dir)
  }
})

test('renderNote renders a pending placeholder without a failure message', () => {
  const { dir, config, store } = setup()
  try {
    const text = renderNote({
      rec: store.getVideo('abc123DEF45'),
      info,
      summary: null,
      transcriptAvailable: true,
      transcriptText: '[0:00] Hello.',
      summaryStatus: 'pending',
      stage: '初版',
      model: 'p/m',
    })
    assert.match(text, /summary_status: "pending"/)
    assert.match(text, /正在记录字幕/)
    assert.doesNotMatch(text, /摘要生成失败/)
  } finally {
    cleanup(dir)
  }
})

test('renderNote degrades gracefully without a summary', () => {
  const { config, store, dir } = setup()
  try {
    const text = renderNote({
      rec: store.getVideo('abc123DEF45'),
      info,
      summary: null,
      transcriptAvailable: false,
      stage: '初版',
      model: 'p/m',
      error: 'LLM 超时',
    })
    assert.match(text, /摘要生成失败/)
    assert.match(text, /basis: "简介\/章节"/)
    assert.match(text, /LLM 超时/)
  } finally {
    cleanup(dir)
  }
})

test('category change moves the note rather than duplicating it', () => {
  const { dir, config, store } = setup()
  try {
    const rec = store.getVideo('abc123DEF45')
    const first = writeNote({ config, rec, info, summary, transcriptAvailable: true, stage: '精读', model: 'p/m' })
    store.upsertVideo('abc123DEF45', { notePath: first })
    const nextSummary = { ...summary, category: 'AI与技术' }
    const second = writeNote({
      config,
      rec: store.getVideo('abc123DEF45'),
      info,
      summary: nextSummary,
      transcriptAvailable: true,
      stage: '精读',
      model: 'p/m',
    })
    assert.notEqual(first, second)
    assert.equal(existsSync(first), false)
    assert.ok(existsSync(second))
    assert.match(second, /AI与技术/)
    const files = readdirSync(join(dir, '教育与学习')).filter((name) => name.endsWith('.md'))
    assert.deepEqual(files, [])
  } finally {
    cleanup(dir)
  }
})

test('rebuildIndex and rebuildDaily summarize state', () => {
  const { dir, config, store } = setup()
  try {
    const rec = store.getVideo('abc123DEF45')
    const path = writeNote({ config, rec, info, summary, transcriptAvailable: true, stage: '精读', model: 'p/m' })
    store.upsertVideo('abc123DEF45', { notePath: path, category: '教育与学习', tags: ['数学'] })
    rebuildIndex(config, store)
    rebuildDaily(config, store)
    const index = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.match(index, /# YouTube 知识库/)
    assert.match(index, /微积分入门/)
    assert.match(index, /教育与学习/)
    const daily = readFileSync(join(dir, 'daily', '2026-11-19.md'), 'utf8')
    assert.match(daily, /观看摘要/)
    assert.match(daily, /微积分入门/)
  } finally {
    cleanup(dir)
  }
})
