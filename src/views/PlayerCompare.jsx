import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName, ROSTER_PLAYERS } from '../lib/constants.js'

const MIN_REAL_S = 900

const METRICS = [
  { key: 'cs_per_min', label: 'CS per min', get: (p) => p.cs_per_min, fmt: (v) => v.toFixed(1) },
  { key: 'kda', label: 'KDA', get: (p) => (p.deaths ? ((p.kills ?? 0) + (p.assists ?? 0)) / p.deaths : (p.kills ?? 0) + (p.assists ?? 0)), fmt: (v) => v.toFixed(1) },
  { key: 'kill_participation', label: 'Kill participation', get: (p) => p.kill_participation, fmt: (v) => `${Math.round(v)}%` },
  { key: 'champ_damage_share', label: 'Damage share', get: (p) => p.champ_damage_share, fmt: (v) => `${Math.round(v)}%` },
  { key: 'gold_diff_15', label: 'Gold diff @15', get: (p) => p.gold_diff_15, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) },
  { key: 'cs_diff_15', label: 'CS diff @15', get: (p) => p.cs_diff_15, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1) },
  { key: 'vision_per_min', label: 'Vision / min', get: (p) => p.vision_per_min, fmt: (v) => v.toFixed(2) },
]

const COL_TEAM = '#4c8bf5'
const COL_FIELD = '#8a91a0'

// percentile of a value array (not necessarily sorted); q in [0,1]
function quantile(vals, qq) {
  const a = vals.slice().sort((x, y) => x - y)
  if (!a.length) return null
  if (a.length === 1) return a[0]
  const pos = (a.length - 1) * qq
  const b = Math.floor(pos), r = pos - b
  return a[b + 1] !== undefined ? a[b] + r * (a[b + 1] - a[b]) : a[b]
}
const box = (vals) => (vals.length ? { p25: quantile(vals, 0.25), p50: quantile(vals, 0.5), p75: quantile(vals, 0.75), n: vals.length } : { p25: null, p50: null, p75: null, n: 0 })

// ---- box-plot SVG (25th–median–75th) ----
const VW = 700, VH = 340, PX0 = 52, PX1 = 686, PY0 = 20, PY1 = 286
function BoxPlot({ cols, fmt, teamName }) {
  const withData = cols.filter((c) => c.b.p25 != null)
  const lo = Math.min(...withData.map((c) => c.b.p25))
  const hi = Math.max(...withData.map((c) => c.b.p75))
  const pad = (hi - lo) * 0.15 || Math.abs(hi) * 0.15 || 1
  let min = lo - pad, max = hi + pad
  if (min > 0) min = Math.min(0, min) // show zero baseline when all positive-ish for diffs
  const y = (v) => PY1 - ((v - min) / (max - min)) * (PY1 - PY0)
  const halfW = 30
  const ticks = [min, (min + max) / 2, max]
  return (
    <svg viewBox={`0 0 ${VW} ${VH}`} width="100%" style={{ maxHeight: 360 }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={PX0} y1={y(t)} x2={PX1} y2={y(t)} stroke="#2a2f3a" strokeDasharray="3 3" />
          <text x={PX0 - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#9aa1ae">{fmt(t)}</text>
        </g>
      ))}
      {min < 0 && max > 0 && <line x1={PX0} y1={y(0)} x2={PX1} y2={y(0)} stroke="#4b5563" />}
      {cols.map((c) => {
        const cx = PX0 + c.fx * (PX1 - PX0)
        if (c.b.p25 == null) {
          return <text key={c.key} x={cx} y={(PY0 + PY1) / 2} textAnchor="middle" fontSize="11" fill="#6b7280">no games</text>
        }
        const yTop = y(c.b.p75), yBot = y(c.b.p25), yMed = y(c.b.p50)
        return (
          <g key={c.key}>
            <rect x={cx - halfW} y={yTop} width={halfW * 2} height={Math.max(2, yBot - yTop)} rx="3" fill={`${c.color}33`} stroke={c.color} strokeWidth="1.5" />
            <line x1={cx - halfW} y1={yMed} x2={cx + halfW} y2={yMed} stroke={c.color} strokeWidth="3" />
            <text x={cx + halfW + 6} y={yMed + 4} fontSize="12" fontWeight="700" fill="#e6e8ec">{fmt(c.b.p50)}</text>
            <text x={cx} y={PY1 + 18} textAnchor="middle" fontSize="11" fill="#c9ced8">{c.label}</text>
            <text x={cx} y={PY1 + 32} textAnchor="middle" fontSize="10" fill="#6b7280">{c.b.n} games</text>
          </g>
        )
      })}
      {/* group labels */}
      <text x={PX0 + 0.22 * (PX1 - PX0)} y={VH - 6} textAnchor="middle" fontSize="12" fontWeight="700" fill="#9aa1ae">SCRIMS</text>
      <text x={PX0 + 0.72 * (PX1 - PX0)} y={VH - 6} textAnchor="middle" fontSize="12" fontWeight="700" fill="#9aa1ae">OFFICIALS</text>
    </svg>
  )
}

