// Shared prognostics + DM-graph math for the coaching hub.
//
// A "prognostic" expresses a performance against a per-opponent PAR — our own
// historical average on that metric versus that team. 100% = exactly at par
// (how we've historically done against them). Over 100% is, by definition, an
// improvement; under 100% is below our own history against that opponent. This
// normalises every metric and every opponent onto one comparable scale.

export const MIN_REAL_GAME_S = 900

// Everything BEFORE July is the frozen baseline that sets the 100% prognostic
// line; from the start of July onward is the tracked period shown on the graph.
export const TRACK_START = '2026-07-01'

export const clampN = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

export function quantile(arr, q) {
  const a = arr.filter((x) => x != null).slice().sort((x, y) => x - y)
  if (!a.length) return null
  if (a.length === 1) return a[0]
  const pos = (a.length - 1) * q, b = Math.floor(pos), r = pos - b
  return a[b + 1] !== undefined ? a[b] + r * (a[b + 1] - a[b]) : a[b]
}

// direction-aware, sign-safe: works for negative pars (gold diff) and for
// lower-is-better metrics (give-back rate). Reduces to actual/par*100 for a
// positive higher-is-better metric (e.g. 41 vs a par of 60 -> 68.3%).
export function prognosticPct(actual, par, higher = true) {
  if (actual == null || par == null) return null
  const denom = Math.abs(par)
  if (denom < 1e-9) return actual === par ? 100 : null
  const dir = higher ? 1 : -1
  return 100 + (dir * (actual - par) / denom) * 100
}

export const fmtPct = (v) => (v == null ? '—' : `${Math.round(v)}%`)

// Improvement over our own baseline: 0 = at par (no change), + = better, − = worse.
// This is prognosticPct − 100, computed so nulls propagate. Use this wherever the
// label says "improvement"; use prognosticPct where the label says "% of baseline".
export function improvementPct(actual, par, higher = true) {
  const p = prognosticPct(actual, par, higher)
  return p == null ? null : p - 100
}
// Format an improvement delta: leading + for gains, native − for declines, 0% flat.
export const fmtImp = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v)}%`)

// ---- date helpers (calendar days, TZ-safe via UTC noon) --------------------
export const parseISO = (s) => new Date(s + 'T12:00:00Z')
export const isoOf = (d) => d.toISOString().slice(0, 10)
export const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000)
export const addDaysISO = (s, n) => { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d) }
export const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
export const rangeDates = (start, end) => { const out = []; const n = daysBetween(start, end); for (let i = 0; i <= n; i++) out.push(addDaysISO(start, i)); return out }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export const wdOf = (s) => WD[parseISO(s).getUTCDay()]

// least-squares fit through {x, y} points -> {slope, intercept}
export function lsqFit(pts) {
  const n = pts.length
  if (n < 2) return null
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y }
  const d = n * sxx - sx * sx
  if (d === 0) return null
  const slope = (n * sxy - sx * sy) / d
  return { slope, intercept: (sy - slope * sx) / n }
}
