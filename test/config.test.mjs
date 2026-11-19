import test from 'node:test'
import assert from 'node:assert/strict'
import { candidatePorts, resolveConfig } from '../lib/config.js'

test('defaults are usable without configuration', () => {
  const config = resolveConfig({})
  assert.equal(config.enabled, true)
  assert.equal(config.port, 47821)
  assert.equal(config.minWatchSeconds, 45)
  assert.equal(config.reasoningEffort, 'low')
  assert.equal(config.initialSummary, false)
  assert.equal(config.autoSummary, false)
  assert.equal(config.autoTranslate, false)
  assert.equal(config.translationBatchChunks, 2)
  assert.ok(config.outputDir.endsWith('Documents/YouTube知识库'))
  assert.ok(config.categories.includes('AI与技术'))
})

test('rejects unknown keys', () => {
  assert.throws(() => resolveConfig({ nope: 1 }), /未知配置项/)
})

test('validates port and positive integers', () => {
  assert.throws(() => resolveConfig({ port: 80 }), /port/)
  assert.throws(() => resolveConfig({ port: 47821.5 }), /port/)
  assert.throws(() => resolveConfig({ minWatchSeconds: 0 }), /minWatchSeconds/)
  assert.throws(() => resolveConfig({ maxTokens: 'big' }), /maxTokens/)
})

test('provider and model must be set together', () => {
  assert.throws(() => resolveConfig({ provider: 'x' }), /provider 与 model/)
  assert.doesNotThrow(() => resolveConfig({ provider: 'x', model: 'y' }))
})

test('categories are trimmed and de-duplicated', () => {
  const config = resolveConfig({ categories: [' A ', 'A', 'B'] })
  assert.deepEqual(config.categories, ['A', 'B'])
  assert.throws(() => resolveConfig({ categories: [] }), /categories/)
})

test('reasoningEffort and initialSummary are validated', () => {
  assert.throws(() => resolveConfig({ reasoningEffort: 'ultra' }), /reasoningEffort/)
  assert.doesNotThrow(() => resolveConfig({ reasoningEffort: 'medium', initialSummary: true }))
  assert.throws(() => resolveConfig({ initialSummary: 'yes' }), /initialSummary/)
})

test('candidatePorts keeps the preferred port first', () => {
  const config = resolveConfig({ port: 47821 })
  assert.equal(candidatePorts(config)[0], 47821)
  assert.equal(candidatePorts(config).length, 10)
})
