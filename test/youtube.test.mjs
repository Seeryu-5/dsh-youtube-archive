import test from 'node:test'
import assert from 'node:assert/strict'
import { formatTranscript, parseCaptionPayload, parseWatchPage } from '../lib/youtube.js'

const PLAYER = {
  videoDetails: {
    videoId: 'abc123DEF45',
    title: '为什么学习微积分',
    author: 'Test Channel',
    lengthSeconds: '601',
    shortDescription: '一节关于微积分的课程。',
    keywords: ['math', 'calculus'],
    isLiveContent: false,
  },
  microformat: {
    playerMicroformatRenderer: {
      publishDate: '2026-11-12',
      ownerChannelName: 'Test Channel',
    },
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123DEF45&lang=en', languageCode: 'en', kind: 'asr' },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc123DEF45&lang=zh-Hans', languageCode: 'zh-Hans' },
      ],
    },
  },
}

const INITIAL_DATA = {
  engagementPanels: [
    {
      macroMarkersListItemRenderer: {
        title: { simpleText: '开场' },
        timeRangeStartMillis: 0,
        onTap: { innertubeCommand: { watchEndpoint: { startTimeSeconds: 0 } } },
      },
    },
    {
      macroMarkersListItemRenderer: {
        title: { simpleText: '极限的定义' },
        timeRangeStartMillis: 65000,
        onTap: { innertubeCommand: { watchEndpoint: { startTimeSeconds: 65 } } },
      },
    },
  ],
}

function htmlFor(player, data) {
  return `<!doctype html><html><head><title>忽略的标题 - YouTube</title>
  <meta property="og:title" content="og 标题" /></head><body>
  <script>var ytInitialPlayerResponse = ${JSON.stringify(player)};</script>
  <script>var ytInitialData = ${JSON.stringify(data)};</script>
  </body></html>`
}

test('parseWatchPage extracts facts, chapters, and caption tracks', () => {
  const page = parseWatchPage(htmlFor(PLAYER, INITIAL_DATA))
  assert.equal(page.title, '为什么学习微积分')
  assert.equal(page.channel, 'Test Channel')
  assert.equal(page.durationSec, 601)
  assert.equal(page.published, '2026-11-12')
  assert.match(page.description, /微积分/)
  assert.deepEqual(page.chapters, [
    { title: '开场', startSec: 0 },
    { title: '极限的定义', startSec: 65 },
  ])
  assert.equal(page.captionTracks.length, 2)
  assert.equal(page.isLive, false)
})

test('parseWatchPage degrades to meta tags when player data is absent', () => {
  const html = `<html><head><meta property="og:title" content="回退标题" />
    <meta name="description" content="回退简介" />
    <meta itemprop="duration" content="PT2M3S" /></head></html>`
  const page = parseWatchPage(html)
  assert.equal(page.title, '回退标题')
  assert.equal(page.description, '回退简介')
  assert.equal(page.durationSec, 123)
  assert.deepEqual(page.chapters, [])
})

test('parseCaptionPayload handles json3 and de-duplicates rolling lines', () => {
  const body = JSON.stringify({
    events: [
      { tStartMs: 0, segs: [{ utf8: 'hello ' }, { utf8: 'world' }] },
      { tStartMs: 0, segs: [{ utf8: 'hello world' }] },
      { tStartMs: 65000, segs: [{ utf8: 'second line' }] },
      { tStartMs: 70000, segs: [] },
    ],
  })
  const parsed = parseCaptionPayload(body)
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[1].startSec, 65)
  assert.equal(parsed.text, '[0:00] hello world\n[1:05] second line')
})

test('parseCaptionPayload handles XML and formatTranscript', () => {
  const xml = '<transcript><text start="12.5">Hi &amp; bye</text><text start="70">Second</text></transcript>'
  const parsed = parseCaptionPayload(xml)
  assert.equal(parsed.segments.length, 2)
  assert.equal(parsed.segments[0].text, 'Hi & bye')
  assert.equal(formatTranscript([{ startSec: 0, text: 'a' }]), '[0:00] a')
})
