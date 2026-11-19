import { formatClock } from './util.js'

/** Body of a `[mm:ss] text` transcript line. */
export function lineBody(line) {
  return String(line ?? '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .trim()
}

/**
 * Merge word-by-word live caption growth (`rock-star` -> `rock-star CEO`)
 * while keeping the first timestamp. Always returns compacted lines.
 */
export function compactLines(lines) {
  const output = []
  for (const line of lines) {
    const body = lineBody(line)
    if (!body) continue
    let merged = false
    for (let index = output.length - 1; index >= Math.max(-1, output.length - 8); index--) {
      const previous = lineBody(output[index])
      if (!previous) continue
      if (body === previous) {
        merged = true
        break
      }
      if (body.startsWith(previous) && body.length > previous.length + 1) {
        output[index] = output[index].replace(previous, body)
        merged = true
        break
      }
      if (previous.startsWith(body) && previous.length > body.length) {
        merged = true
        break
      }
    }
    if (!merged) output.push(line)
  }
  return output
}

/**
 * Put live-caption lines back on a chronological timeline and drop exact
 * replay duplicates. Seek/rewind makes capture arrive out of order, so this is
 * essential before sentence building, summarization, and translation.
 */
export function normalizeTimeline(text) {
  const items = []
  const seen = new Set()
  const lines = String(text ?? '').split('\n')
  lines.forEach((line, index) => {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim())
    if (!match) return
    const body = match[2].trim()
    if (!body) return
    const parts = String(match[1]).split(':').map(Number)
    if (!parts.length || parts.some((value) => !Number.isFinite(value))) return
    const seconds = parts.reduce((total, value) => total * 60 + value, 0)
    const key = `${seconds}\u0000${body}`
    if (seen.has(key)) return
    seen.add(key)
    items.push({ seconds, index, line: `[${match[1]}] ${body}` })
  })
  items.sort((a, b) => a.seconds - b.seconds || a.index - b.index)
  return items.map((item) => item.line).join('\n')
}

/** Parse timestamped transcript lines into ordered segments. */
export function parseTimedLines(text) {
  const segments = []
  for (const line of compactLines(normalizeTimeline(text).split('\n'))) {
    const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim())
    if (!match) continue
    const parts = String(match[1]).split(':').map(Number)
    if (!parts.length || parts.some((value) => !Number.isFinite(value))) continue
    const startSec = parts.reduce((total, value) => total * 60 + value, 0)
    const body = match[2].trim()
    if (body) segments.push({ startSec, text: body })
  }
  return segments
}

/** Remove ASR fillers, speaker markers, and stutters from one caption chunk. */
export function cleanFragment(input) {
  let text = String(input ?? '')
    .replace(/^[>»\-\s]+/, '')
    .replace(/\[music\]/gi, '[音乐]')
    .replace(/\b(uh|um|erm|hmm|er|ah)\b[,.]?/gi, ' ')
    .replace(/\b(\w+)(\s+\1\b)+/gi, '$1')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  return text
}

/**
 * Rebuild complete, punctuated sentences from fragmented auto-captions.
 * Ends a sentence on terminal punctuation, a long pause, or a length cap.
 */
export function buildSentences(rawText, { maxChars = 240, gapSec = 2.5 } = {}) {
  const segments = parseTimedLines(rawText)
  const sentences = []
  let buffer = ''
  let startSec = 0
  let lastStartSec = 0

  function flush() {
    if (!buffer) return
    let text = buffer.trim()
    if (text && /^[a-z]/.test(text)) text = `${text[0].toUpperCase()}${text.slice(1)}`
    if (text && !/[.!?。！？;:]$/.test(text)) text += '.'
    sentences.push({ startSec, endSec: lastStartSec, text })
    buffer = ''
  }

  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const body = cleanFragment(segment.text)
    if (!body) continue
    if (!buffer) {
      buffer = body
      startSec = segment.startSec
    } else if (body === buffer) {
      continue
    } else if (body.startsWith(buffer) && body.length > buffer.length + 1) {
      buffer = body
    } else if (!buffer.endsWith(body)) {
      buffer = `${buffer} ${body}`
    }
    lastStartSec = segment.startSec

    const next = segments[index + 1]
    const pause = next ? next.startSec - segment.startSec : 0
    const terminal = /[.!?。！？]$/.test(body)
    if ((terminal && buffer.length >= 12) || buffer.length >= maxChars || !next || pause >= gapSec) {
      flush()
    }
  }
  flush()
  return sentences
}

export function sentencesToText(sentences) {
  return (Array.isArray(sentences) ? sentences : [])
    .filter((sentence) => sentence && sentence.text)
    .map((sentence) => `[${formatClock(sentence.startSec)}] ${sentence.text}`)
    .join('\n')
}

/**
 * Local fallback when the model does not return paragraph notes:
 * group sentences by pauses / length.
 */
export function fallbackParagraphs(sentences, { maxParagraphs = 7 } = {}) {
  const list = Array.isArray(sentences) ? sentences : []
  if (list.length === 0) return []
  const groups = []
  let current = []
  let chars = 0

  function push() {
    if (!current.length) return
    groups.push({
      startSec: current[0].startSec,
      endSec: current[current.length - 1].endSec,
      title: `片段 ${groups.length + 1}`,
      gist: current[0].text,
      points: current.slice(1, 5).map((item) => item.text),
    })
    current = []
    chars = 0
  }

  for (let index = 0; index < list.length; index++) {
    const sentence = list[index]
    const previous = current[current.length - 1]
    if (previous && (sentence.startSec - previous.startSec > 35 || chars > 700)) push()
    current.push(sentence)
    chars += sentence.text.length
  }
  push()
  return groups.slice(0, maxParagraphs)
}
