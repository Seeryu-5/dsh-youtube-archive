import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSentences,
  cleanFragment,
  compactLines,
  fallbackParagraphs,
  parseTimedLines,
  sentencesToText,
} from '../lib/transcript.js'

test('compactLines merges word-by-word caption growth', () => {
  const lines = compactLines([
    '[0:00] rock-star',
    '[0:01] rock-star CEO,',
    '[0:01] rock-star CEO, Jensen',
    '[0:02] has',
    '[0:02] has just',
  ])
  assert.deepEqual(lines, ['[0:00] rock-star CEO, Jensen', '[0:02] has just'])
})

test('cleanFragment removes fillers, markers, and stutters', () => {
  assert.equal(cleanFragment('>> uh it it was was fine.'), 'it was fine.')
  assert.equal(cleanFragment('[Music]'), '[音乐]')
})

test('buildSentences rebuilds complete sentences from fragments', () => {
  const raw = [
    '[0:00] rock-star',
    '[0:01] rock-star CEO,',
    '[0:02] has just',
    '[0:03] resigned over an affair.',
    '[0:10] The next',
    '[0:11] sentence starts here.',
  ].join('\n')
  const sentences = buildSentences(raw)
  assert.equal(sentences.length, 2)
  assert.match(sentences[0].text, /Rock-star CEO, has just resigned over an affair\./)
  assert.match(sentences[1].text, /The next sentence starts here\./)
  assert.equal(sentences[0].startSec, 0)
  assert.match(sentencesToText(sentences), /^\[0:00\] Rock-star CEO/)
})

test('parseTimedLines handles hours and fallback paragraphs', () => {
  const segments = parseTimedLines('[1:02:03] late line\n[1:02:20] next line')
  assert.equal(segments[0].startSec, 3723)
  const paragraphs = fallbackParagraphs([
    { startSec: 0, endSec: 2, text: 'One.' },
    { startSec: 60, endSec: 62, text: 'Two.' },
  ])
  assert.equal(paragraphs.length, 2)
  assert.match(paragraphs[0].title, /片段 1/)
})
