import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { resolveConfig } from '../lib/config.js'
import { startIngestServer } from '../lib/ingest-server.js'
import { cleanup, tempDir } from './helpers.mjs'

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
  })
}

async function post(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

test('ingest server enforces header/origin rules and forwards events', async () => {
  const dir = tempDir()
  const port = await freePort()
  const config = resolveConfig({ outputDir: dir, port })
  const events = []
  const logs = []
  const { server, port: actual } = await startIngestServer({
    config,
    onEvent: async (event) => {
      events.push(event)
      return { watchedSec: 42 }
    },
    getHealth: () => ({ enabled: true }),
    log: (entry) => logs.push(entry),
  })
  try {
    const health = await fetch(`http://127.0.0.1:${actual}/api/health`).then((res) => res.json())
    assert.equal(health.ok, true)
    assert.equal(health.name, 'dsh-youtube-archive')
    assert.equal(health.enabled, true)

    const noHeader = await fetch(`http://127.0.0.1:${actual}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'hello' }),
    })
    assert.equal(noHeader.status, 403)

    const badOrigin = await post(
      actual,
      { kind: 'hello' },
      { Origin: 'https://evil.example' },
    )
    assert.equal(badOrigin.status, 403)

    const invalidJson = await post(actual, '{not json')
    assert.equal(invalidJson.status, 400)

    const invalidKind = await post(actual, { kind: 'nope' })
    assert.equal(invalidKind.status, 400)

    const ok = await post(actual, {
      schema: 1,
      kind: 'heartbeat',
      videoId: 'abc123DEF45',
      currentTime: 10,
      duration: 100,
    })
    assert.equal(ok.status, 200)
    const payload = await ok.json()
    assert.equal(payload.watchedSec, 42)
    assert.equal(events.length, 1)
    assert.equal(events[0].videoId, 'abc123DEF45')
    assert.ok(logs.some((entry) => entry.type === 'ingest'))
  } finally {
    server.close()
    cleanup(dir)
  }
})

test('a busy port falls back to the next candidate', async () => {
  const dir = tempDir()
  const base = await freePort()
  const config = resolveConfig({ outputDir: dir, port: base })
  const first = await startIngestServer({ config, onEvent: () => ({ watchedSec: 0 }), log: () => {} })
  let second
  try {
    second = await startIngestServer({ config, onEvent: () => ({ watchedSec: 0 }), log: () => {} })
    assert.equal(first.port, base)
    assert.ok(second.port > base)
  } finally {
    first.server.close()
    second?.server.close()
    cleanup(dir)
  }
})
