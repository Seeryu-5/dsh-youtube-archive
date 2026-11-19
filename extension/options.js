'use strict'

const $ = (id) => document.getElementById(id)

function setStatus(text, isError = false) {
  const element = $('status')
  element.textContent = text
  element.classList.toggle('error', isError)
}

function formatHealth(health) {
  if (!health) return '尚未检测。'
  if (health.ok === false) {
    return `未连接到 DSH 插件\n${health.error || ''}\n检测时间：${new Date(health.checkedAt || Date.now()).toLocaleString('zh-CN', {
      hour12: false,
    })}`
  }
  const data = health.data || health
  return [
    `插件：${data.name || 'dsh-youtube-archive'} ${data.version || ''}`,
    `端口：${data.port || '—'}`,
    `扩展连接：${data.extensionConnected ? '已连接' : '未连接'}`,
    `已归档：${data.notes ?? 0} 个视频`,
    `输出目录：${data.outputDir || '—'}`,
    `最近心跳：${data.lastHeartbeatAt ? new Date(data.lastHeartbeatAt).toLocaleString('zh-CN', { hour12: false }) : '从未'}`,
    `检测时间：${new Date(health.checkedAt || Date.now()).toLocaleString('zh-CN', { hour12: false })}`,
  ].join('\n')
}

async function load() {
  const stored = await chrome.storage.local.get({ port: 47821, paused: false, lastHealth: null })
  $('port').value = String(stored.port || 47821)
  $('paused').checked = stored.paused === true
  $('health').textContent = formatHealth(stored.lastHealth)
}

async function save() {
  const port = Number($('port').value)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    setStatus('端口必须是 1024~65535 之间的整数。', true)
    return
  }
  await chrome.storage.local.set({ port })
  setStatus(`已保存端口 ${port}。`)
}

async function test() {
  setStatus('正在连接 127.0.0.1 …')
  try {
    const result = await chrome.runtime.sendMessage({ type: 'test-connection' })
    if (result && result.ok) {
      $('health').textContent = formatHealth({ ok: true, data: result.data, checkedAt: Date.now() })
      setStatus('连接成功。')
      const stored = await chrome.storage.local.get({ port: 47821 })
      if (result.data && result.data.port && result.data.port !== stored.port) {
        setStatus(`连接成功；插件实际端口是 ${result.data.port}，请把上面的端口改成它并保存。`, false)
      }
    } else {
      const error = (result && result.error) || '未知错误'
      $('health').textContent = formatHealth({ ok: false, error, checkedAt: Date.now() })
      setStatus(`连接失败：${error}`, true)
    }
  } catch (error) {
    setStatus(`连接失败：${String(error)}`, true)
  }
}

$('save').addEventListener('click', () => {
  save().catch((error) => setStatus(String(error), true))
})
$('test').addEventListener('click', () => {
  test().catch((error) => setStatus(String(error), true))
})
$('paused').addEventListener('change', () => {
  chrome.storage.local.set({ paused: $('paused').checked }).then(() => {
    setStatus($('paused').checked ? '已暂停监控。' : '监控已恢复。')
  })
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return
  if (changes.lastHealth) $('health').textContent = formatHealth(changes.lastHealth.newValue)
  if (changes.paused) $('paused').checked = changes.paused.newValue === true
})

load().catch((error) => setStatus(String(error), true))
