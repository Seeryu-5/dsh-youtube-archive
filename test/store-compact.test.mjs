import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { cleanup, tempDir } from './helpers.mjs'

test('live caption growth is compacted into one evolving line', () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir })
  const store = createStore(config)
  try {
    store.appendTranscript('abc123DEF45', {
      segments: [
        { startSec: 0, text: 'rock-star' },
        { startSec: 1, text: 'rock-star CEO,' },
        { startSec: 1, text: 'rock-star CEO, Jensen' },
      ],
      source: 'live-dom',
    })
    const data = store.readTranscript('abc123DEF45')
    assert.equal(data.text.split('\n').length, 1)
    assert.match(data.text, /rock-star CEO, Jensen/)
    assert.match(data.text, /^\[0:00\]/)
  } finally {
    cleanup(dir)
  }
})

test('compactTranscript cleans previously fragmented files', () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir })
  const store = createStore(config)
  try {
    store.writeTranscript('abc123DEF45', {
      text: '[0:01] hello\n[0:01] hello world\n[0:02] hello world again',
      source: 'live-dom',
    })
    const compacted = store.compactTranscript('abc123DEF45')
    assert.equal(compacted.text.split('\n').length, 1)
    assert.match(compacted.text, /hello world again/)
  } finally {
    cleanup(dir)
  }
})
