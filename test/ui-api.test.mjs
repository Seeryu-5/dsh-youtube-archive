import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { createLibrary } from '../lib/library.js'
import { startIngestServer } from '../lib/ingest-server.js'
import { cleanup, tempDir } from './helpers.mjs'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

test('UI routes serve the app, notes, and note content', async () => {
  const dir = tempDir()
  const config = resolveConfig({ outputDir: dir, port: await freePort() })
  const store = createStore(config)
  const categoryDir = join(dir, 'AI与技术')
  mkdirSync(categoryDir, { recursive: true })
  const notePath = join(categoryDir, 'note-abc123DEF45.md')
  writeFileSync(notePath, '# 标题\n\n## 核心要点\n\n- 测试\n', 'utf8')
  store.upsertVideo('abc123DEF45', {
    videoId: 'abc123DEF45',
    title: '标题',
    category: 'AI与技术',
    notePath,
    lastWatchedAt: '2026-11-19T05:00:00.000Z',
  })
  const library = createLibrary({ config, store })
  let revealed = null
  let retried = null
  let summarized = null
  let translated = null
  const { server, port } = await startIngestServer({
    config,
    onEvent: () => ({ watchedSec: 0 }),
    api: {
      listNotes: () => library.list(),
      readNote: (path) => library.readNote(path),
      reveal: async (path) => {
        revealed = path
        return { path }
      },
      retry: async (videoId) => {
        retried = videoId
        return { queued: true }
      },
      summarize: async (videoId) => {
        summarized = videoId
        return { queued: true }
      },
      translate: async (videoId) => {
        translated = videoId
        return { queued: true }
      },
    },
  })
  const base = `http://127.0.0.1:${port}`
  try {
    const html = await fetch(`${base}/`).then((res) => res.text())
    assert.match(html, /YouTube 知识库/)
    assert.match(html, /app\.js/)

    const notes = await fetch(`${base}/api/notes`).then((res) => res.json())
    assert.equal(notes.ok, true)
    assert.equal(notes.items.length, 1)
    assert.equal(notes.items[0].title, '标题')

    const note = await fetch(`${base}/api/note?path=${encodeURIComponent(notePath)}`).then((res) => res.json())
    assert.equal(note.ok, true)
    assert.match(note.markdown, /核心要点/)

    const bad = await fetch(`${base}/api/note?path=${encodeURIComponent('/etc/passwd')}`)
    assert.equal(bad.status, 403)

    const reveal = await fetch(`${base}/api/reveal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ path: notePath }),
    })
    assert.equal(reveal.status, 200)
    assert.equal(revealed, notePath)

    const retry = await fetch(`${base}/api/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ videoId: 'abc123DEF45' }),
    })
    assert.equal(retry.status, 200)
    assert.equal(retried, 'abc123DEF45')

    const summarize = await fetch(`${base}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ videoId: 'abc123DEF45' }),
    })
    assert.equal(summarize.status, 200)
    assert.equal(summarized, 'abc123DEF45')

    const translate = await fetch(`${base}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ videoId: 'abc123DEF45' }),
    })
    assert.equal(translate.status, 200)
    assert.equal(translated, 'abc123DEF45')
  } finally {
    server.close()
    cleanup(dir)
  }
})
