import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyUsage, mergeUsage, usageFromChunk } from '../lib/llm-usage.js'

test('mergeUsage accumulates provider samples safely', () => {
  let usage = emptyUsage()
  usage = mergeUsage(usage, { inputTokens: 100, outputTokens: 20 })
  usage = mergeUsage(usage, { inputTokens: 50, outputTokens: 10, cacheReadTokens: 30, reasoningTokens: 5 })
  assert.equal(usage.inputTokens, 150)
  assert.equal(usage.outputTokens, 30)
  assert.equal(usage.cacheReadTokens, 30)
  assert.equal(usage.reasoningTokens, 5)
  assert.equal(usage.calls, 2)
  assert.equal(usage.totalTokens, 180)
})

test('usageFromChunk reads only usage chunks', () => {
  assert.deepEqual(usageFromChunk({ type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }), { inputTokens: 1, outputTokens: 2 })
  assert.equal(usageFromChunk({ type: 'text-delta', text: 'x' }), null)
})
