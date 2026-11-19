const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens']

export function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
  }
}

function count(value) {
  return Number.isFinite(Number(value)) && Number(value) >= 0 ? Math.round(Number(value)) : 0
}

/** Merge one provider usage sample into a running total. */
export function mergeUsage(total, usage) {
  const target = total && typeof total === 'object' ? { ...emptyUsage(), ...total } : emptyUsage()
  if (!usage || typeof usage !== 'object') return target
  let seen = false
  for (const field of FIELDS) {
    if (usage[field] === undefined) continue
    target[field] = count(target[field]) + count(usage[field])
    seen = true
  }
  if (!seen) return target
  if (usage.totalTokens === undefined) {
    target.totalTokens = target.inputTokens + target.outputTokens
  }
  target.calls = count(target.calls) + 1
  return target
}

/** Read a usage sample from an LLM stream chunk, if present. */
export function usageFromChunk(chunk) {
  if (chunk?.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') return chunk.usage
  return null
}

export function totalTokensOf(usage) {
  if (!usage) return 0
  return count(usage.totalTokens || count(usage.inputTokens) + count(usage.outputTokens))
}
