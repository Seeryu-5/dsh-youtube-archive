import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { normalizeSummary, summarizeVideo } from '../lib/summarize.js'

const config = resolveConfig({ outputDir: '/tmp/dsh-yt-summarize-test', maxTokens: 800 })

const info = {
  videoId: 'abc123DEF45',
  title: '测试视频',
  channel: '频道',
  durationSec: 600,
  description: '简介',
  chapters: [{ title: '开场', startSec: 0 }],
  published: '2026-11-12',
}

function stubCtx(responses) {
  let index = 0
  return {
    get: () => undefined,
    llm: {
      listProviders: () => [],
      stream: async function* () {
        const text = responses[Math.min(index, responses.length - 1)]
        index++
        yield { type: 'text-delta', text }
      },
    },
    get calls() {
      return index
    },
  }
}

const VALID = JSON.stringify({
  summary: '这是一段总结。',
  content_type: '课程',
  category: '教育与学习',
  tags: ['微积分', '数学'],
  key_points: ['要点一', '要点二'],
  outline: [{ heading: '主题', points: ['细节'] }],
  quotes: [{ t: '0:10', text: '引用' }],
  actions: ['复习'],
  paragraphs: [{ start: '0:00', end: '1:20', title: '开场', gist: '介绍主题', points: ['细节'] }],
  expressions: [{ phrase: 'come up with', meaning: '想出', usage: '提出想法', example: 'She came up with a plan.' }],
  confidence: 'high',
})

test('normalizeSummary validates category, tags, quotes and outline', () => {
  const normalized = normalizeSummary(
    {
      summary: '总结',
      content_type: '奇怪类型',
      category: '不存在的分类',
      tags: [' a ', 'a', 2, 'b'],
      key_points: [' p '],
      outline: [{ heading: 'H', points: ['a', 'a'] }],
      quotes: [{ t: '0:10', text: 'q' }, { t: '99:99', text: 'bad' }],
      actions: [' x '],
      confidence: 'nope',
    },
    { config, durationSec: 600, hasTranscript: true },
  )
  assert.equal(normalized.category, '其他')
  assert.equal(normalized.content_type, '其他')
  assert.deepEqual(normalized.tags, ['a', 'b'])
  assert.deepEqual(normalized.key_points, ['p'])
  assert.equal(normalized.quotes[0].seconds, 10)
  assert.equal(normalized.quotes.length, 1)
  assert.equal(normalized.confidence, 'medium')
})

test('quotes are dropped without a transcript', () => {
  const normalized = normalizeSummary(
    { summary: 's', quotes: [{ t: '0:10', text: 'q' }] },
    { config, durationSec: 600, hasTranscript: false },
  )
  assert.deepEqual(normalized.quotes, [])
})

test('summarizeVideo returns a normalized note', async () => {
  const ctx = stubCtx([`\`\`\`json\n${VALID}\n\`\`\``])
  const result = await summarizeVideo(ctx, config, {
    info,
    transcript: '[0:10] 内容',
    watch: { totalWatchedSec: 90, maxProgressSec: 80 },
  })
  assert.equal(result.ok, true)
  assert.equal(result.data.category, '教育与学习')
  assert.equal(result.data.key_points.length, 2)
  assert.equal(result.data.paragraphs.length, 1)
  assert.equal(result.data.paragraphs[0].startSec, 0)
  assert.equal(result.data.expressions[0].phrase, 'come up with')
  assert.equal(result.model.model, 'deepseek-flash')
})

test('summarizeVideo does not retry an empty model output', async () => {
  const ctx = stubCtx([''])
  const result = await summarizeVideo(ctx, config, {
    info,
    transcript: '[0:10] content',
    watch: { totalWatchedSec: 30, maxProgressSec: 20 },
  })
  assert.equal(result.ok, false)
  assert.equal(ctx.calls, 1)
  assert.match(result.error, /返回为空/)
})

test('summarizeVideo retries once on malformed output', async () => {
  const ctx = stubCtx(['not json', VALID])
  const result = await summarizeVideo(ctx, config, {
    info,
    transcript: '',
    watch: { totalWatchedSec: 30, maxProgressSec: 20 },
  })
  assert.equal(result.ok, true)
  assert.equal(ctx.calls, 2)
})
