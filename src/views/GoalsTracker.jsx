import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'

const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']
const WINDOW_DAYS = 12 // how many recent scrim days to trend

const avg = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const rate = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : null }

// value of a metric over a set of team-game rows and/or player rows
function metricValue(key, games, prows) {
  switch (key) {
    case 'team_gold_diff_15': return avg(games, (g) => g.gold_diff_15)
    case 'team_cs_diff_15': return avg(games, (g) => g.cs_diff_15)
    case 'first_tower_rate': return rate(games, (g) => g.first_tower_sentinels)
    case 'first_dragon_rate': return rate(games, (g) => (g.sentinels_dragons != null && g.opponent_dragons != null ? g.sentinels_dragons > g.opponent_dragons : null))
    case 'dragon_control_rate': return rate(games, (g) => (g.sentinels_dragons != null && g.opponent_dragons != null ? g.sentinels_dragons > g.opponent_dragons : null))
    case 'grub_majority_rate': return rate(games, (g) => (g.sentinels_grubs != null ? g.sentinels_grubs >= 4 : null))
    case 'player_cs_diff_15': return avg(prows, (p) => p.cs_diff_15)
    case 'player_gold_diff_15': return avg(prows, (p) => p.gold_diff_15)
    case 'player_kp': return avg(prows, (p) => p.kill_participation)
    case 'player_cs_per_min': return avg(prows, (p) => p.cs_per_min)
    case 'player_damage_share': return avg(prows, (p) => p.champ_damage_share)
    case 'player_damage_per_min': return avg(prows, (p) => p.champ_damage_per_min)
    case 'player_vision_score': return avg(prows, (p) => p.vision_score)
    case 'laners_cs_diff_15': return avg(prows, (p) => p.cs_diff_15)
    case 'laners_damage_per_min': return avg(prows, (p) => p.champ_damage_per_min)
    case 'team_give_back_rate': {
      const pp = games.reduce((a, g) => a + (g.positive_plays || 0), 0)
      const gb = games.reduce((a, g) => a + (g.give_backs || 0), 0)
      return pp ? (gb / pp) * 100 : null
    }
    case 'team_snowball_rate': {
      const pp = games.reduce((a, g) => a + (g.positive_plays || 0), 0)
      const sn = games.reduce((a, g) => a + (g.snowballs || 0), 0)
      return pp ? (sn / pp) * 100 : null
    }
    default: return null
  }
}

const fmt = (v, unit) => {
  if (v == null) return '—'
  if (unit === '%') return `${Math.round(v)}%`
  if (unit === 'gold') return (v >= 0 ? '+' : '') + Math.round(v)
  if (unit === 'CS') return (v >= 0 ? '+' : '') + v.toFixed(1)
  if (unit === 'CS/min') return v.toFixed(1)
  return Math.round(v * 10) / 10
}
const fmtDelta = (d, unit) => {
  if (d == null) return null
  const s = d > 0 ? '+' : ''
  if (unit === '%') return `${s}${Math.round(d)}%`
  if (unit === 'gold') return `${s}${Math.round(d)}`
  if (unit === 'CS' || unit === 'CS/min') return `${s}${d.toFixed(1)}`
  return `${s}${Math.round(d * 10) / 10}`
}
const LBL = { fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em' }

function Sparkline({ points, target }) {
  const vals = points.map((p) => p.value).filter((x) => x != null)
  if (vals.length < 2) return <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>not enough days yet</span>
  const all = [...vals, target]
  const min = Math.min(...all), max = Math.max(...all)
  const span = max - min || 1
  const W = 150, H = 34
  const step = W / (points.length - 1)
  const y = (v) => H - ((v - min) / span) * (H - 6) - 3
  const path = points.map((p, i) => (p.value == null ? null : `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p.value).toFixed(1)}`)).filter(Boolean).join(' ')
  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      <line x1="0" y1={y(target)} x2={W} y2={y(target)} stroke="#c9a227" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
      <path d={path} fill="none" stroke="#4c8bf5" strokeWidth="2" />
      {points.map((p, i) => p.value != null && (
        <circle key={i} cx={i * step} cy={y(p.value)} r={i === points.length - 1 ? 3.5 : 2} fill={i === points.length - 1 ? '#4c8bf5' : '#4c8bf5aa'} />
      ))}
    </svg>
  )
}

