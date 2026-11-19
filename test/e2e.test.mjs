import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { cleanup, sleep, tempDir, waitFor } from './helpers.mjs'

const VIDEO_ID = 'abc123DEF45'
const SUMMARY_JSON = JSON.stringify({
  summary: '这是一段测试总结。',
  content_type: '课程',
  category: '教育与学习',
  tags: ['测试', '归档'],
  key_points: ['要点一', '要点二', '要点三'],
  outline: [{ heading: '主题', points: ['细节一', '细节二'] }],
  quotes: [{ t: '0:10', text: '测试引用' }],
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

function makeCtx() {
  const cleanups = []
  const tools = {}
  let llmCalls = 0
  return {
    tools,
    get llmCalls() {
      return llmCalls
    },
    ctx: {
      get: () => undefined,
      llm: {
        listProviders: () => [],
        stream: async function* () {
          llmCalls++
          yield { type: 'text-delta', text: SUMMARY_JSON }
        },
      },
      effect(fn) {
        const dispose = fn()
        if (typeof dispose === 'function') cleanups.push(dispose)
        return dispose
      },
      tools: {
        register(tool) {
          tools[tool.name] = tool
          return () => {}
        },
      },
    },
    dispose() {
      for (const fn of cleanups.reverse()) {
        try {
          fn()
        } catch {
          /* ignore */
        }
      }
    },
  }
}

async function post(port, event) {
  const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
    body: JSON.stringify({
      schema: 1,
      tabId: 1,
      videoId: VIDEO_ID,
      title: '测试视频',
      channel: '测试频道',
      duration: 120,
      muted: false,
      visible: true,
      ...event,
    }),
  })
  assert.equal(response.status, 200)
  return response.json()
}

test('end-to-end: ingest -> initial note -> transcript upgrade -> replay dedupe', { timeout: 90000 }, async () => {
  const dir = tempDir('dsh-yt-e2e-')
  const port = await freePort()
  const harness = makeCtx()
  try {
    apply(harness.ctx, {
      outputDir: dir,
      port,
      minWatchSeconds: 20,
      idleFinalizeMinutes: 1,
      translateTranscript: false,
      autoSummary: true,
      cleanTranscript: false,
      fetchMetadata: false,
      provider: 'stub',
      model: 'stub',
    })

    await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`)
        return response.ok
      } catch {
        return false
      }
    }, { timeoutMs: 10000 })

    await post(port, { kind: 'play', currentTime: 0 })
    await post(port, { kind: 'heartbeat', currentTime: 10 })
    await post(port, { kind: 'heartbeat', currentTime: 20 })
    await post(port, { kind: 'heartbeat', currentTime: 30 })

    const firstNote = await waitFor(() => noteFiles(dir).find((file) => existsSync(file)), {
      timeoutMs: 20000,
    })
    const initial = readFileSync(firstNote, 'utf8')
    assert.match(initial, /summary_stage: "初版"/)
    assert.match(initial, /summary_status: "pending"/)
    assert.match(initial, /正在记录字幕/)
    assert.equal(harness.llmCalls, 0, 'initial milestone must not call the model')

    await post(port, {
      kind: 'transcript',
      transcript: { text: '[0:10] 这是一段测试字幕。\n[0:20] 第二段。', lang: 'zh', kind: 'manual' },
    })
    await post(port, { kind: 'ended', currentTime: 120, ended: true })

    const upgraded = await waitFor(() => {
      const files = noteFiles(dir)
      if (files.length !== 1) return null
      const text = readFileSync(files[0], 'utf8')
      return text.includes('summary_stage: "精读"') && text.includes('transcript: true') ? text : null
    }, { timeoutMs: 20000 })
    assert.match(upgraded, /\[0:10\]\(https:\/\/youtu\.be\/abc123DEF45\?t=10\)/)
    assert.match(upgraded, /summary_status: "ok"/)
    assert.match(upgraded, /这是一段测试总结/)
    assert.equal(harness.llmCalls, 1, 'final pass should call the model exactly once')

    const status = await harness.tools.youtube_archive_status.execute({})
    assert.equal(status.ok, true)
    assert.equal(status.port, port)
    assert.equal(status.extensionConnected, true)
    assert.equal(status.notes, 1)

    const list = await harness.tools.youtube_archive_list.execute({})
    assert.equal(list.ok, true)
    assert.equal(list.items.length, 1)
    assert.equal(list.items[0].videoId, VIDEO_ID)

    // Replay should update stats but never create a second note.
    await post(port, { kind: 'play', currentTime: 0 })
    await post(port, { kind: 'heartbeat', currentTime: 10 })
    await post(port, { kind: 'heartbeat', currentTime: 20 })
    await post(port, { kind: 'heartbeat', currentTime: 30 })
    await sleep(1500)
    assert.equal(noteFiles(dir).length, 1)

    const index = readFileSync(join(dir, 'index.md'), 'utf8')
    assert.match(index, /测试视频/)
    assert.ok(existsSync(join(dir, 'daily')))
  } finally {
    harness.dispose()
    await sleep(300)
    cleanup(dir)
  }
})

test('manual summary: final writes translation-only note, button call summarizes once', { timeout: 90000 }, async () => {
  const dir = tempDir('dsh-yt-manual-')
  const port = await freePort()
  const harness = makeCtx()
  try {
    apply(harness.ctx, {
      outputDir: dir,
      port,
      minWatchSeconds: 20,
      translateTranscript: false,
      autoSummary: false,
      cleanTranscript: false,
      fetchMetadata: false,
      provider: 'stub',
      model: 'stub',
    })

    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
      } catch {
        return false
      }
    }, { timeoutMs: 10000 })

    await post(port, { kind: 'play', currentTime: 0 })
    await post(port, { kind: 'heartbeat', currentTime: 30 })
    await post(port, {
      kind: 'transcript',
      transcript: { text: '[0:10] 这是一段测试字幕。\n[0:20] 第二段。', lang: 'zh', kind: 'manual' },
    })
    await post(port, { kind: 'ended', currentTime: 120, ended: true })

    const before = await waitFor(() => {
      for (const file of noteFiles(dir)) {
        try {
          const text = readFileSync(file, 'utf8')
          if (/summary_status: "none"/.test(text)) return text
        } catch {
          /* file may be replaced atomically */
        }
      }
      return null
    }, { timeoutMs: 20000 })
    assert.match(before, /还没有生成总结|生成总结/)
    assert.doesNotMatch(before, /这是一段测试总结/)
    assert.equal(harness.llmCalls, 0, 'final pass must not summarize automatically')

    const response = await fetch(`http://127.0.0.1:${port}/api/summarize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ videoId: VIDEO_ID }),
    })
    assert.equal(response.status, 200)

    const after = await waitFor(() => {
      for (const file of noteFiles(dir)) {
        try {
          const text = readFileSync(file, 'utf8')
          if (/summary_status: "ok"/.test(text)) return text
        } catch {
          /* file may be replaced atomically */
        }
      }
      return null
    }, { timeoutMs: 20000 })
    assert.match(after, /这是一段测试总结/)
    assert.equal(harness.llmCalls, 1, 'manual summary should call the model once')
  } finally {
    harness.dispose()
    cleanup(dir)
  }
})

