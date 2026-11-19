import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { cleanup, sleep, tempDir, waitFor } from './helpers.mjs'

const VIDEO_ID = 'cap123DEF45'
const SUMMARY_JSON = JSON.stringify({
  summary: '带实时字幕的测试总结。',
  content_type: '课程',
  category: '教育与学习',
  tags: ['字幕'],
  key_points: ['要点'],
  outline: [{ heading: '主题', points: ['细节'] }],
  quotes: [{ t: '0:01', text: 'Hello world' }],
  actions: ['复习'],
  confidence: 'high',
})

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

function noteFiles(dir) {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith('.md'))
    .filter((file) => !file.startsWith('index.md') && !file.startsWith('daily/'))
    .map((file) => join(dir, file))
}

test('live captions are recorded, translated, and upgraded at the end', { timeout: 30000 }, async () => {
  const dir = tempDir('dsh-yt-cap-')
  const port = await freePort()
  const cleanups = []
  const ctx = {
    get: () => undefined,
    llm: {
      listProviders: () => [],
      stream: async function* (request) {
        const text = String(request?.messages?.[0]?.content?.[0]?.text ?? '')
        yield { type: 'text-delta', text: text.includes('请翻译') ? '[0:01] 你好世界\n[0:03] 第二行' : SUMMARY_JSON }
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    tools: { register: () => () => {} },
  }

  async function post(event) {
    return fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({
        schema: 1,
        tabId: 1,
        videoId: VIDEO_ID,
        title: '实时字幕测试',
        channel: '测试频道',
        duration: 60,
        muted: false,
        visible: true,
        ...event,
      }),
    })
  }

  try {
    apply(ctx, {
      outputDir: dir,
      port,
      minWatchSeconds: 10,
      idleFinalizeMinutes: 1,
      fetchMetadata: false,
      autoSummary: true,
      cleanTranscript: false,
      translateTranscript: true,
      autoTranslate: true,
      translationChunkChars: 2000,
      translationMaxChunks: 2,
      provider: 'stub',
      model: 'stub',
    })

    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
      } catch {
        return false
      }
    }, { timeoutMs: 8000 })

    for (const [index, time] of [0, 5, 10, 15].entries()) {
      const response = await post({ kind: index === 0 ? 'play' : 'heartbeat', currentTime: time })
      assert.equal(response.status, 200)
    }

    await waitFor(() => noteFiles(dir).length === 1, { timeoutMs: 8000 })

    assert.equal((await post({
      kind: 'caption',
      segments: [
        { startSec: 1, text: 'Hello world' },
        { startSec: 3, text: 'Second line' },
      ],
    })).status, 200)
    assert.equal((await post({ kind: 'ended', currentTime: 60, ended: true })).status, 200)

    const text = await waitFor(() => {
      const files = noteFiles(dir)
      if (files.length !== 1) return null
      const content = readFileSync(files[0], 'utf8')
      return content.includes('translated: true') && content.includes('## 字幕译文（中文）') ? content : null
    }, { timeoutMs: 10000 })

    assert.match(text, /## 字幕原文（实时字幕）/)
    assert.match(text, /\[0:01\] Hello world/)
    assert.match(text, /你好世界/)
    assert.match(text, /summary_stage: "精读"/)
  } finally {
    for (const dispose of cleanups.reverse()) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
    await sleep(200)
    cleanup(dir)
  }
})