function GoalCard({ goal, lib, series, games, prows }) {
  const meta = lib[goal.metric_key] || {}
  const unit = meta.unit
  const higher = meta.higher_is_better !== false
  // "laners_*" goals aggregate all Sentinels except the support (Huhi)
  const isLaners = (goal.metric_key || '').startsWith('laners_')
  const playersForDay = (ids) => isLaners
    ? prows.filter((p) => p.player !== 'Huhi' && ids.has(p.game_id))
    : goal.scope === 'player' ? prows.filter((p) => p.player === goal.player && ids.has(p.game_id)) : []

  // recent scrim days (enriched), ascending
  const days = useMemo(() => {
    const dateSet = new Set()
    for (const g of games) {
      const s = series[g.grid_series_id]
      if (s && s.series_type === 'SCRIM' && g.riot_enriched) dateSet.add(s.series_date)
    }
    return [...dateSet].sort().slice(-WINDOW_DAYS)
  }, [games, series])

  const points = useMemo(() => days.map((date) => {
    const dayGames = games.filter((g) => { const s = series[g.grid_series_id]; return s && s.series_date === date && s.series_type === 'SCRIM' && g.riot_enriched })
    const dayGameIds = new Set(dayGames.map((g) => g.id))
    const dayPlayer = playersForDay(dayGameIds)
    return { date, value: metricValue(goal.metric_key, dayGames, dayPlayer) }
  }), [days, games, series, prows, goal])

  const withVals = points.filter((p) => p.value != null)
  const latest = withVals.length ? withVals[withVals.length - 1].value : null
  const prev = withVals.length > 1 ? withVals[withVals.length - 2].value : null
  const latestDate = withVals.length ? withVals[withVals.length - 1].date : null
  const prevDate = withVals.length > 1 ? withVals[withVals.length - 2].date : null
  const delta = latest != null && prev != null ? latest - prev : null

  // week-to-date: metric over all window games at once
  const wtd = useMemo(() => {
    const winGames = games.filter((g) => { const s = series[g.grid_series_id]; return s && days.includes(s.series_date) && s.series_type === 'SCRIM' && g.riot_enriched })
    const winIds = new Set(winGames.map((g) => g.id))
    const winPlayer = playersForDay(winIds)
    return metricValue(goal.metric_key, winGames, winPlayer)
  }, [games, series, days, prows, goal])

  // for team laner goals, find the weakest individual across the window
  const weakest = useMemo(() => {
    if (!isLaners) return null
    const winGames = games.filter((g) => { const s = series[g.grid_series_id]; return s && days.includes(s.series_date) && s.series_type === 'SCRIM' && g.riot_enriched })
    const winIds = new Set(winGames.map((g) => g.id))
    const per = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel']
      .map((pl) => ({ player: pl, value: metricValue(goal.metric_key, [], prows.filter((p) => p.player === pl && winIds.has(p.game_id))) }))
      .filter((x) => x.value != null)
    if (!per.length) return null
    return per.reduce((a, b) => (b.value < a.value ? b : a))
  }, [isLaners, games, series, days, prows, goal])

  const target = Number(goal.target_value)
  const onTrack = wtd != null && (higher ? wtd >= target : wtd <= target)
  const improving = latest != null && prev != null ? (higher ? latest > prev : latest < prev) : null
  const trendColor = improving == null ? 'var(--text-faint)' : improving ? '#3fb950' : '#e5534b'
  const trendArrow = improving == null ? '' : improving ? '▲' : '▼'

  return (
    <div style={{ border: '1px solid var(--border, #2b2b33)', borderRadius: 10, padding: 14, background: 'var(--panel-2, #17171d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {goal.scope === 'player' && <span style={{ color: '#c9a227', marginRight: 6 }}>{goal.player}</span>}
          {meta.label || goal.metric_key}
        </div>
        <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: onTrack ? '#12351f' : '#3a1d1d', color: onTrack ? '#3fb950' : '#e5534b', whiteSpace: 'nowrap' }}>
          {onTrack ? 'on track' : 'below target'}
        </span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '3px 0 2px' }}>{goal.intent}</div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', margin: '0 0 10px', fontStyle: 'italic' }}>
        Measures: {meta.description || meta.label || goal.metric_key}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <div style={LBL}>Today{latestDate ? ` · ${latestDate.slice(5)}` : ''}</div>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>{fmt(latest, unit)}</div>
        </div>
        <div>
          <div style={LBL}>vs last day{prevDate ? ` (${prevDate.slice(5)})` : ''}</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: trendColor }}>
            {delta == null ? <span style={{ color: 'var(--text-faint)' }}>—</span> : <>{trendArrow} {fmtDelta(delta, unit)}</>}
          </div>
        </div>
        <div>
          <div style={LBL}>Week-to-date</div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>{fmt(wtd, unit)}</div>
        </div>
        <div>
          <div style={LBL}>Target</div>
          <div style={{ fontSize: 18, fontWeight: 600, color: '#c9a227' }}>{fmt(target, unit)}</div>
        </div>
        <div style={{ marginLeft: 'auto' }}>
          <Sparkline points={points} target={target} />
          <div style={{ fontSize: 10, color: 'var(--text-faint)', textAlign: 'right' }}>
            baseline {fmt(Number(goal.baseline_value), unit)}
          </div>
        </div>
      </div>
      {isLaners && weakest && (
        <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-faint)' }}>
          Weakest link: <span style={{ color: '#e5534b', fontWeight: 700 }}>{weakest.player}</span> at {fmt(weakest.value, unit)}
        </div>
      )}
    </div>
  )
}

