import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { mostlyChinese, splitTranscriptChunks, translatePending, translateTranscript } from '../lib/translate.js'
import { cleanup, tempDir } from './helpers.mjs'

function stubCtx(output = '[0:01] 译好的字幕') {
  let calls = 0
  return {
    get calls() {
      return calls
    },
    get: () => undefined,
    llm: {
      listProviders: () => [],
      stream: async function* () {
        calls++
        yield { type: 'text-delta', text: output }
      },
    },
  }
}

test('mostlyChinese distinguishes Chinese from English', () => {
  assert.equal(mostlyChinese('这是中文内容，应该跳过翻译。'), true)
  assert.equal(mostlyChinese('This is an English transcript.'), false)
  assert.equal(mostlyChinese('これは日本語です'), false)
})

test('splitTranscriptChunks preserves timestamps and respects the limit', () => {
  const text = Array.from({ length: 120 }, (_, index) => `[0:${String(index).padStart(2, '0')}] line ${index} ${'x'.repeat(40)}`).join('\n')
  const chunks = splitTranscriptChunks(text, 500)
  assert.ok(chunks.length > 1)
  assert.ok(chunks.every((chunk) => chunk.length <= 500))
  assert.match(chunks.join('\n'), /\[0:119\] line 119/)
})

test('translateTranscript calls the model and caches chunks', async () => {
  const dir = tempDir()
  const config = resolveConfig({
    outputDir: dir,
    translateTranscript: true,
    translationChunkChars: 1000,
    translationMaxChunks: 2,
  })
  const store = createStore(config)
  const ctx = stubCtx()
  try {
    const source = '[0:01] Hello world\n[0:02] Second line'
    const result = await translateTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: source, lang: 'en' })
    assert.equal(result.translated, true)
    assert.equal(result.status, 'ok')
    assert.match(result.text, /译好的字幕/)
    const calls = ctx.calls
    const second = await translateTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: source, lang: 'en' })
    assert.equal(second.status, 'ok')
    assert.equal(ctx.calls, calls, 'second call should hit the chunk cache')
    assert.ok(store.readTranslation('abc123DEF45').chunks.length >= 1)
  } finally {
    cleanup(dir)
  }
})

test('empty model output is a failure, never silently falls back to source', async () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir, translationChunkChars: 1000, translateTranscript: true })
  const store = createStore(config)
  const ctx = stubCtx('')
  try {
    const result = await translateTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: '[0:01] Hello world', lang: 'en' })
    assert.equal(result.status, 'failed')
    assert.equal(result.text, '')
  } finally {
    cleanup(dir)
  }
})

test('Chinese source skips translation', async () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir })
  const store = createStore(config)
  const ctx = stubCtx()
  try {
    const result = await translateTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: '这是中文字幕。', lang: 'zh' })
    assert.equal(result.translated, false)
    assert.equal(result.status, 'source-zh')
    assert.equal(ctx.calls, 0)
  } finally {
    cleanup(dir)
  }
})


test('translatePending processes more than the old 12-chunk cap in batches', async () => {
  const dir = tempDir()
  const config = resolveConfig({
    outputDir: dir,
    translateTranscript: true,
    translationChunkChars: 1000,
    translationBatchChunks: 3,
  })
  const store = createStore(config)
  const ctx = stubCtx('[0:01] 译好的字幕')
  try {
    const source = Array.from({ length: 400 }, (_, index) => `[0:${String(index).padStart(2, '0')}] line ${index} ${'x'.repeat(40)}`).join('\n')
    let result = null
    for (let index = 0; index < 200; index++) {
      result = await translatePending(ctx, config, {
        store,
        videoId: 'abc123DEF45',
        text: source,
        lang: 'en',
        batchSize: 3,
      })
      if (result.done) break
    }
    assert.equal(result.done, true)
    assert.equal(result.status, 'ok')
    assert.ok(result.total > 12, `expected >12 chunks, got ${result.total}`)
    assert.equal(result.doneChunks, result.total)
    assert.equal(ctx.calls, result.total)
  } finally {
    cleanup(dir)
  }
})
