'use strict'

const DEFAULT_PORT = 47821
const QUEUE_KEY = 'queue'
const MAX_QUEUE = 10
const MAX_AGE_MS = 60 * 60 * 1000

async function getSettings() {
  return chrome.storage.local.get({ port: DEFAULT_PORT, paused: false })
}

function setBadge(connected) {
  try {
    chrome.action.setBadgeText({ text: connected ? '●' : '' })
    chrome.action.setBadgeBackgroundColor({ color: connected ? '#2e7d32' : '#9e9e9e' })
    chrome.action.setBadgeTextColor({ color: '#ffffff' })
  } catch {
    /* ignore */
  }
}

async function postEvent(event) {
  const { port } = await getSettings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-DSH-Archive': '1',
      },
      body: JSON.stringify(event),
      signal: controller.signal,
      credentials: 'omit',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function readQueue() {
  const stored = await chrome.storage.local.get({ [QUEUE_KEY]: [] })
  const queue = Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : []
  const now = Date.now()
  return queue.filter((item) => item && item.event && now - Number(item.at || 0) < MAX_AGE_MS)
}

async function enqueue(event) {
  const now = Date.now()
  let queue = await readQueue()
  // A transcript supersedes queued heartbeats for the same video; keep the queue small.
  if (event.kind === 'transcript' || event.kind === 'ended') {
    queue = queue.filter((item) => !(item.event.kind === 'heartbeat' && item.event.videoId === event.videoId))
  }
  queue.push({ event, at: now })
  while (queue.length > MAX_QUEUE) {
    const heartbeatIndex = queue.findIndex((item) => item.event.kind === 'heartbeat')
    if (heartbeatIndex >= 0) queue.splice(heartbeatIndex, 1)
    else queue.shift()
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: queue })
}

async function flushQueue() {
  const queue = await readQueue()
  const kept = []
  for (const item of queue) {
    try {
      await postEvent(item.event)
    } catch {
      kept.push(item)
    }
  }
  await chrome.storage.local.set({ [QUEUE_KEY]: kept })
  return kept.length
}

async function forward(event) {
  try {
    await postEvent(event)
    setBadge(true)
    return true
  } catch {
    await enqueue(event)
    setBadge(false)
    return false
  }
}

async function checkHealth() {
  const { port } = await getSettings()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 4000)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    const queue = await readQueue()
    setBadge(true)
    await chrome.storage.local.set({
      lastHealth: { ...data, checkedAt: Date.now(), queue: queue.length },
    })
    if (queue.length) await flushQueue()
    return { ok: true, data }
  } catch (error) {
    setBadge(false)
    await chrome.storage.local.set({
      lastHealth: { ok: false, error: String(error?.message || error), checkedAt: Date.now() },
    })
    return { ok: false, error: String(error?.message || error) }
  } finally {
    clearTimeout(timer)
  }
}

function ensureAlarm() {
  try {
    chrome.alarms.create('dsh-archive-health', { periodInMinutes: 1 })
  } catch {
    /* ignore */
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false

  if (message.type === 'dsh-archive-event') {
    const event = { ...message.event }
    if (!event || typeof event !== 'object') {
      sendResponse({ ok: false })
      return false
    }
    if (sender?.tab?.id !== undefined) event.tabId = sender.tab.id
    forward(event)
      .then((ok) => sendResponse({ ok }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }

  if (message.type === 'test-connection') {
    checkHealth()
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: String(error) }))
    return true
  }

  return false
})

if (chrome.runtime.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    ensureAlarm()
    forward({ schema: 1, kind: 'hello', extensionVersion: chrome.runtime.getManifest().version, ts: Date.now() })
  })
}

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    ensureAlarm()
    flushQueue()
  })
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-archive-health') return
  checkHealth()
})

if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener(() => {
    chrome.runtime.openOptionsPage()
  })
}

ensureAlarm()
