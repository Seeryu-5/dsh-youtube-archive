import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfig } from '../lib/config.js'
import { createStore } from '../lib/store.js'
import { Tracker } from '../lib/tracker.js'
import { cleanup, tempDir } from './helpers.mjs'

function setup() {
  const dir = tempDir()
  const config = resolveConfig({
    outputDir: dir,
    minWatchSeconds: 10,
    idleFinalizeMinutes: 1,
    skipMutedBackground: true,
  })
  const store = createStore(config)
  const finalizeCalls = []
  const transcriptCalls = []
  let clock = 1_000_000
  const tracker = new Tracker({
    config,
    store,
    onFinalize: (videoId, stage, options) => finalizeCalls.push({ videoId, stage, options }),
    onTranscript: (videoId) => transcriptCalls.push(videoId),
    now: () => clock,
  })
  const advance = (ms) => {
    clock += ms
  }
  return { dir, config, store, tracker, finalizeCalls, transcriptCalls, advance, getClock: () => clock }
}

function beat(tracker, advance, currentTime, extra = {}) {
  advance(5000)
  return tracker.handleEvent({
    schema: 1,
    kind: 'heartbeat',
    videoId: 'abc123DEF45',
    tabId: 1,
    currentTime,
    duration: 100,
    title: '测试视频',
    channel: '测试频道',
    paused: false,
    ended: false,
    muted: false,
    visible: true,
    ...extra,
  })
}

test('accumulates media time, ignores seeks/pauses/muted background, triggers milestones', () => {
  const { tracker, finalizeCalls, advance, dir, store } = setup()
  try {
    beat(tracker, advance, 0)
    beat(tracker, advance, 5)
    let result = beat(tracker, advance, 10)
    assert.equal(result.watchedSec, 10)
    assert.deepEqual(
      finalizeCalls.map((call) => call.stage),
      ['initial'],
    )

    // Seek forward: the jump is not watch time.
    beat(tracker, advance, 90)
    assert.equal(tracker.videoStats('abc123DEF45').totalWatchedSec, 10)

    // Paused event does not count.
    beat(tracker, advance, 90, { paused: true })
    assert.equal(tracker.videoStats('abc123DEF45').totalWatchedSec, 10)

    // Muted + hidden tab is ignored.
    beat(tracker, advance, 95, { muted: true, visible: false })
    assert.equal(tracker.videoStats('abc123DEF45').totalWatchedSec, 10)

    // Ended triggers the final pass and closes the session.
    beat(tracker, advance, 100, { ended: true })
    assert.equal(tracker.videoStats('abc123DEF45').totalWatchedSec, 10)
    assert.deepEqual(
      finalizeCalls.map((call) => call.stage),
      ['initial', 'final'],
    )
    const rec = store.getVideo('abc123DEF45')
    assert.equal(rec.watchSessions, 1)
    assert.equal(rec.closedWatchedSec, 10)
    assert.ok(store.readTranscript('abc123DEF45') === null)
    assert.ok(rec.watchedSec >= 10)
    const sessions = readFileSync(join(dir, '.state', 'sessions.jsonl'), 'utf8').trim()
    assert.match(sessions, /abc123DEF45/)
  } finally {
    cleanup(dir)
  }
})

test('idle sessions are finalized and closed', () => {
  const { tracker, finalizeCalls, advance, dir, store } = setup()
  try {
    beat(tracker, advance, 0)
    beat(tracker, advance, 15)
    assert.ok(store.getVideo('abc123DEF45'))
    advance(61_000)
    tracker.tick()
    assert.equal(tracker.sessions.size, 0)
    assert.ok(finalizeCalls.length >= 1)
    assert.equal(store.getVideo('abc123DEF45').watchSessions, 1)
  } finally {
    cleanup(dir)
  }
})

test('idle finalizes a pending placeholder even though summaryStage exists', () => {
  const { tracker, finalizeCalls, advance, dir, store } = setup()
  try {
    beat(tracker, advance, 0)
    beat(tracker, advance, 15)
    store.upsertVideo('abc123DEF45', { summaryStage: '初版', summaryStatus: 'pending' })
    advance(61_000)
    tracker.tick()
    assert.equal(tracker.sessions.size, 0)
    assert.ok(finalizeCalls.some((call) => call.stage === 'final'))
  } finally {
    cleanup(dir)
  }
})

test('extension metadata is merged into the video record', () => {
  const { tracker, dir, store } = setup()
  try {
    tracker.handleEvent({
      schema: 1,
      kind: 'meta',
      videoId: 'abc123DEF45',
      pageKind: 'watch',
      title: '标题',
      channel: '频道',
      durationSec: 123,
      description: '简介',
      chapters: [{ title: '开场', startSec: 0 }, { title: '主题', startSec: 65 }],
    })
    const rec = store.getVideo('abc123DEF45')
    assert.equal(rec.extensionDescription, '简介')
    assert.deepEqual(rec.extensionChapters, [
      { title: '开场', startSec: 0 },
      { title: '主题', startSec: 65 },
    ])
    assert.equal(rec.durationSec, 123)
    assert.equal(rec.pageKind, 'watch')
  } finally {
    cleanup(dir)
  }
})

test('live caption events append transcript segments without duplicates', () => {
  const { tracker, dir, store } = setup()
  try {
    tracker.handleEvent({
      schema: 1,
      kind: 'caption',
      videoId: 'abc123DEF45',
      segments: [
        { startSec: 1, text: 'Hello world' },
        { startSec: 3, text: 'This is a test' },
      ],
    })
    let cached = store.readTranscript('abc123DEF45')
    assert.match(cached.text, /\[0:01\] Hello world/)
    assert.match(cached.text, /\[0:03\] This is a test/)
    assert.equal(store.getVideo('abc123DEF45').liveCaptions, true)

    tracker.handleEvent({
      schema: 1,
      kind: 'caption',
      videoId: 'abc123DEF45',
      segments: [{ startSec: 1, text: 'Hello world' }],
    })
    const again = store.readTranscript('abc123DEF45')
    assert.equal(again.text.split('Hello world').length - 1, 1)
  } finally {
    cleanup(dir)
  }
})

test('transcript events are cached and reported once', () => {
  const { tracker, transcriptCalls, dir, store } = setup()
  try {
    tracker.handleEvent({
      schema: 1,
      kind: 'transcript',
      videoId: 'abc123DEF45',
      transcript: { text: '[0:01] hello', lang: 'en', kind: 'manual' },
    })
    const cached = store.readTranscript('abc123DEF45')
    assert.equal(cached.text, '[0:01] hello')
    assert.deepEqual(transcriptCalls, ['abc123DEF45'])
  } finally {
    cleanup(dir)
  }
})
