import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName, ROSTER_PLAYERS } from '../lib/constants.js'

const MIN_REAL_S = 900

// Metrics from the dropdown. get() reads a player-game row; fmt() formats an avg.
const METRICS = [
  { key: 'cs_per_min', label: 'CS per min', get: (p) => p.cs_per_min, fmt: (v) => v.toFixed(1) },
  { key: 'kda', label: 'KDA', get: (p) => (p.deaths ? ((p.kills ?? 0) + (p.assists ?? 0)) / p.deaths : (p.kills ?? 0) + (p.assists ?? 0)), fmt: (v) => v.toFixed(1) },
  { key: 'kill_participation', label: 'Kill participation', get: (p) => p.kill_participation, fmt: (v) => `${Math.round(v)}%`, unit: '%' },
  { key: 'champ_damage_share', label: 'Damage share', get: (p) => p.champ_damage_share, fmt: (v) => `${Math.round(v)}%`, unit: '%' },
  { key: 'gold_diff_15', label: 'Gold diff @15', get: (p) => p.gold_diff_15, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v), signed: true },
  { key: 'cs_diff_15', label: 'CS diff @15', get: (p) => p.cs_diff_15, fmt: (v) => (v > 0 ? '+' : '') + v.toFixed(1), signed: true },
  { key: 'vision_per_min', label: 'Vision / min', get: (p) => p.vision_per_min, fmt: (v) => v.toFixed(2) },
]

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const COL_TEAM = '#4c8bf5'
const COL_FIELD = '#8a91a0'

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

  // game_id -> { opp (canonical), type }
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

  // opponents that have data (for the dropdown)
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

  const data = useMemo(() => {
    if (!selTeam || !metric) return null
    // buckets: [type][vsTeam?] -> array of metric values
    const buckets = { SCRIM: { team: [], field: [] }, ESPORTS: { team: [], field: [] } }
    for (const p of prows || []) {
      if (p.player !== player) continue
      const meta = gameMeta[p.game_id]
      if (!meta) continue
      const v = metric.get(p)
      if (v == null) continue
      const b = buckets[meta.type]
      if (!b) continue
      ;(meta.opp === selTeam ? b.team : b.field).push(v)
    }
    return {
      rows: [
        { name: 'Scrims', vsTeam: mean(buckets.SCRIM.team), vsField: mean(buckets.SCRIM.field), nTeam: buckets.SCRIM.team.length, nField: buckets.SCRIM.field.length },
        { name: 'Officials', vsTeam: mean(buckets.ESPORTS.team), vsField: mean(buckets.ESPORTS.field), nTeam: buckets.ESPORTS.team.length, nField: buckets.ESPORTS.field.length },
      ],
    }
  }, [prows, gameMeta, player, selTeam, metric])

  const labelFmt = (v) => (v == null ? '' : metric.fmt(v))
  const anyData = data && data.rows.some((r) => r.vsTeam != null || r.vsField != null)

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
        <b style={{ color: 'var(--text)' }}>{player}</b>&rsquo;s <b style={{ color: 'var(--text)' }}>{metric.label}</b> — against <b style={{ color: COL_TEAM }}>{selTeam}</b> vs against the <b>rest of the field</b> (all other teams), split by scrims and officials.
        Completed games only.
      </p>

      {pLoading && <div className="loading-state">Loading…</div>}
      {!pLoading && !anyData && <div className="empty-state">No games on record for {player} against {selTeam} yet.</div>}

      {anyData && (
        <div style={{ width: '100%', height: 340 }}>
          <ResponsiveContainer>
            <BarChart data={data.rows} margin={{ top: 24, right: 16, left: 0, bottom: 4 }} barGap={6}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="name" stroke="#9aa1ae" fontSize={13} />
              <YAxis stroke="#9aa1ae" fontSize={12} unit={metric.unit || ''} />
              <Tooltip
                contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                formatter={(v, n, p) => {
                  const isTeam = p.dataKey === 'vsTeam'
                  const n2 = isTeam ? p.payload.nTeam : p.payload.nField
                  return [v == null ? '—' : `${metric.fmt(v)}  (${n2} games)`, isTeam ? `vs ${selTeam}` : 'vs field']
                }}
              />
              <Legend />
              <Bar dataKey="vsTeam" name={`vs ${selTeam}`} fill={COL_TEAM} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="vsTeam" position="top" formatter={labelFmt} fill="#e6e8ec" fontSize={12} />
              </Bar>
              <Bar dataKey="vsField" name="vs field" fill={COL_FIELD} radius={[4, 4, 0, 0]}>
                <LabelList dataKey="vsField" position="top" formatter={labelFmt} fill="#e6e8ec" fontSize={12} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {anyData && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 6 }}>
          Game counts per bar: Scrims — vs {selTeam}: {data.rows[0].nTeam}, field: {data.rows[0].nField} · Officials — vs {selTeam}: {data.rows[1].nTeam}, field: {data.rows[1].nField}.
        </div>
      )}
    </div>
  )
}