export default function GoalsTracker() {
  const { data: goals, loading: goalsLoading } = useSupabaseQuery(
    () => supabase.from('prep_goals').select('*').eq('active', true), []
  )
  const { data: library } = useSupabaseQuery(() => supabase.from('goal_library').select('*'), [])
  const { data: seriesRows } = useSupabaseQuery(
    () => supabase.from('grid_series').select('grid_series_id, series_date, series_type').gte('series_date', '2026-06-15'), []
  )
  const { data: gameRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, riot_enriched, gold_diff_15, cs_diff_15, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_grubs, positive_plays, give_backs, snowballs'
    )), []
  )
  const { data: playerRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select(
      'game_id, player, cs_diff_15, gold_diff_15, cs_per_min, kill_participation, champ_damage_share, champ_damage_per_min, vision_score'
    ).eq('is_sentinels', true)), []
  )

  const lib = useMemo(() => Object.fromEntries((library || []).map((l) => [l.metric_key, l])), [library])
  const seriesById = useMemo(() => Object.fromEntries((seriesRows || []).map((s) => [s.grid_series_id, s])), [seriesRows])

  // only keep player rows for games in our recent window (cuts the join down)
  const winGameIds = useMemo(() => {
    const ids = new Set()
    for (const g of gameRows || []) if (seriesById[g.grid_series_id]) ids.add(g.id)
    return ids
  }, [gameRows, seriesById])
  const winPlayerRows = useMemo(() => (playerRows || []).filter((p) => winGameIds.has(p.game_id)), [playerRows, winGameIds])
  const winGames = useMemo(() => (gameRows || []).filter((g) => seriesById[g.grid_series_id]), [gameRows, seriesById])

  const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi']
  const teamGoals = (goals || []).filter((g) => g.scope === 'team')
  const playerGoals = (goals || []).filter((g) => g.scope === 'player')
    .sort((a, b) => ROSTER.indexOf(a.player) - ROSTER.indexOf(b.player))

  const loading = goalsLoading || !gameRows || !playerRows || !seriesRows
  const cycleOpp = (goals && goals[0]?.cycle_opponent) || null
  const cycleDate = (goals && goals[0]?.cycle_official_date) || null

  const [newScope, setNewScope] = useState('team')
  const [newPlayer, setNewPlayer] = useState('Impact')
  const [newText, setNewText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { data: suggestions, refetch: refetchSug } = useSupabaseQuery(
    () => supabase.from('goal_suggestions').select('*').eq('status', 'proposed').order('created_at', { ascending: false }), []
  )
  async function submitGoal() {
    if (!newText.trim()) return
    setSubmitting(true)
    try {
      await supabase.from('goal_suggestions').insert({ scope: newScope, player: newScope === 'player' ? newPlayer : null, text: newText.trim() })
      setNewText('')
    } finally {
      setSubmitting(false)
      refetchSug()
    }
  }

  return (
    <div className="panel">
      <h2>Goals</h2>
      <p className="panel-caption">
        SMART targets for the prep week{cycleOpp ? <> — building toward <b style={{ color: 'var(--text)' }}>{cycleOpp}</b>{cycleDate ? ` (${cycleDate})` : ''}</> : ''}.
        Measured off the day&apos;s scrims each time you sync. ▲ means the latest day moved toward target, ▼ away. Gold dashed line on each spark is the target.
      </p>

      {loading && <div className="loading-state">Loading goals…</div>}

      {!loading && (!goals || goals.length === 0) && (
        <div className="empty-state">No active goals set. Send me the goals for this week and I&apos;ll load them.</div>
      )}

      {!loading && goals && goals.length > 0 && (
        <>
          <h3 style={{ marginTop: 4 }}>Team</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {teamGoals.map((g) => (
              <GoalCard key={g.id} goal={g} lib={lib} series={seriesById} games={winGames} prows={winPlayerRows} />
            ))}
          </div>

          <h3 style={{ marginTop: 22 }}>Individual</h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
            {playerGoals
              .sort((a, b) => (['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi'].indexOf(a.player)) - (['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi'].indexOf(b.player)))
              .map((g) => (
                <GoalCard key={g.id} goal={g} lib={lib} series={seriesById} games={winGames} prows={winPlayerRows} />
              ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 26, borderTop: '1px solid var(--border, #2b2b33)', paddingTop: 18 }}>
        <h3 style={{ marginTop: 0 }}>Propose a goal</h3>
        <p className="panel-caption" style={{ marginTop: 0 }}>
          Coaches: drop a rough goal here in plain language. It lands in the list below, and we shape it into a
          measurable SMART goal in chat before it starts being tracked.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="filter-field">
            <label>For</label>
            <select className="search-input" value={newScope} onChange={(e) => setNewScope(e.target.value)}>
              <option value="team">Team</option>
              <option value="player">Player</option>
            </select>
          </div>
          {newScope === 'player' && (
            <div className="filter-field">
              <label>Player</label>
              <select className="search-input" value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)}>
                {ROSTER.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div className="filter-field" style={{ flex: 1, minWidth: 240 }}>
            <label>Goal</label>
            <input
              className="search-input"
              placeholder="e.g. better vision control bot side"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitGoal() }}
            />
          </div>
          <button
            type="button"
            disabled={submitting || !newText.trim()}
            onClick={submitGoal}
            style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: submitting || !newText.trim() ? '#555' : '#e01e37', color: '#fff', fontWeight: 600, cursor: submitting ? 'default' : 'pointer' }}
          >
            {submitting ? 'Adding…' : 'Add goal'}
          </button>
        </div>

        {suggestions && suggestions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={LBL}>Pending — to shape into SMART goals in chat</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {suggestions.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: 'var(--panel-2, #17171d)', border: '1px solid var(--border, #2b2b33)' }}>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: '#2a2a33', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                    {s.scope === 'player' ? s.player : 'Team'}
                  </span>
                  <span style={{ fontSize: 13 }}>{s.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
