// lib/gateway.mjs — talk to a magpie gateway's quota endpoint.
//
// The gateway answers `GET <base>/v1/magpie/quotas` with the same JSON
// `magpie quota --json` prints (per entry: provider/account, plan, quota
// windows with use and reset, `lastServedAt`, `last: true` on the account
// that answered most recently). Local (loopback) requests need no key;
// when the gateway is shared on the network, send its key as Bearer.
//
// The exact field names are not a declared contract, so normalizeQuotas
// maps defensively and degrades to showing what it can.

const TIMEOUT_MS = 5000

export async function fetchQuotas({ base, key }) {
  const url = String(base || 'http://127.0.0.1:3425').replace(/\/+$/, '') + '/v1/magpie/quotas'
  const headers = key ? { Authorization: `Bearer ${key}` } : {}

  if (typeof fetch === 'function') {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, { headers, signal: ctrl.signal })
      const text = await res.text()
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${url}`, httpStatus: res.status }
      try {
        return { ok: true, data: JSON.parse(text), url }
      } catch {
        return { ok: false, error: `Gateway answered ${text.length} bytes that are not JSON`, url }
      }
    } catch (err) {
      return { ok: false, error: friendly(err), url }
    } finally {
      clearTimeout(t)
    }
  }

  // Worker without global fetch: fall back to curl.
  try {
    const { execFile } = await import('node:child_process')
    const out = await new Promise((resolve, reject) => {
      const args = ['-s', '-m', String(Math.ceil(TIMEOUT_MS / 1000))]
      if (key) args.push('-H', `Authorization: Bearer ${key}`)
      args.push(url)
      execFile('curl', args, { timeout: TIMEOUT_MS + 500 }, (err2, stdout) => (err2 ? reject(err2) : resolve(stdout)))
    })
    try {
      return { ok: true, data: JSON.parse(out), url }
    } catch {
      return { ok: false, error: 'Gateway answered bytes that are not JSON', url }
    }
  } catch (err) {
    return { ok: false, error: friendly(err), url }
  }
}

function friendly(err) {
  if (err && (err.name === 'AbortError' || /timed? ?out/i.test(String(err.message || err)))) return 'Timed out reaching the gateway'
  if (err && /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(String(err.message || err) + String(err.cause || ''))) {
    return 'Gateway not reachable — is magpie running?'
  }
  return String((err && err.message) || err)
}

// Map the vendor's JSON into a stable shape the panel can render. Unknown
// shapes still produce cards with whatever names were present.
export function normalizeQuotas(raw, fetchedAt = new Date().toISOString()) {
  const entries =
    Array.isArray(raw) ? raw
    : raw && Array.isArray(raw.cards) ? raw.cards
    : raw && Array.isArray(raw.quotas) ? raw.quotas
    : raw && Array.isArray(raw.entries) ? raw.entries
    : []

  const cards = entries.map((e) => {
    const w = asArray(e && (e.windows || e.limits || e.usage || e.quota))
    const windows = w.map(normWindow).filter((x) => x && (x.label !== null || x.usedPct !== null))
    const name =
      (e && (e.name || e.title)) ||
      [e && (e.provider || e.subscription), e && (e.account || e.email || e.login)]
        .filter((s) => typeof s === 'string' && s)
        .join(' · ') || null
    return {
      id: (e && (e.id || e.key)) || name || null,
      name: name || 'Account',
      plan: pickStr(e, ['plan', 'tier', 'subscription']) || null,
      balance: pickStr(e, ['balance', 'credits', 'credit']) || null,
      lastServedAt: pickStr(e, ['lastServedAt', 'last_served_at']) || null,
      isServing: !!(e && e.last),
      windows,
      raw: stripHeavy(e),
    }
  })

  const pcts = []
  for (const c of cards) for (const w of c.windows) if (Number.isFinite(w.usedPct)) pcts.push(w.usedPct)

  return {
    fetchedAt,
    cards,
    tightestPct: pcts.length ? Math.max(...pcts) : null,
    cardCount: cards.length,
  }
}

function normWindow(w) {
  if (typeof w !== 'object' || w === null) return null
  let usedPct = null
  for (const k of ['usedPct', 'used_pct', 'percent', 'pct', 'usedPercent']) {
    if (Number.isFinite(Number(w[k]))) { usedPct = Math.round(Number(w[k])); break }
  }
  if (usedPct === null && Number.isFinite(Number(w.used)) && Number.isFinite(Number(w.total)) && w.total > 0) {
    usedPct = Math.round((Number(w.used) / Number(w.total)) * 100)
  }
  if (usedPct !== null) usedPct = Math.max(0, Math.min(100, usedPct))
  const resets =
    pickStr(w, ['resetsAt', 'resetAt', 'renewsAt', 'resets', 'renews', 'resetsIn', 'reset', 'until']) || null
  return {
    label: pickStr(w, ['label', 'kind', 'name', 'window', 'period']) || null,
    usedPct,
    used: numOrNull(w.used),
    total: numOrNull(w.total),
    resets,
  }
}

function asArray(x) { return Array.isArray(x) ? x : [] }
function pickStr(o, keys) {
  for (const k of keys) { const v = o && o[k]; if (typeof v === 'string' && v) return v }
  return null
}
function numOrNull(v) { return Number.isFinite(Number(v)) ? Number(v) : null }
function stripHeavy(o) {
  if (!o || typeof o !== 'object') return undefined
  const out = {}
  for (const [k, v] of Object.entries(o)) {
    if (v !== null && typeof v === 'object') continue
    if (typeof v === 'string' && v.length > 120) continue
    out[k] = v
  }
  return out
}
