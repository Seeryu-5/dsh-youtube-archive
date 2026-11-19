(() => {
  'use strict'

  const $ = (id) => document.getElementById(id)

  const TINTS = [
    ['#d3f0e1', '#93cfb4'],
    ['#fbe3d6', '#f0b191'],
    ['#f7edc7', '#e6cf7e'],
    ['#d9ecf5', '#a8cfe1'],
    ['#e9e1f6', '#c3b1e0'],
    ['#f9dfe4', '#e9a7b2'],
    ['#e4f0da', '#b2d69c'],
  ]

  const state = {
    items: [],
    categories: [],
    stats: { videos: 0, watchedSec: 0 },
    activeCategory: 'all',
    query: '',
    sort: 'recent',
    current: null,
    detail: null,
    tab: 'summary',
    transcriptMode: 'bilingual',
    expressionQuery: '',
    transcriptQuery: '',
    offline: false,
    lastUpdated: 0,
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      switch (char) {
        case '&':
          return '&amp;'
        case '<':
          return '&lt;'
        case '>':
          return '&gt;'
        case '"':
          return '&quot;'
        default:
          return '&#39;'
      }
    })
  }

  function tintFor(name) {
    let hash = 0
    for (const char of String(name || '其他')) hash = (hash * 31 + char.codePointAt(0)) % 997
    return TINTS[hash % TINTS.length]
  }

  function clock(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    const pad = (n) => String(n).padStart(2, '0')
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
  }

  function durationText(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0))
    if (total === 0) return '—'
    if (total < 60) return `${total} 秒`
    const h = Math.floor(total / 3600)
    const m = Math.round((total % 3600) / 60)
    if (h > 0 && m > 0) return `${h} 小时 ${m} 分`
    if (h > 0) return `${h} 小时`
    return `${m} 分钟`
  }

  function watchedText(seconds) {
    const total = Math.round(Number(seconds) || 0)
    return total <= 0 ? '未记录观看' : durationText(total)
  }

  function dateText(iso) {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    const now = new Date()
    if (date.toDateString() === now.toDateString()) return '今天'
    const sameYear = date.getFullYear() === now.getFullYear()
    return sameYear
      ? `${date.getMonth() + 1} 月 ${date.getDate()} 日`
      : `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
  }

  function toast(message) {
    const element = $('toast')
    element.textContent = message
    element.classList.add('show')
    clearTimeout(toast.timer)
    toast.timer = setTimeout(() => element.classList.remove('show'), 1800)
  }

  function setConnection(online, message) {
    const dot = $('status-dot')
    dot.classList.toggle('online', online)
    dot.classList.toggle('offline', !online)
    $('sync-label').textContent = message
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { cache: 'no-store', ...options })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok || !payload || payload.ok === false) {
      throw new Error((payload && payload.error) || `请求失败（HTTP ${response.status}）`)
    }
    return payload
  }

  function filteredItems() {
    const query = state.query.trim().toLowerCase()
    const items = state.items.filter((item) => {
      if (state.activeCategory !== 'all' && item.category !== state.activeCategory) return false
      if (!query) return true
      const haystack = [item.title, item.channel, item.oneLine, item.category, ...(item.tags || [])]
        .join(' ')
        .toLowerCase()
      return haystack.includes(query)
    })
    return items.sort((a, b) => {
      if (state.sort === 'watched') return (b.watchedSec || 0) - (a.watchedSec || 0)
      if (state.sort === 'title') return String(a.title).localeCompare(String(b.title), 'zh-CN')
      return String(b.lastWatchedAt || '').localeCompare(String(a.lastWatchedAt || ''))
    })
  }

  function renderStats() {
    $('stat-videos').textContent = String(state.stats.videos || state.items.length || 0)
    $('stat-time').textContent = durationText(state.stats.watchedSec || 0)
    $('stat-time').title = `${Math.round((state.stats.watchedSec || 0) / 60)} 分钟`
  }

  function renderCategories() {
    const container = $('categories')
    container.replaceChildren()
    const entries = [
      { name: '全部笔记', value: 'all', count: state.items.length },
      ...state.categories.map((category) => ({ name: category.name, value: category.name, count: category.count })),
    ]
    for (const entry of entries) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `cat${state.activeCategory === entry.value ? ' active' : ''}`
      button.dataset.cat = entry.value
      button.setAttribute('aria-pressed', state.activeCategory === entry.value ? 'true' : 'false')

      const dot = document.createElement('span')
      dot.className = 'cat-dot'
      if (entry.value !== 'all') dot.style.background = tintFor(entry.value)[1]

      const name = document.createElement('span')
      name.className = 'cat-name'
      name.textContent = entry.name

      const count = document.createElement('span')
      count.className = 'cat-count'
      count.textContent = String(entry.count)

      button.append(dot, name, count)
      button.addEventListener('click', () => {
        state.activeCategory = entry.value
        renderCategories()
        renderList()
      })
      container.append(button)
    }
  }

  function buildCard(item) {
    const card = document.createElement('article')
    card.className = 'card'
    card.tabIndex = 0
    card.setAttribute('role', 'button')
    card.setAttribute('aria-label', `打开笔记：${item.title}`)
    card.addEventListener('click', () => openNote(item))
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        openNote(item)
      }
    })

    const tint = tintFor(item.category)
    const thumb = document.createElement('div')
    thumb.className = 'card-thumb'
    thumb.style.setProperty('--tint-a', tint[0])
    thumb.style.setProperty('--tint-b', tint[1])
    if (item.durationSec > 0) {
      const time = document.createElement('span')
      time.className = 'thumb-time'
      time.textContent = clock(item.durationSec)
      thumb.append(time)
    }

    const body = document.createElement('div')
    body.className = 'card-body'

    const kicker = document.createElement('div')
    kicker.className = 'card-kicker'
    const dot = document.createElement('span')
    dot.className = 'kicker-dot'
    dot.style.background = tint[1]
    const name = document.createElement('span')
    name.className = 'kicker-name'
    name.textContent = item.category || '其他'
    const stage = document.createElement('span')
    stage.className = `stage-badge${item.summaryStage === '精读' ? '' : ' basic'}`
    stage.textContent = item.summaryStage === '精读' ? '精读' : '初版'
    kicker.append(dot, name, stage)

    const title = document.createElement('h3')
    title.className = 'card-title'
    title.textContent = item.title || item.videoId

    const line = document.createElement('p')
    line.className = 'card-line'
    line.textContent = item.oneLine || '（还没有一句话总结）'

    const tags = document.createElement('div')
    tags.className = 'card-tags'
    for (const tag of (item.tags || []).slice(0, 3)) {
      const chip = document.createElement('span')
      chip.className = 'tag'
      chip.textContent = tag
      tags.append(chip)
    }

    const foot = document.createElement('div')
    foot.className = 'card-foot'
    const channel = document.createElement('span')
    channel.className = 'channel'
    channel.textContent = item.channel || '未知频道'
    const separator = document.createElement('span')
    separator.textContent = '·'
    const date = document.createElement('span')
    date.textContent = dateText(item.lastWatchedAt)
    const arrow = document.createElement('span')
    arrow.className = 'arrow'
    arrow.textContent = '↗'
    foot.append(channel, separator, date, arrow)

    body.append(kicker, title, line, tags, foot)
    card.append(thumb, body)
    return card
  }

  function renderList() {
    const items = filteredItems()
    const grid = $('grid')
    grid.replaceChildren()
    for (const item of items) grid.append(buildCard(item))

    const title = state.activeCategory === 'all' ? '全部笔记' : state.activeCategory
    $('list-title').textContent = title
    $('count-pill').textContent = String(items.length)
    const totalWatched = items.reduce((sum, item) => sum + (item.watchedSec || 0), 0)
    $('list-sub').textContent = `${items.length} 篇笔记 · 累计观看 ${durationText(totalWatched)}${
      state.lastUpdated ? ` · 更新于 ${new Date(state.lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}` : ''
    }`

    const empty = $('empty')
    if (items.length > 0) {
      empty.hidden = true
    } else {
      empty.hidden = false
      const heading = empty.querySelector('h3')
      const paragraph = empty.querySelector('p')
      if (state.offline) {
        heading.textContent = '无法连接 DSH 插件'
        paragraph.textContent = '请确认 DeepSeek Harness 正在运行，然后点击重新加载。'
      } else if (state.query || state.activeCategory !== 'all') {
        heading.textContent = '没有匹配的笔记'
        paragraph.textContent = '换个关键词或分类试试。'
      } else {
        heading.textContent = '还没有归档的笔记'
        paragraph.textContent = '在 Brave 里播放任意 YouTube 视频 ≥ 45 秒，笔记会自动出现在这里。'
      }
    }
  }

  function renderAll() {
    renderStats()
    renderCategories()
    renderList()
  }

  async function load({ silent = false } = {}) {
    if (!silent) {
      $('loading').hidden = false
    }
    const button = $('refresh')
    button.classList.add('spinning')
    try {
      const data = await api('/api/notes')
      state.items = Array.isArray(data.items) ? data.items : []
      state.categories = Array.isArray(data.categories) ? data.categories : []
      state.stats = data.stats || { videos: state.items.length, watchedSec: 0 }
      state.lastUpdated = data.updatedAt || Date.now()
      state.offline = false
      setConnection(true, `已连接 DSH · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`)
      renderAll()
      const hash = readHash()
      if (hash.path) {
        const item = state.items.find((entry) => entry.notePath === hash.path)
        if (item && (!state.current || state.current.notePath !== hash.path)) {
          await openNote(item, { updateHash: false })
          if (hash.tab) switchTab(hash.tab)
        }
      }
    } catch (error) {
      state.offline = true
      setConnection(false, '未连接 DSH')
      if (state.items.length === 0) {
        $('grid').replaceChildren()
      }
      renderList()
      if (!silent) toast(String(error.message || error))
    } finally {
      $('loading').hidden = true
      button.classList.remove('spinning')
    }
  }

  function metaChip(label, value) {
    const span = document.createElement('span')
    span.append(document.createTextNode(`${label} `))
    const strong = document.createElement('b')
    strong.textContent = value
    span.append(strong)
    return span
  }

  function readHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''))
    return { path: params.get('note') || '', tab: params.get('tab') || '' }
  }

  function parseClockClient(input) {
    const text = String(input || '').trim()
    const parts = text.split(':').map(Number)
    if (!parts.length || parts.some((value) => !Number.isFinite(value))) return null
    return parts.reduce((total, value) => total * 60 + value, 0)
  }

  function youtubeAt(videoId, seconds) {
    return `https://youtu.be/${encodeURIComponent(videoId)}?t=${Math.max(0, Math.floor(Number(seconds) || 0))}`
  }

  function paragraphRange(paragraph) {
    const start = paragraph.start || clock(paragraph.startSec)
    const end = paragraph.end || clock(paragraph.endSec)
    return `${start}–${end}`
  }

  function stripStructuredSections(markdown) {
    let text = String(markdown || '').replace(/^---\n[\s\S]*?\n---\n?/, '')
    for (const heading of ['## 段落笔记', '## 常用英文表达', '## 字幕译文', '## 字幕原文']) {
      const index = text.indexOf(`\n${heading}`)
      if (index >= 0) text = text.slice(0, index)
    }
    return text
  }

  function translationLookup(text) {
    const entries = []
    for (const line of String(text || '').split('\n')) {
      const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line.trim())
      if (!match) continue
      const seconds = parseClockClient(match[1])
      if (seconds === null) continue
      entries.push({ seconds, text: match[2].trim() })
    }
    entries.sort((a, b) => a.seconds - b.seconds)
    return entries
  }

  function emptyInline(title, description) {
    const container = document.createElement('div')
    container.className = 'empty-inline'
    const heading = document.createElement('strong')
    heading.textContent = title
    const text = document.createElement('span')
    text.textContent = description
    container.append(heading, text)
    return container
  }

  function formatTokens(value) {
    const total = Math.max(0, Math.round(Number(value) || 0))
    if (total < 1000) return String(total)
    if (total < 1_000_000) return `${(total / 1000).toFixed(total < 10_000 ? 1 : 0)}k`
    return `${(total / 1_000_000).toFixed(1)}M`
  }

  function renderBanner(item, detail) {
    const banner = $('note-banner')
    banner.replaceChildren()
    banner.className = 'note-banner'
    const video = detail?.video || {}
    const status = String(video.summaryStatus || '')
    const translationStatus = String(video.translationStatus || '')

    let message = ''
    let className = ''
    let retryable = false
    if (status === 'pending') {
      message = '⏳ 正在记录字幕并生成译文；总结可在「总结」页签手动生成。'
    } else if (status === 'failed') {
      message = `总结生成失败：${video.summaryError || '模型没有返回内容'}`
      className = 'error'
      retryable = true
    } else if (translationStatus === 'translating') {
      message = `中文译文正在后台翻译：${video.translationDoneChunks || 0}/${video.translationTotalChunks || '?'} 块。可以继续观看或稍后刷新。`
    } else if (translationStatus === 'partial' || translationStatus === 'failed') {
      message = translationStatus === 'partial' ? '中文译文部分缺失，可在「字幕」页签继续翻译。' : '中文译文生成失败，可在「字幕」页签重试。'
      className = 'warn'
    } else if (!detail?.sentences?.length) {
      message = '没有抓到字幕，本笔记仅依据标题/简介/章节生成。'
      className = 'warn'
    }

    if (!message) {
      banner.hidden = true
      return
    }
    banner.hidden = false
    if (className) banner.classList.add(className)
    const text = document.createElement('span')
    text.className = 'banner-text'
    text.textContent = message
    banner.append(text)
    if (retryable) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'mini-btn'
      button.textContent = '重新生成'
      button.addEventListener('click', () => {
        if (status === 'failed') generateSummary(button)
        else retryCurrentNote(button)
      })
      banner.append(button)
    }
  }

  function estimateSummaryTokens(chars) {
    const value = Math.max(0, Number(chars) || 0)
    return Math.max(1500, Math.round(value / 3 + 2600))
  }

  function estimateTranslationTokens(chars) {
    const value = Math.max(0, Number(chars) || 0)
    return Math.max(800, Math.round(value * 0.8 + 900))
  }

  function renderTranslateCta(item, detail) {
    const cta = $('translate-cta')
    const video = detail?.video || {}
    const status = String(video.translationStatus || '')
    const translated = Boolean(video.translated)
    if (translated && status === 'ok' && !video.translationStale) {
      cta.hidden = true
      return
    }
    if (status === 'source-zh') {
      cta.hidden = true
      return
    }
    cta.hidden = false
    const button = $('generate-translation')
    const text = $('translate-cta-text')
    if (status === 'translating') {
      const done = Number(video.translationDoneChunks || 0)
      const total = Number(video.translationTotalChunks || 0)
      text.textContent = `译文后台翻译中：${done}/${total || '?'} 块，可稍后刷新查看。`
      button.hidden = true
      return
    }
    button.hidden = false
    button.disabled = false
    const estimate = estimateTranslationTokens(video.transcriptChars || item.transcriptChars || 0)
    const label = video.translationStale ? '重新翻译' : status === 'failed' || status === 'partial' ? '继续翻译' : '翻译字幕'
    button.textContent = `${label}（预计 ~${formatTokens(estimate)} tokens）`
    button.onclick = () => translateSubtitles(button)
    text.textContent = video.translationStale
      ? '字幕已更新，旧译文已过期。重新翻译只处理新增/变化的块。'
      : status === 'failed' || status === 'partial'
        ? '上次翻译未完成，可继续从已完成的块翻起。'
        : '字幕原文已保存。点按钮后按批翻译，长视频会显示进度。'
  }

  async function translateSubtitles(button) {
    const item = state.current
    if (!item) return
    const original = button.textContent
    button.disabled = true
    button.textContent = '正在翻译…'
    try {
      await api('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
        body: JSON.stringify({ videoId: item.videoId }),
      })
      toast('已开始翻译字幕，请稍候…')
      setTimeout(() => {
        if (state.current && state.current.videoId === item.videoId) {
          openNote(state.current, { updateHash: false })
        } else {
          button.disabled = false
          button.textContent = original
        }
      }, 8000)
    } catch (error) {
      button.disabled = false
      button.textContent = original
      toast(String(error.message || error))
    }
  }

  function renderSummaryCta(item, detail) {
    const cta = $('summary-cta')
    const status = String(detail?.video?.summaryStatus || '')
    if (status === 'ok') {
      cta.hidden = true
      return
    }
    cta.hidden = false
    const stale = status === 'stale'
    $('summary-cta-title').textContent = stale ? '字幕已更新，总结已过期' : '还没有生成总结'
    $('summary-cta-text').textContent = stale
      ? '重新生成会基于最新字幕更新摘要、段落笔记和英文表达。'
      : '字幕和译文已经保存。生成总结会调用一次模型，产出核心要点、段落笔记和常用英文表达。'
    const estimate = estimateSummaryTokens(detail?.video?.transcriptChars || item.transcriptChars || 0)
    const button = $('generate-summary')
    button.disabled = false
    button.textContent = `生成总结（预计 ~${formatTokens(estimate)} tokens）`
    button.onclick = () => generateSummary(button)
  }

  async function generateSummary(button) {
    const item = state.current
    if (!item) return
    const original = button.textContent
    button.disabled = true
    button.textContent = '正在生成…'
    try {
      await api('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
        body: JSON.stringify({ videoId: item.videoId }),
      })
      toast('已开始生成总结，请稍候…')
      setTimeout(() => {
        if (state.current && state.current.videoId === item.videoId) {
          openNote(state.current, { updateHash: false })
        } else {
          button.disabled = false
          button.textContent = original
        }
      }, 8000)
    } catch (error) {
      button.disabled = false
      button.textContent = original
      toast(String(error.message || error))
    }
  }

  async function retryCurrentNote(button) {
    const item = state.current
    if (!item) return
    button.disabled = true
    try {
      await api('/api/retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
        body: JSON.stringify({ videoId: item.videoId }),
      })
      toast('已开始重新整理，请稍候…')
      setTimeout(() => {
        if (state.current && state.current.videoId === item.videoId) {
          openNote(state.current, { updateHash: false })
        }
      }, 6000)
    } catch (error) {
      button.disabled = false
      toast(String(error.message || error))
    }
  }

  function renderFeatureChips(item, detail) {
    const container = $('feature-chips')
    container.replaceChildren()
    const video = detail?.video || {}
    const sentences = detail?.sentences || []
    const paragraphs = video.paragraphs || []
    const expressions = video.expressions || []
    const sessions = Number(video.watchSessions || item.watchSessions || 0)

    const chips = [{ text: '同一视频只保留一篇', className: 'mint' }]
    if (sessions > 1) chips.push({ text: `已合并 ${sessions} 次观看`, className: 'peach' })
    if (sentences.length) chips.push({ text: '字幕已清洗 · 句子已重建', className: 'mint' })
    else chips.push({ text: '无字幕 · 依据简介', className: '' })
    if (paragraphs.length) chips.push({ text: `段落笔记 ${paragraphs.length}`, className: 'mint' })
    if (expressions.length) chips.push({ text: `英文表达 ${expressions.length}`, className: 'peach' })
    const summaryStatus = String(video.summaryStatus || '')
    if (summaryStatus === 'ok') chips.push({ text: '总结已生成', className: 'mint' })
    else if (summaryStatus === 'none' || summaryStatus === 'stale') chips.push({ text: '总结未生成', className: '' })
    if (String(video.translationStatus || '') === 'translating') {
      chips.push({
        text: `译文 ${video.translationDoneChunks || 0}/${video.translationTotalChunks || '?'}`,
        className: 'peach',
      })
    } else if (!video.translated && String(video.translationStatus || '') !== 'source-zh') {
      chips.push({ text: '译文未生成', className: '' })
    }
    const tokens = Number(video.tokenUsage?.totalTokens || 0)
    if (tokens > 0) chips.push({ text: `约 ${formatTokens(tokens)} tokens`, className: '' })

    for (const chip of chips) {
      const element = document.createElement('span')
      element.className = `chip${chip.className ? ` ${chip.className}` : ''}`
      element.textContent = chip.text
      container.append(element)
    }
  }

  function renderParagraphs(item, detail) {
    const container = $('paragraphs')
    container.replaceChildren()
    const paragraphs = detail?.video?.paragraphs || []
    if (paragraphs.length === 0) {
      container.append(emptyInline('还没有段落笔记', '有字幕的笔记会自动按时间段拆分；短视频可能没有足够内容。'))
      return
    }
    for (const paragraph of paragraphs) {
      const card = document.createElement('article')
      card.className = 'paragraph-card'

      const head = document.createElement('div')
      head.className = 'para-head'
      const range = document.createElement('a')
      range.className = 'para-range'
      range.href = youtubeAt(item.videoId, paragraph.startSec)
      range.target = '_blank'
      range.rel = 'noreferrer'
      range.textContent = paragraphRange(paragraph)
      const title = document.createElement('h4')
      title.className = 'para-title'
      title.textContent = paragraph.title || '段落'
      head.append(range, title)

      const gist = document.createElement('p')
      gist.className = 'para-gist'
      gist.textContent = paragraph.gist || ''

      card.append(head, gist)
      if (Array.isArray(paragraph.points) && paragraph.points.length) {
        const list = document.createElement('ul')
        list.className = 'para-points'
        for (const point of paragraph.points) {
          const itemElement = document.createElement('li')
          itemElement.textContent = point
          list.append(itemElement)
        }
        card.append(list)
      }
      container.append(card)
    }
  }

  function knownExpressions(videoId) {
    try {
      return new Set(JSON.parse(localStorage.getItem(`dsh-yt-known:${videoId}`) || '[]'))
    } catch {
      return new Set()
    }
  }

  function saveKnownExpressions(videoId, set) {
    try {
      localStorage.setItem(`dsh-yt-known:${videoId}`, JSON.stringify([...set]))
    } catch {
      /* storage may be unavailable */
    }
  }

  function renderExpressions(item, detail) {
    const container = $('expressions')
    container.replaceChildren()
    const expressions = detail?.video?.expressions || []
    const query = state.expressionQuery.trim().toLowerCase()
    const filtered = expressions.filter((expression) => {
      if (!query) return true
      return [expression.phrase, expression.meaning, expression.usage, expression.example]
        .join(' ')
        .toLowerCase()
        .includes(query)
    })
    const hint = $('expression-hint')
    hint.textContent = expressions.length ? `${filtered.length} / ${expressions.length} 条` : ''

    if (expressions.length === 0) {
      container.append(emptyInline('还没有英文表达', '英文视频且字幕足够时，模型会自动提取常用表达并给出中文释义。'))
      return
    }
    if (filtered.length === 0) {
      container.append(emptyInline('没有匹配的表达', '换个关键词试试。'))
      return
    }

    const known = knownExpressions(item.videoId)
    for (const expression of filtered) {
      const card = document.createElement('article')
      card.className = `expr-card${known.has(expression.phrase) ? ' known' : ''}`

      const head = document.createElement('div')
      head.className = 'expr-head'
      const phrase = document.createElement('strong')
      phrase.className = 'expr-phrase'
      phrase.textContent = expression.phrase

      const actions = document.createElement('div')
      actions.className = 'expr-actions'
      const copy = document.createElement('button')
      copy.type = 'button'
      copy.className = 'mini-btn'
      copy.textContent = '复制'
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(expression.phrase)
          toast('已复制表达')
        } catch {
          toast('复制失败')
        }
      })
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'mini-btn'
      toggle.textContent = known.has(expression.phrase) ? '已掌握' : '标记掌握'
      toggle.addEventListener('click', () => {
        if (known.has(expression.phrase)) known.delete(expression.phrase)
        else known.add(expression.phrase)
        saveKnownExpressions(item.videoId, known)
        toggle.textContent = known.has(expression.phrase) ? '已掌握' : '标记掌握'
        card.classList.toggle('known', known.has(expression.phrase))
      })
      actions.append(copy, toggle)
      head.append(phrase, actions)

      const meaning = document.createElement('p')
      meaning.className = 'expr-meaning'
      meaning.textContent = expression.meaning || ''

      card.append(head, meaning)
      if (expression.usage) {
        const usage = document.createElement('p')
        usage.className = 'expr-usage'
        usage.textContent = `用法：${expression.usage}`
        card.append(usage)
      }
      if (expression.example) {
        const example = document.createElement('p')
        example.className = 'expr-example'
        example.textContent = expression.example
        card.append(example)
      }
      container.append(card)
    }
  }

  function renderTranscript(item, detail) {
    const container = $('transcript')
    container.replaceChildren()
    const sentences = detail?.sentences || []
    const translation = translationLookup(detail?.translation || '')
    const query = state.transcriptQuery.trim().toLowerCase()

    if (sentences.length === 0) {
      container.append(emptyInline('没有可显示的字幕', '这个视频没有字幕；可以打开 YouTube 自动字幕后再播放一段。'))
      return
    }

    let visible = 0
    sentences.forEach((sentence, index) => {
      const nextStart = Number(sentences[index + 1]?.startSec ?? Infinity)
      let zh = translation
        .filter((entry) => entry.seconds >= sentence.startSec && entry.seconds < nextStart)
        .map((entry) => entry.text)
        .join(' ')
      if (!zh) {
        const previous = [...translation]
          .reverse()
          .find((entry) => entry.seconds <= sentence.startSec && sentence.startSec - entry.seconds <= 1.5)
        zh = previous?.text || ''
      }
      if (query && !`${sentence.text} ${zh}`.toLowerCase().includes(query)) return
      visible++

      const row = document.createElement('div')
      row.className = 'sentence-row'
      if (!zh) row.classList.add('no-zh')
      if (state.transcriptMode === 'translation') row.classList.add('translation-only')
      if (state.transcriptMode === 'source') row.classList.add('no-zh')

      const time = document.createElement('a')
      time.className = 'sentence-time'
      time.href = youtubeAt(item.videoId, sentence.startSec)
      time.target = '_blank'
      time.rel = 'noreferrer'
      time.textContent = clock(sentence.startSec)

      const body = document.createElement('div')
      const source = document.createElement('div')
      source.className = 'sentence-text'
      source.textContent = sentence.text
      const translated = document.createElement('div')
      translated.className = 'sentence-zh'
      translated.textContent = zh || '（暂无译文）'
      body.append(source, translated)
      row.append(time, body)
      container.append(row)
    })

    if (visible === 0) {
      container.append(emptyInline('没有匹配的字幕', '换个关键词试试。'))
    }
  }

  function switchTab(tab) {
    state.tab = tab
    for (const button of document.querySelectorAll('.drawer-tab')) {
      const active = button.dataset.tab === tab
      button.classList.toggle('active', active)
      button.setAttribute('aria-selected', active ? 'true' : 'false')
    }
    for (const panel of document.querySelectorAll('.tab-panel')) {
      panel.hidden = panel.id !== `panel-${tab}`
      panel.classList.toggle('active', !panel.hidden)
    }
    const scroll = document.querySelector('.drawer-scroll')
    if (scroll) scroll.scrollTop = 0
  }

  async function openNote(item, { updateHash = true } = {}) {
    state.current = item
    state.detail = null
    state.tab = 'summary'
    state.transcriptMode = 'bilingual'
    state.expressionQuery = ''
    state.transcriptQuery = ''
    $('expression-search').value = ''
    $('transcript-search').value = ''
    for (const button of document.querySelectorAll('#transcript-mode button')) {
      button.classList.toggle('active', button.dataset.mode === 'bilingual')
    }
    switchTab('summary')

    const drawer = $('drawer')
    drawer.hidden = false
    document.body.classList.add('drawer-open')

    $('drawer-cat').textContent = item.category || '其他'
    $('drawer-cat').style.background = tintFor(item.category)[0]
    $('drawer-cat').style.color = '#315f4d'
    $('drawer-title').textContent = item.title || item.videoId
    $('drawer-summary').textContent = item.oneLine || ''

    const meta = $('drawer-meta')
    meta.replaceChildren()
    meta.append(
      metaChip('频道', item.channel || '未知'),
      metaChip('时长', item.durationSec > 0 ? clock(item.durationSec) : '未知'),
      metaChip('观看', watchedText(item.watchedSec)),
      metaChip('阶段', item.summaryStage || '初版'),
      metaChip('字幕', item.transcript ? (item.liveCaptions ? '有（实时）' : '有') : '无'),
      metaChip('译文', item.translated ? '有' : item.translationStatus === 'source-zh' ? '原文中文' : '无'),
    )
    if (item.lastWatchedAt) meta.append(metaChip('最近', dateText(item.lastWatchedAt)))
    if (item.tags && item.tags.length) meta.append(metaChip('标签', item.tags.join('、')))

    $('open-youtube').href = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`
    $('copy-path').onclick = () => copyPath(item.notePath)
    $('reveal').onclick = () => reveal(item.notePath)

    $('markdown').innerHTML = '<p class="muted">正在读取笔记…</p>'
    $('note-banner').hidden = true
    $('summary-cta').hidden = true
    $('translate-cta').hidden = true
    $('paragraphs').replaceChildren()
    $('expressions').replaceChildren()
    $('transcript').replaceChildren()
    for (const id of ['count-paragraphs', 'count-expressions', 'count-sentences']) $(id).textContent = ''

    try {
      const note = await api(`/api/note?path=${encodeURIComponent(item.notePath)}`)
      state.detail = note
      const paragraphs = note.video?.paragraphs || []
      const expressions = note.video?.expressions || []
      const sentences = note.sentences || []

      $('markdown').innerHTML = renderMarkdown(stripStructuredSections(note.markdown || ''), item)
      $('count-paragraphs').textContent = paragraphs.length ? String(paragraphs.length) : ''
      $('count-expressions').textContent = expressions.length ? String(expressions.length) : ''
      $('count-sentences').textContent = sentences.length ? String(sentences.length) : ''
      renderFeatureChips(item, note)
      renderBanner(item, note)
      renderSummaryCta(item, note)
      renderTranslateCta(item, note)
      renderParagraphs(item, note)
      renderExpressions(item, note)
      renderTranscript(item, note)
    } catch (error) {
      $('markdown').innerHTML = `<p class="muted">读取失败：${escapeHtml(error.message || error)}</p>`
    }

    if (updateHash) history.replaceState(null, '', `#note=${encodeURIComponent(item.notePath)}`)
    $('close-drawer').focus({ preventScroll: true })
  }

  function closeNote({ updateHash = true } = {}) {
    $('drawer').hidden = true
    document.body.classList.remove('drawer-open')
    state.current = null
    state.detail = null
    $('markdown').replaceChildren()
    $('paragraphs').replaceChildren()
    $('expressions').replaceChildren()
    $('transcript').replaceChildren()
    $('feature-chips').replaceChildren()
    $('note-banner').hidden = true
    $('summary-cta').hidden = true
    $('translate-cta').hidden = true
    if (updateHash) history.replaceState(null, '', location.pathname + location.search)
  }

  async function copyPath(path) {
    try {
      await navigator.clipboard.writeText(path)
      toast('路径已复制')
    } catch {
      toast('复制失败，请在 Finder 中查看')
    }
  }

  async function reveal(path) {
    try {
      await api('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-DSH-Archive': '1' },
        body: JSON.stringify({ path }),
      })
      toast('已在 Finder 中显示')
    } catch (error) {
      toast(String(error.message || error))
    }
  }

  /* ---------------- markdown ---------------- */

  function renderInline(text) {
    let value = escapeHtml(text)
    const codes = []
    value = value.replace(/`([^`]+)`/g, (_match, code) => {
      codes.push(code)
      return `\u0000${codes.length - 1}\u0000`
    })
    value = value.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, url) => {
      if (!/^https?:\/\//i.test(url)) return label
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${label}</a>`
    })
    value = value.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    value = value.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    value = value.replace(/\u0000(\d+)\u0000/g, (_match, index) => `<code>${escapeHtml(codes[Number(index)])}</code>`)
    return value
  }

  function isBlockStart(line) {
    return (
      /^```/.test(line) ||
      /^#{1,4}\s/.test(line) ||
      /^\s*>/.test(line) ||
      /^\s*[-*]\s+/.test(line) ||
      /^\s*\d+\.\s+/.test(line) ||
      /^\s*---+\s*$/.test(line) ||
      /^\s*\|.*\|\s*$/.test(line)
    )
  }

  function trimLeadingNote(source, oneLine) {
    const lines = source.split('\n')
    let index = 0
    while (index < lines.length && !lines[index].trim()) index++
    if (index < lines.length && /^#\s+/.test(lines[index])) index++
    while (index < lines.length && !lines[index].trim()) index++

    if (index < lines.length && /^>\s?/.test(lines[index])) {
      let end = index
      while (end < lines.length && /^>\s?/.test(lines[end])) end++
      const quote = lines
        .slice(index, end)
        .map((line) => line.replace(/^>\s?/, '').trim())
        .join(' ')
        .trim()
      const expected = String(oneLine || '').trim()
      const normalize = (value) => value.replace(/\s+/g, '').slice(0, 32)
      if (expected && normalize(quote).startsWith(normalize(expected))) {
        index = end
      }
    }

    while (index < lines.length && !lines[index].trim()) index++
    if (index < lines.length && /^-\s+频道[:：]/.test(lines[index])) {
      while (index < lines.length && /^-\s+/.test(lines[index])) index++
    }
    return lines.slice(index).join('\n')
  }

  function renderMarkdown(markdown, item) {
    let source = String(markdown || '').replace(/\r\n?/g, '\n')
    source = source.replace(/^---\n[\s\S]*?\n---\n?/, '')
    source = trimLeadingNote(source, item && item.oneLine)
    const lines = source.split('\n')
    const html = []
    let index = 0

    while (index < lines.length) {
      const line = lines[index]
      if (!line.trim()) {
        index++
        continue
      }

      if (/^```/.test(line)) {
        index++
        const buffer = []
        while (index < lines.length && !/^```/.test(lines[index])) {
          buffer.push(lines[index])
          index++
        }
        index++
        html.push(`<pre><code>${escapeHtml(buffer.join('\n'))}</code></pre>`)
        continue
      }

      const heading = /^(#{1,4})\s+(.*)$/.exec(line)
      if (heading) {
        const level = heading[1].length
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
        index++
        continue
      }

      if (/^\s*---+\s*$/.test(line)) {
        html.push('<hr>')
        index++
        continue
      }

      if (/^\s*>/.test(line)) {
        const buffer = []
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          buffer.push(lines[index].replace(/^\s*>\s?/, ''))
          index++
        }
        html.push(`<blockquote>${buffer.map((item) => renderInline(item)).join('<br>')}</blockquote>`)
        continue
      }

      if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1])) {
        const cells = (row) =>
          row
            .trim()
            .replace(/^\|/, '')
            .replace(/\|$/, '')
            .split('|')
            .map((cell) => cell.trim())
        const header = cells(line)
        index += 2
        const rows = []
        while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
          rows.push(cells(lines[index]))
          index++
        }
        html.push(
          `<table><thead><tr>${header
            .map((cell) => `<th>${renderInline(cell)}</th>`)
            .join('')}</tr></thead><tbody>${rows
            .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table>`,
        )
        continue
      }

      if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
        const ordered = /^\s*\d+\.\s+/.test(line)
        const pattern = ordered ? /^\s*\d+\.\s+/ : /^\s*[-*]\s+/
        const items = []
        while (index < lines.length && pattern.test(lines[index])) {
          let content = lines[index].replace(pattern, '')
          index++
          while (index < lines.length && lines[index].startsWith('  ') && !pattern.test(lines[index])) {
            content += ` ${lines[index].trim()}`
            index++
          }
          items.push(content)
        }
        const rendered = items.map((content) => {
          const task = /^\[([ xX])\]\s+/.exec(content)
          if (task) {
            const done = task[1].toLowerCase() === 'x'
            return `<li class="task${done ? ' done' : ''}">${renderInline(content.slice(task[0].length))}</li>`
          }
          return `<li>${renderInline(content)}</li>`
        })
        html.push(ordered ? `<ol>${rendered.join('')}</ol>` : `<ul>${rendered.join('')}</ul>`)
        continue
      }

      const paragraph = [line]
      index++
      while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) {
        paragraph.push(lines[index])
        index++
      }
      html.push(`<p>${renderInline(paragraph.join(' '))}</p>`)
    }

    return html.join('\n')
  }

  /* ---------------- events ---------------- */

  $('search').addEventListener('input', (event) => {
    state.query = event.target.value
    renderList()
  })

  $('sort').addEventListener('change', (event) => {
    state.sort = event.target.value
    renderList()
  })

  $('refresh').addEventListener('click', () => load())
  $('retry').addEventListener('click', () => load())
  $('close-drawer').addEventListener('click', () => closeNote())

  for (const button of document.querySelectorAll('.drawer-tab')) {
    button.addEventListener('click', () => switchTab(button.dataset.tab))
  }

  $('transcript-mode').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]')
    if (!button || !state.detail) return
    state.transcriptMode = button.dataset.mode
    for (const item of document.querySelectorAll('#transcript-mode button')) {
      item.classList.toggle('active', item.dataset.mode === state.transcriptMode)
    }
    renderTranscript(state.current, state.detail)
  })

  $('expression-search').addEventListener('input', (event) => {
    state.expressionQuery = event.target.value
    if (state.current && state.detail) renderExpressions(state.current, state.detail)
  })

  $('transcript-search').addEventListener('input', (event) => {
    state.transcriptQuery = event.target.value
    if (state.current && state.detail) renderTranscript(state.current, state.detail)
  })
  $('drawer').addEventListener('click', (event) => {
    if (event.target.matches('[data-close]')) closeNote()
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.current) closeNote()
    if (event.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '')) {
      event.preventDefault()
      $('search').focus()
      $('search').select()
    }
  })

  window.addEventListener('hashchange', async () => {
    const hash = readHash()
    if (!hash.path) {
      if (state.current) closeNote({ updateHash: false })
      return
    }
    const item = state.items.find((entry) => entry.notePath === hash.path)
    if (item) {
      await openNote(item, { updateHash: false })
      if (hash.tab) switchTab(hash.tab)
    }
  })

  setInterval(() => {
    if (!document.hidden && !state.current) load({ silent: true })
  }, 60_000)

  load().catch((error) => {
    state.offline = true
    setConnection(false, '未连接 DSH')
    toast(String(error.message || error))
  })
})()
