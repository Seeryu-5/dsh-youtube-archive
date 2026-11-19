import test from 'node:test'
import assert from 'node:assert/strict'
import {
  extractBalancedJson,
  formatClock,
  localDateString,
  parseClock,
  parseYouTubeUrl,
  sanitizeFilename,
} from '../lib/util.js'

test('parseYouTubeUrl handles common forms', () => {
  assert.deepEqual(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10'), {
    videoId: 'dQw4w9WgXcQ',
    kind: 'watch',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  assert.equal(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ')
  assert.equal(parseYouTubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ').kind, 'shorts')
  assert.equal(parseYouTubeUrl('https://www.youtube.com/live/dQw4w9WgXcQ').kind, 'live')
  assert.equal(parseYouTubeUrl('dQw4w9WgXcQ').videoId, 'dQw4w9WgXcQ')
  assert.equal(parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ'), null)
  assert.equal(parseYouTubeUrl(''), null)
})

test('sanitizeFilename strips filesystem-reserved characters', () => {
  const name = sanitizeFilename('a/b:c*?"<>| 测试  ')
  assert.equal(/[\\/:*?"<>|]/.test(name), false)
  assert.match(name, /测试/)
  assert.equal(sanitizeFilename('...'), 'video')
  assert.ok([...sanitizeFilename('长'.repeat(200), 20)].length <= 20)
})

test('clock formatting and parsing round-trip', () => {
  assert.equal(formatClock(65), '1:05')
  assert.equal(formatClock(3665), '1:01:05')
  assert.equal(parseClock('1:05'), 65)
  assert.equal(parseClock('1:01:05'), 3665)
  assert.equal(parseClock('bad'), null)
})

test('extractBalancedJson ignores braces inside strings', () => {
  const text = 'var x = {"a":"}{","b":{"c":1}}; trailing'
  assert.deepEqual(extractBalancedJson(text, 'var x = '), { a: '}{', b: { c: 1 } })
  assert.equal(extractBalancedJson('nothing here', 'var x = '), null)
})

test('localDateString uses local calendar date', () => {
  assert.equal(localDateString(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02')
})