test('manual translation: final stores source only, endpoint translates on demand', { timeout: 90000 }, async () => {
  const dir = tempDir('dsh-yt-translate-')
  const port = await freePort()
  const harness = makeCtx()
  try {
    apply(harness.ctx, {
      outputDir: dir,
      port,
      minWatchSeconds: 20,
      translateTranscript: true,
      autoTranslate: false,
      autoSummary: false,
      cleanTranscript: false,
      fetchMetadata: false,
      provider: 'stub',
      model: 'stub',
    })

    await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
      } catch {
        return false
      }
    }, { timeoutMs: 10000 })

    await post(port, { kind: 'play', currentTime: 0 })
    await post(port, { kind: 'heartbeat', currentTime: 30 })
    await post(port, {
      kind: 'transcript',
      transcript: { text: '[0:10] Hello world\n[0:20] Second line.', lang: 'en', kind: 'manual' },
    })
    await post(port, { kind: 'ended', currentTime: 120, ended: true })

    const before = await waitFor(() => {
      for (const file of noteFiles(dir)) {
        try {
          const text = readFileSync(file, 'utf8')
          if (/translation_status: "none"/.test(text)) return text
        } catch {
          /* atomic replace */
        }
      }
      return null
    }, { timeoutMs: 20000 })
    assert.doesNotMatch(before, /译好的字幕/)
    assert.equal(harness.llmCalls, 0, 'manual translation must not call the model automatically')

    const response = await fetch(`http://127.0.0.1:${port}/api/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
      body: JSON.stringify({ videoId: VIDEO_ID }),
    })
    assert.equal(response.status, 200)

    const after = await waitFor(() => {
      for (const file of noteFiles(dir)) {
        try {
          const text = readFileSync(file, 'utf8')
          if (/translation_status: "ok"/.test(text)) return text
        } catch {
          /* atomic replace */
        }
      }
      return null
    }, { timeoutMs: 20000 })
    assert.match(after, /translated: true/)
    assert.equal(harness.llmCalls, 1, 'manual translation should call the model once')
  } finally {
    harness.dispose()
    cleanup(dir)
  }
})
