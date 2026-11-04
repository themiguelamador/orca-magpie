// main.mjs — orca-magpie worker.
//
// Polls the magpie gateway's quota endpoint, keeps the last result in
// storage, pushes it to the panel, and keeps a status bar item current.
// Commands that act (switch account, quota, install) are typed into a
// terminal of the focused workspace: orca's plugin host API has no clean
// process-execution method yet (stablyai/orca#36400 proposes one), and
// typing keeps every action visible and reviewable. autoEnter (a setting,
// off by default) lets Return be pressed for you.

import { fetchQuotas, normalizeQuotas } from './lib/gateway.mjs'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

let orca = null
let pollTimer = null
let polling = false
let lastStatus = null
let cachedBin

const TERMINAL_COMMANDS = {
  quota: (s, bin) => `${bin} quota`,
  'switch-claude-next': (s, bin) => `${bin} accounts switch claude next`,
  'switch-codex-next': (s, bin) => `${bin} accounts switch codex next`,
  'check-gateway': (s) =>
    `curl -sS -m 5 ${String(s.gatewayUrl || 'http://127.0.0.1:3425').replace(/\/+$/, '')}/v1/magpie/quotas | head -c 400`,
  install: () => 'curl -fsSL https://usemagpie.ai/install.sh | sh',
}

// The magpie CLI is the same binary as the app. Resolve it for the text we
// type: plain `magpie` when it is on PATH, else the app-bundle path, so a
// GUI-only install (manual download, no symlink — #2563's gap) still works.
export function resolveMagpieBin(refresh = false) {
  if (!refresh && cachedBin !== undefined) return cachedBin
  cachedBin = null
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue
    if (isExec(join(dir, 'magpie'))) { cachedBin = 'magpie'; return cachedBin }
  }
  const home = process.env.HOME || ''
  for (const p of ['/Applications/magpie.app/Contents/MacOS/magpie', join(home, 'Applications/magpie.app/Contents/MacOS/magpie')]) {
    if (isExec(p)) { cachedBin = p; return cachedBin }
  }
  return cachedBin
}

function isExec(p) {
  try { accessSync(p, constants.X_OK); return true } catch { return false }
}

export default function activate(api) {
  orca = api

  try {
    orca.events.on('workspace.changed', (ctx) => { setContext(ctx) })
  } catch (err) {
    orca.log(`workspace.changed subscribe failed: ${err}`)
  }

  orca.commands.register('refresh', async () => {
    const st = await refreshNow()
    const line = statusLine(st)
    await notify(line.title, line.body)
    return line.title
  })
  orca.commands.register('quota-terminal', () => runInTerminal('quota'))
  orca.commands.register('switch-claude-next', () => runInTerminal('switch-claude-next'))
  orca.commands.register('switch-codex-next', () => runInTerminal('switch-codex-next'))
  orca.commands.register('check-gateway', () => runInTerminal('check-gateway'))
  orca.commands.register('install-gateway', () => runInTerminal('install'))

  orca.panels.handle('magpie.status', async () => statusPayload())
  orca.panels.handle('magpie.refresh', async () => {
    await refreshNow()
    return statusPayload()
  })
  orca.panels.handle('magpie.run', async ({ kind } = {}) => runInTerminal(kind))
  orca.panels.handle('magpie.setKey', async ({ key } = {}) => {
    await orca.host.call('secrets.set', { key: 'gatewayKey', value: String(key || '') })
    const st = await refreshNow()
    return statusPayload()
  })
  orca.panels.handle('magpie.clearKey', async () => {
    await orca.host.call('secrets.set', { key: 'gatewayKey', value: '' })
    return { ok: true }
  })

  scheduleNext(0)
  orca.log('orca-magpie worker up')
}

