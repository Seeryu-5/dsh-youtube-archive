import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome } from './util.js'

export const DEFAULT_CATEGORIES = [
  'AI与技术',
  '商业与经济',
  '教育与学习',
  '科学与工程',
  '历史与人文',
  '健康与生活',
  '创作与媒体',
  '新闻与时事',
  '其他',
]

export const DEFAULTS = {
  enabled: true,
  port: 47821,
  outputDir: null, // null → ~/Documents/YouTube知识库
  minWatchSeconds: 45,
  idleFinalizeMinutes: 1,
  summaryLanguage: 'zh',
  transcriptMaxChars: 60000,
  maxTokens: 8000,
  reasoningEffort: 'low',
  autoSummary: false,
  autoTranslate: false,
  initialSummary: false,
  cleanTranscript: false,
  cleanChunkChars: 3000,
  cleanMaxChunks: 12,
  translateTranscript: true,
  translationChunkChars: 3000,
  translationBatchChunks: 2,
  translationMaxChunks: 12,
  noteTranscriptMaxChars: 24000,
  provider: null,
  model: null,
  skipLive: true,
  skipShorts: true,
  skipMutedBackground: true,
  refreshOnEnd: true,
  fetchMetadata: true,
  categories: DEFAULT_CATEGORIES,
}

function fail(message) {
  throw new Error(`dsh-youtube-archive: ${message}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveInt(value, key, min, max) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    fail(`${key} 必须是 ${min}~${max} 之间的整数`)
  }
  return value
}

export function resolveConfig(raw) {
  if (raw === null || raw === undefined) raw = {}
  if (!isPlainObject(raw)) fail('配置必须是对象')

  const config = { ...DEFAULTS }
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (!(key in DEFAULTS)) fail(`未知配置项 "${key}"`)
    config[key] = value
  }

  if (typeof config.enabled !== 'boolean') fail('enabled 必须是布尔值')
  for (const key of [
    'skipLive',
    'skipShorts',
    'skipMutedBackground',
    'refreshOnEnd',
    'translateTranscript',
    'fetchMetadata',
    'cleanTranscript',
    'initialSummary',
    'autoSummary',
    'autoTranslate',
  ]) {
    if (typeof config[key] !== 'boolean') fail(`${key} 必须是布尔值`)
  }

  if (!['low', 'medium', 'high'].includes(config.reasoningEffort)) {
    fail('reasoningEffort 必须是 low / medium / high')
  }

  positiveInt(config.port, 'port', 1024, 65535)
  positiveInt(config.minWatchSeconds, 'minWatchSeconds', 5, 86400)
  positiveInt(config.idleFinalizeMinutes, 'idleFinalizeMinutes', 1, 1440)
  positiveInt(config.transcriptMaxChars, 'transcriptMaxChars', 2000, 500000)
  positiveInt(config.maxTokens, 'maxTokens', 256, 32000)
  positiveInt(config.cleanChunkChars, 'cleanChunkChars', 1000, 20000)
  positiveInt(config.cleanMaxChunks, 'cleanMaxChunks', 1, 40)
  positiveInt(config.translationChunkChars, 'translationChunkChars', 1000, 20000)
  positiveInt(config.translationBatchChunks, 'translationBatchChunks', 1, 8)
  positiveInt(config.translationMaxChunks, 'translationMaxChunks', 1, 100)
  positiveInt(config.noteTranscriptMaxChars, 'noteTranscriptMaxChars', 2000, 200000)

  if (typeof config.summaryLanguage !== 'string' || !config.summaryLanguage.trim()) {
    fail('summaryLanguage 必须是非空字符串')
  }
  config.summaryLanguage = config.summaryLanguage.trim()

  if (typeof config.outputDir !== 'string' || !config.outputDir.trim()) {
    config.outputDir = join(homedir(), 'Documents', 'YouTube知识库')
  } else {
    config.outputDir = expandHome(config.outputDir.trim())
  }
  if (!config.outputDir) fail('outputDir 不能为空')

  for (const key of ['provider', 'model']) {
    if (config[key] !== null && (typeof config[key] !== 'string' || !config[key].trim())) {
      fail(`${key} 必须是 null 或非空字符串`)
    }
    if (typeof config[key] === 'string') config[key] = config[key].trim()
  }
  if ((config.provider === null) !== (config.model === null)) {
    fail('provider 与 model 必须同时设置或同时为 null')
  }

  if (!Array.isArray(config.categories) || config.categories.length === 0) {
    fail('categories 必须是非空数组')
  }
  const categories = []
  for (const item of config.categories) {
    if (typeof item !== 'string' || !item.trim()) fail('categories 的每一项都必须是非空字符串')
    const name = item.trim()
    if (!categories.includes(name)) categories.push(name)
  }
  if (categories.length > 30) fail('categories 最多 30 个')
  config.categories = categories

  return config
}

/** Ports to try in order when the preferred one is taken. */
export function candidatePorts(config) {
  const ports = [config.port]
  for (let i = 1; i <= 9; i++) {
    const p = config.port + i
    if (p <= 65535) ports.push(p)
  }
  return ports
}
