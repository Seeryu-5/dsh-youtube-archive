import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function tempDir(prefix = 'dsh-yt-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

export function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 100 } = {}) {
  const started = Date.now()
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout')
    await sleep(intervalMs)
  }
}