export default function PlayerCompare() {
  const { data: series } = useSupabaseQuery(() => supabase.from('grid_series').select('grid_series_id, opponent_name, series_type'), [])
  const { data: games } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select('id, grid_series_id, riot_enriched, game_duration_s')), []
  )
  const { data: prows, loading: pLoading } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select(
      'game_id, player, cs_per_min, kill_participation, champ_damage_share, gold_diff_15, cs_diff_15, vision_per_min, kills, deaths, assists'
    ).eq('is_sentinels', true)), []
  )

  const gameMeta = useMemo(() => {
    const sById = Object.fromEntries((series || []).map((s) => [s.grid_series_id, s]))
    const m = {}
    for (const g of games || []) {
      const s = sById[g.grid_series_id]
      if (!s || !g.riot_enriched || g.game_duration_s < MIN_REAL_S) continue
      m[g.id] = { opp: canonicalOpponentName(s.opponent_name || ''), type: s.series_type }
    }
    return m
  }, [series, games])

  const opps = useMemo(() => {
    const c = new Map()
    for (const p of prows || []) {
      const meta = gameMeta[p.game_id]
      if (!meta || !meta.opp) continue
      c.set(meta.opp, (c.get(meta.opp) || 0) + 1)
    }
    return [...c.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
  }, [prows, gameMeta])

  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])
  const [team, setTeam] = useState('')
  const [metricKey, setMetricKey] = useState(METRICS[0].key)
  const selTeam = team || (opps[0]?.name ?? null)
  const metric = METRICS.find((m) => m.key === metricKey)

  const cols = useMemo(() => {
    if (!selTeam || !metric) return null
    const buk = { SCRIM: { team: [], field: [] }, ESPORTS: { team: [], field: [] } }
    for (const p of prows || []) {
      if (p.player !== player) continue
      const meta = gameMeta[p.game_id]
      if (!meta) continue
      const v = metric.get(p)
      if (v == null || Number.isNaN(v)) continue
      const b = buk[meta.type]
      if (!b) continue
      ;(meta.opp === selTeam ? b.team : b.field).push(v)
    }
    return [
      { key: 'st', label: `vs ${selTeam}`, color: COL_TEAM, fx: 0.14, b: box(buk.SCRIM.team) },
      { key: 'sf', label: 'vs field', color: COL_FIELD, fx: 0.30, b: box(buk.SCRIM.field) },
      { key: 'ot', label: `vs ${selTeam}`, color: COL_TEAM, fx: 0.64, b: box(buk.ESPORTS.team) },
      { key: 'of', label: 'vs field', color: COL_FIELD, fx: 0.80, b: box(buk.ESPORTS.field) },
    ]
  }, [prows, gameMeta, player, selTeam, metric])

  const anyData = cols && cols.some((c) => c.b.p25 != null)

  return (
    <div className="panel">
      <h2>Individual — Player vs Team</h2>

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 6 }}>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Opposition team</div>
          <select className="search-input" value={selTeam || ''} onChange={(e) => setTeam(e.target.value)} style={{ minWidth: 220, fontSize: 14, padding: '8px 10px' }}>
            {opps.map((o) => <option key={o.name} value={o.name}>{o.name} ({o.n})</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Player</div>
          <div className="player-tabs" style={{ margin: 0 }}>
            {ROSTER_PLAYERS.map((pl) => (
              <button key={pl} type="button" className={`player-tab ${player === pl ? 'active' : ''}`} onClick={() => setPlayer(pl)}>{pl}</button>
            ))}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Metric</div>
          <select className="search-input" value={metricKey} onChange={(e) => setMetricKey(e.target.value)} style={{ minWidth: 180, fontSize: 14, padding: '8px 10px' }}>
            {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </div>
      </div>

      <p className="panel-caption" style={{ marginTop: 0 }}>
        <b style={{ color: 'var(--text)' }}>{player}</b>&rsquo;s <b style={{ color: 'var(--text)' }}>{metric.label}</b> against <b style={{ color: COL_TEAM }}>{selTeam}</b> vs the rest of the field, in scrims and officials.
        Each box is the middle 50% of games — bottom of the box is the 25th percentile, top is the 75th, the thick line is the median. Completed games only.
      </p>

      {pLoading && <div className="loading-state">Loading…</div>}
      {!pLoading && !anyData && <div className="empty-state">No games on record for {player} yet.</div>}

      {anyData && <BoxPlot cols={cols} fmt={metric.fmt} teamName={selTeam} />}

      {anyData && (
        <div style={{ display: 'flex', gap: 18, marginTop: 8, fontSize: 12, color: 'var(--text-faint)' }}>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: COL_TEAM, borderRadius: 2, marginRight: 5 }} />vs {selTeam}</span>
          <span><span style={{ display: 'inline-block', width: 10, height: 10, background: COL_FIELD, borderRadius: 2, marginRight: 5 }} />vs field (all other teams)</span>
        </div>
      )}
    </div>
  )
}
