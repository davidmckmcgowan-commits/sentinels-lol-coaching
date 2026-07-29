import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName, ROSTER_PLAYERS } from '../lib/constants.js'

const MIN_REAL_S = 900

const METRICS = [
  { key: 'cs_per_min', label: 'CS per min', get: (p) => p.cs_per_min, fmt: (v) => v.toFixed(1), dp: 1 },
  { key: 'kda', label: 'KDA', get: (p) => (p.deaths ? ((p.kills ?? 0) + (p.assists ?? 0)) / p.deaths : (p.kills ?? 0) + (p.assists ?? 0)), fmt: (v) => v.toFixed(1), dp: 1 },
  { key: 'kill_participation', label: 'Kill participation', get: (p) => p.kill_participation, fmt: (v) => `${Math.round(v)}%`, pct: true },
  { key: 'champ_damage_share', label: 'Damage share', get: (p) => p.champ_damage_share, fmt: (v) => `${Math.round(v)}%`, pct: true },
  { key: 'gold_diff_15', label: 'Gold diff @15', get: (p) => p.gold_diff_15, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v), dp: 0 },
  { key: 'cs_diff_15', label: 'CS diff @15', get: (p) => p.cs_diff_15, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1), dp: 1 },
  { key: 'vision_per_min', label: 'Vision / min', get: (p) => p.vision_per_min, fmt: (v) => v.toFixed(2), dp: 2 },
]

const COL_TEAM = '#4c8bf5'

function quantile(vals, qq) {
  const a = vals.slice().sort((x, y) => x - y)
  if (!a.length) return null
  if (a.length === 1) return a[0]
  const pos = (a.length - 1) * qq
  const b = Math.floor(pos), r = pos - b
  return a[b + 1] !== undefined ? a[b] + r * (a[b + 1] - a[b]) : a[b]
}
const box = (vals) => (vals.length ? { p25: quantile(vals, 0.25), p50: quantile(vals, 0.5), p75: quantile(vals, 0.75), n: vals.length } : { p25: null, p50: null, p75: null, n: 0 })

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

  const rows = useMemo(() => {
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
      { name: 'Scrims', team: box(buk.SCRIM.team), field: box(buk.SCRIM.field) },
      { name: 'Officials', team: box(buk.ESPORTS.team), field: box(buk.ESPORTS.field) },
    ]
  }, [prows, gameMeta, player, selTeam, metric])

  const anyData = rows && rows.some((r) => r.team.p50 != null || r.field.p50 != null)
  const dstr = (d) => {
    const s = d > 0 ? '+' : d < 0 ? '−' : ''
    const a = Math.abs(d)
    return s + (metric.pct ? `${Math.round(a)}%` : a.toFixed(metric.dp))
  }

  const th = { textAlign: 'left', padding: '8px 12px', fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em', borderBottom: '1px solid var(--border, #2b2b33)' }
  const td = { padding: '12px', borderBottom: '1px solid var(--border, #2b2b33)', verticalAlign: 'middle' }

  const Cell = ({ b }) => {
    if (b.p50 == null) return <span style={{ color: 'var(--text-faint)' }}>no games</span>
    return (
      <div>
        <span style={{ fontSize: 22, fontWeight: 800 }}>{metric.fmt(b.p50)}</span>
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>
          {metric.fmt(b.p25)} – {metric.fmt(b.p75)} · {b.n} games
        </div>
      </div>
    )
  }

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
        <b style={{ color: 'var(--text)' }}>{player}</b>&rsquo;s <b style={{ color: 'var(--text)' }}>{metric.label}</b> against <b style={{ color: COL_TEAM }}>{selTeam}</b> vs the rest of the field.
        Big number is the median; small line is the 25th–75th range and game count. <b>Δ</b> is his median vs that team minus his median vs the field — green means he steps up against them, red means he drops off. Completed games only.
      </p>

      {pLoading && <div className="loading-state">Loading…</div>}
      {!pLoading && !anyData && <div className="empty-state">No games on record for {player} yet.</div>}

      {anyData && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
            <thead>
              <tr>
                <th style={th}></th>
                <th style={{ ...th, color: COL_TEAM }}>vs {selTeam}</th>
                <th style={th}>vs field</th>
                <th style={th}>Δ vs field</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const hasBoth = r.team.p50 != null && r.field.p50 != null
                const d = hasBoth ? r.team.p50 - r.field.p50 : null
                return (
                  <tr key={r.name}>
                    <td style={{ ...td, fontWeight: 700, fontSize: 14 }}>{r.name}</td>
                    <td style={td}><Cell b={r.team} /></td>
                    <td style={td}><Cell b={r.field} /></td>
                    <td style={{ ...td, fontSize: 18, fontWeight: 800, color: d == null ? 'var(--text-faint)' : d > 0 ? '#3aa76d' : d < 0 ? '#e0524a' : 'var(--text-faint)' }}>
                      {d == null ? '—' : dstr(d)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