export async function deactivate() {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

// ---- context (which terminal to type into) ----

let lastContext = null
function setContext(ctx) {
  lastContext = ctx && typeof ctx === 'object' ? ctx : null
}

function pickTerminal() {
  const terminals = normalizeTerminals(lastContext)
  if (!terminals.length) return null
  // Prefer a plain shell over an agent pane: typing into a Claude Code
  // pane would feed the agent, not the shell. If every terminal looks
  // like an agent pane, type nowhere — never fall back to an agent pane.
  const looksAgent = (t) =>
    /\b(claude|codex|gemini|grok|hermes|opencode|oh-my-pi|omp|pi|aider|crush)\b/i.test(t.title || '')
  const shell = [...terminals].reverse().find((t) => !looksAgent(t))
  return shell || null
}

function normalizeTerminals(ctx) {
  if (!ctx) return []
  const list = ctx.terminals || ctx.terminalIds || ctx.terminals_
  if (!Array.isArray(list)) return []
  return list
    .map((t) => {
      if (typeof t === 'string') return { id: t, title: null }
      if (t && typeof t === 'object') return { id: t.id || t.terminalId, title: t.title || null }
      return null
    })
    .filter((t) => t && t.id)
}

async function runInTerminal(kind) {
  const settings = await getSettings()
  const bin = resolveMagpieBin() || 'magpie'
  const make = TERMINAL_COMMANDS[kind]
  const text = typeof make === 'function' ? make(settings, bin) : make
  if (!text) return { ok: false, error: `Unknown command kind: ${kind}` }
  if (!lastContext) {
    // Seed the terminal list if no workspace.changed has arrived yet.
    try { setContext(await orca.host.call('workspace.readContext')) } catch {}
  }
  const term = pickTerminal()
  if (!term) {
    const msg = 'No shell terminal in the focused workspace — open one (not an agent pane) first.'
    await notify('Magpie', msg)
    return { ok: false, error: msg }
  }
  let accepted = false
  try {
    const res = await orca.host.call('terminal.sendText', {
      terminalId: term.id,
      text,
      enter: !!settings.autoEnter,
    })
    accepted = !!(res && res.accepted)
  } catch (err) {
    return { ok: false, error: `terminal.sendText failed: ${err}` }
  }
  const where = term.title ? `terminal "${term.title}"` : 'the focused workspace terminal'
  return {
    ok: accepted,
    typed: text,
    enterPressed: !!settings.autoEnter,
    message: accepted
      ? `Typed into ${where}${settings.autoEnter ? ' and pressed Return' : ' — press Return to run it'}`
      : `Terminal did not accept the text`,
  }
}

// ---- polling ----

async function getSettings() {
  try {
    const s = await orca.host.call('settings.get')
    return {
      gatewayUrl: (s && s.gatewayUrl) || 'http://127.0.0.1:3425',
      pollIntervalMs: clampInt(s && s.pollIntervalMs, 5000, 600000, 30000),
      autoEnter: !!(s && s.autoEnter),
      showStatusBar: s ? s.showStatusBar !== false : true,
    }
  } catch {
    return { gatewayUrl: 'http://127.0.0.1:3425', pollIntervalMs: 30000, autoEnter: false, showStatusBar: true }
  }
}

async function getGatewayKey() {
  try {
    const res = await orca.host.call('secrets.get', { key: 'gatewayKey' })
    return (res && typeof res.value === 'string' && res.value) || (res && typeof res === 'string' && res) || ''
  } catch {
    return ''
  }
}

async function refreshNow() {
  if (polling) return lastStatus
  polling = true
  try {
    const settings = await getSettings()
    const key = await getGatewayKey()
    const res = await fetchQuotas({ base: settings.gatewayUrl, key })
    lastStatus = res.ok
      ? { ok: true, gatewayUrl: settings.gatewayUrl, ...normalizeQuotas(res.data), error: null }
      : { ok: false, gatewayUrl: settings.gatewayUrl, cards: [], cardCount: 0, tightestPct: null, fetchedAt: new Date().toISOString(), error: res.error }
    await publish(lastStatus, settings)
    return lastStatus
  } finally {
    polling = false
  }
}

async function publish(st, settings) {
  try { await orca.host.call('storage.set', { key: 'lastStatus', value: st }) } catch {}
  try { orca.panels.post('magpie.updated', st) } catch {}
  const line = statusLine(st)
  try {
    await orca.host.call('statusBar.update', {
      id: 'quotas',
      text: line.text,
      tone: line.tone,
      tooltip: line.tooltip,
      visible: settings.showStatusBar !== false,
    })
  } catch {}
}

function statusLine(st) {
  if (!st.ok) {
    return { text: 'magpie ✕', tone: 'warning', tooltip: `Magpie: ${st.error || 'unreachable'}`, title: 'Magpie unreachable', body: st.error || '' }
  }
  const pct = st.tightestPct
  if (pct === null) {
    return { text: `magpie ${st.cardCount}▮`, tone: 'neutral', tooltip: `Magpie: ${st.cardCount} account card(s), no windows read`, title: 'Magpie quotas refreshed', body: `${st.cardCount} account card(s)` }
  }
  const tone = pct >= 95 ? 'danger' : pct >= 80 ? 'warning' : 'neutral'
  return {
    text: `magpie ${pct}%`,
    tone,
    tooltip: `Magpie: tightest window ${pct}% used (${st.cardCount} cards)`,
    title: 'Magpie quotas refreshed',
    body: `Tightest window ${pct}% used · ${st.cardCount} cards`,
  }
}

function statusPayload() {
  if (lastStatus) return { ok: true, status: lastStatus }
  return { ok: true, status: null, hint: 'first poll pending' }
}

function scheduleNext(delayMs) {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = setTimeout(async () => {
    try { await refreshNow() } catch (err) { orca.log(`poll failed: ${err}`) }
    const settings = await getSettings()
    scheduleNext(settings.pollIntervalMs)
  }, delayMs)
}

async function notify(title, body) {
  try { await orca.host.call('notifications.show', { title, body: body || '' }) } catch {}
}

function clampInt(v, min, max, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(min, Math.min(max, Math.round(n)))
}
