import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { cleanTranscript } from '../lib/clean.js'
import { cleanup, tempDir } from './helpers.mjs'

function stubCtx(output) {
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

test('cleanTranscript preserves timestamps and caches chunks', async () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir, cleanTranscript: true, cleanChunkChars: 1000, cleanMaxChunks: 2 })
  const store = createStore(config)
  const ctx = stubCtx('[0:00] He had an affair with the alleged agent.\n[0:10] The company denied it.')
  try {
    const source = '[0:00] he had. had an affair with\n[0:01] the alleged agent.\n[0:10] the company denied it.'
    const result = await cleanTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: source })
    assert.equal(result.status, 'ok')
    assert.match(result.text, /\[0:00\] He had an affair/)
    const calls = ctx.calls
    const second = await cleanTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: source })
    assert.equal(second.status, 'ok')
    assert.equal(ctx.calls, calls)
    assert.ok(store.readClean('abc123DEF45').chunks.length >= 1)
  } finally {
    cleanup(dir)
  }
})

test('cleanTranscript falls back when timestamps are lost', async () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir, cleanTranscript: true })
  const store = createStore(config)
  const ctx = stubCtx('This is a cleaned paragraph without timestamps.')
  try {
    const result = await cleanTranscript(ctx, config, { store, videoId: 'abc123DEF45', text: '[0:00] hello' })
    assert.equal(result.status, 'failed')
    assert.equal(result.text, '')
  } finally {
    cleanup(dir)
  }
})
