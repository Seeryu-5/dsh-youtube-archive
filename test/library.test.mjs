import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createLibrary } from '../lib/library.js'
import { cleanup, tempDir } from './helpers.mjs'

function setup() {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir })
  const store = createStore(config)
  const categoryDir = join(dir, '教育与学习')
  mkdirSync(categoryDir, { recursive: true })
  const notePath = join(categoryDir, '2026-11-19-测试-abc123DEF45.md')
  writeFileSync(notePath, '# 测试\n\n> 一句话\n\n## 核心要点\n\n- 要点\n', 'utf8')
  store.writeTranscript('abc123DEF45', {
    text: '[0:00] First sentence.\n[0:10] Second sentence.',
    source: 'live-dom',
  })
  store.writeTranslation('abc123DEF45', {
    chunks: [{ hash: 'x', source: '[0:00] First sentence.', translated: '[0:00] 第一句。' }],
  })
  store.upsertVideo('abc123DEF45', {
    videoId: 'abc123DEF45',
    title: '测试笔记',
    channel: '频道',
    category: '教育与学习',
    tags: ['测试'],
    oneLine: '一句话',
    durationSec: 600,
    watchedSec: 120,
    maxProgressSec: 300,
    watchSessions: 1,
    lastWatchedAt: '2026-11-19T05:00:00.000Z',
    notePath,
    summaryStage: '精读',
    transcript: true,
    paragraphs: [{ start: '0:00', end: '0:10', startSec: 0, endSec: 10, title: '开场', gist: '第一段', points: [] }],
    expressions: [{ phrase: 'come up with', meaning: '想出', usage: '', example: '' }],
  })
  return { dir, config, store, notePath, library: createLibrary({ config, store }) }
}

test('library lists archived notes with categories and stats', () => {
  const { dir, library } = setup()
  try {
    const data = library.list()
    assert.equal(data.items.length, 1)
    assert.equal(data.items[0].category, '教育与学习')
    assert.equal(data.stats.videos, 1)
    assert.equal(data.stats.watchedSec, 120)
    assert.deepEqual(data.categories, [{ name: '教育与学习', count: 1 }])
    assert.equal(data.vault, dir)
  } finally {
    cleanup(dir)
  }
})

test('library reads notes but rejects paths outside the vault', () => {
  const { dir, library, notePath } = setup()
  try {
    const note = library.readNote(notePath)
    assert.match(note.markdown, /核心要点/)
    assert.equal(note.video.paragraphs.length, 1)
    assert.equal(note.video.expressions[0].phrase, 'come up with')
    assert.ok(note.sentences.length >= 1)
    assert.match(note.translation, /第一句/)
    assert.throws(() => library.readNote('/etc/passwd'), (error) => error.status === 403)
    assert.throws(() => library.readNote(join(dir, 'missing.md')), (error) => error.status === 404)
    assert.throws(() => library.readNote(''), (error) => error.status === 400)
  } finally {
    cleanup(dir)
  }
})
