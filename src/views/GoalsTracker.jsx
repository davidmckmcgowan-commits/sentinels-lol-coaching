import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'
import { MIN_REAL_GAME_S, prognosticPct, fmtPct, todayISO, TRACK_START } from '../lib/prognostic.js'
import DmGraph from '../components/DmGraph.jsx'

// Team Goals runs on the constant PROGNOSTIC line: our performance as a % of
// our own historical par vs the selected team. The trend (our scrim level) is
// the same whoever you pick — only the par (the denominator) moves, so the
// whole % line re-scales. 100% = at par; over 100% = improvement by definition.
const WIN_START = TRACK_START // continuous tracked window; baseline is everything before this

const avg = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const rate = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : null }

function metricValue(key, games, prows) {
  switch (key) {
    case 'team_gold_diff_15': return avg(games, (g) => g.gold_diff_15)
    case 'team_cs_diff_15': return avg(games, (g) => g.cs_diff_15)
    case 'first_tower_rate': return rate(games, (g) => g.first_tower_sentinels)
    case 'first_dragon_rate':
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
const LBL = { fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em' }

function GoalCard({ goal, lib, series, games, prows, team }) {
  const meta = lib[goal.metric_key] || {}
  const unit = meta.unit
  const higher = meta.higher_is_better !== false
  const isLaners = (goal.metric_key || '').startsWith('laners_')
  const playersFor = (ids) => isLaners
    ? prows.filter((p) => p.player !== 'Huhi' && ids.has(p.game_id))
    : goal.scope === 'player' ? prows.filter((p) => p.player === goal.player && ids.has(p.game_id)) : []
  const today = todayISO()

  const model = useMemo(() => {
    const completed = games.map((g) => {
      const s = series[g.grid_series_id]
      if (!s || g.excluded || !g.riot_enriched || g.game_duration_s < MIN_REAL_GAME_S) return null
      return { g, date: s.series_date, opp: canonicalOpponentName(s.opponent_name || '') }
    }).filter(Boolean)

    // Frozen pre-July baseline PER OPPONENT (the 100% line). Every game is always
    // scored against the baseline of the team THAT game was played against — even
    // in All-teams — because prognostic % normalises per opponent (100% = at par).
    const preJuly = completed.filter((c) => c.date < WIN_START)
    const parCache = {}
    const parFor = (opp) => {
      if (!(opp in parCache)) {
        const gs = preJuly.filter((c) => c.opp === opp)
        parCache[opp] = gs.length ? { par: metricValue(goal.metric_key, gs.map((c) => c.g), playersFor(new Set(gs.map((c) => c.g.id)))), n: gs.length } : { par: null, n: 0 }
      }
      return parCache[opp]
    }
    const selPar = team === 'ALL' ? null : parFor(team)

    // Games since the start of July — the selected team, or every team for All.
    const tracked = completed.filter((c) => (team === 'ALL' || c.opp === team) && c.date >= WIN_START && c.date <= today)
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date)
        : a.g.grid_series_id !== b.g.grid_series_id ? String(a.g.grid_series_id).localeCompare(String(b.g.grid_series_id))
          : (a.g.game_number ?? 0) - (b.g.game_number ?? 0))
      .map((c) => {
        const p = team === 'ALL' ? parFor(c.opp).par : selPar.par
        const val = metricValue(goal.metric_key, [c.g], playersFor(new Set([c.g.id])))
        return { ...c, raw: val, pct: prognosticPct(val, p, higher) }
      })
      .filter((c) => c.pct != null)

    const byDay = {}
    for (const c of tracked) (byDay[c.date] ??= []).push(c)
    const dpct = (p) => `${fmtPct(p)} (${p >= 100 ? '+' : ''}${Math.round(p - 100)}% vs 100)`
    const dayData = Object.keys(byDay).sort().map((date) => {
      const arr = byDay[date]
      const raw = arr.reduce((a, b) => a + b.raw, 0) / arr.length
      const pct = arr.reduce((a, b) => a + b.pct, 0) / arr.length
      return { date, raw, pct, tip: `${date.slice(5)} · day avg ${dpct(pct)}${team !== 'ALL' ? ` · ${fmt(raw, unit)}` : ''}` }
    })
    const gameData = tracked.map((c) => {
      const dg = byDay[c.date]
      return { date: c.date, idxInDay: dg.indexOf(c), dayCount: dg.length, pct: c.pct, tip: `${team === 'ALL' ? c.opp + ' · ' : ''}${c.date.slice(5)} · ${dpct(c.pct)} · ${fmt(c.raw, unit)}` }
    })

    const latest = dayData.length ? dayData[dayData.length - 1] : null
    return { selPar, dayData, gameData, latest, hasData: dayData.length > 0 }
  }, [games, series, prows, goal, team, higher, today])

  const { selPar, dayData, gameData, latest, hasData } = model
  const latestPct = latest?.pct
  const teamLabel = team === 'ALL' ? 'all teams' : team
  const noBaseline = team !== 'ALL' && (!selPar || selPar.par == null)
  const parLabel = team === 'ALL' ? 'each game vs its own team' : (selPar && selPar.par != null ? `${fmt(selPar.par, unit)} vs ${team}` : null)
  const baselineTip = team === 'ALL'
    ? "100% line = each game measured against its own team's completed games before July"
    : (selPar && selPar.par != null ? `100% line = ${fmt(selPar.par, unit)} vs ${team} — every completed game before July (${selPar.n} games)` : null)

  const verdict = latestPct == null ? { c: '#8a91a0', t: 'Waiting on July games to read against the 100% line.' }
    : latestPct >= 100
      ? { c: '#3fb950', t: team === 'ALL' ? `Above the 100% line — ${fmtPct(latestPct)} across all teams since July.` : `Above our ${team} 100% line — ${fmtPct(latestPct)} (${fmt(latest.raw, unit)} vs a ${fmt(selPar.par, unit)} baseline).` }
      : { c: '#e5534b', t: team === 'ALL' ? `Below the 100% line — ${fmtPct(latestPct)} across all teams since July.` : `Below our ${team} 100% line — ${fmtPct(latestPct)} (${fmt(latest.raw, unit)} vs a ${fmt(selPar.par, unit)} baseline).` }

  return (
    <div style={{ border: '1px solid var(--border, #2b2b33)', borderRadius: 10, padding: 14, background: 'var(--panel-2, #17171d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>{meta.label || goal.metric_key}</div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '3px 0 2px' }}>{goal.intent}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>Measures: {meta.description || meta.label || goal.metric_key}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={LBL}>Now vs {teamLabel}</div>
          <div style={{ fontSize: 28, fontWeight: 800, lineHeight: 1.1, color: verdict.c }}>{fmtPct(latestPct)}</div>
          {team !== 'ALL' && selPar && selPar.par != null && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>100% = {fmt(selPar.par, unit)} · {selPar.n} games</div>}
          {team === 'ALL' && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>each game vs its own team&apos;s baseline</div>}
        </div>
      </div>

      <div style={{ margin: '10px 0', padding: '7px 12px', borderRadius: 8, background: 'var(--panel, #10131a)', borderLeft: `3px solid ${verdict.c}`, fontSize: 13 }}>
        {verdict.t}
      </div>

      {noBaseline
        ? <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No pre-July games vs {teamLabel} to set the 100% line yet.</div>
        : !hasData
          ? <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No games since July 1 vs {teamLabel} yet.</div>
          : <DmGraph start={WIN_START} end={today} today={today} dayData={dayData} gameData={gameData} showProjection={false} parLabel={parLabel} baselineTip={baselineTip} />}
    </div>
  )
}

export default function GoalsTracker() {
  const { data: goals, loading: goalsLoading } = useSupabaseQuery(
    () => supabase.from('prep_goals').select('*').eq('active', true), []
  )
  const { data: library } = useSupabaseQuery(() => supabase.from('goal_library').select('*'), [])
  const { data: seriesRows } = useSupabaseQuery(
    () => supabase.from('grid_series').select('grid_series_id, series_date, series_type, opponent_name').gte('series_date', '2026-01-01'), []
  )
  const { data: gameRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, game_number, riot_enriched, game_duration_s, excluded, gold_diff_15, cs_diff_15, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_grubs, positive_plays, give_backs, snowballs'
    )), []
  )
  const { data: playerRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select(
      'game_id, player, cs_diff_15, gold_diff_15, cs_per_min, kill_participation, champ_damage_share, champ_damage_per_min, vision_score'
    ).eq('is_sentinels', true)), []
  )

  const lib = useMemo(() => Object.fromEntries((library || []).map((l) => [l.metric_key, l])), [library])
  const seriesById = useMemo(() => Object.fromEntries((seriesRows || []).map((s) => [s.grid_series_id, s])), [seriesRows])
  const winPlayerRows = useMemo(() => (playerRows || []), [playerRows])
  const winGames = useMemo(() => (gameRows || []).filter((g) => seriesById[g.grid_series_id]), [gameRows, seriesById])

  // team options: canonical opponents we have completed games against
  const teamOptions = useMemo(() => {
    const c = new Map()
    for (const g of winGames) {
      const s = seriesById[g.grid_series_id]
      if (!s || !g.riot_enriched || g.game_duration_s < MIN_REAL_GAME_S) continue
      const name = canonicalOpponentName(s.opponent_name || '')
      if (!name) continue
      c.set(name, (c.get(name) || 0) + 1)
    }
    return [...c.entries()].map(([name, n]) => ({ name, n })).filter((o) => o.n >= 3).sort((a, b) => b.n - a.n)
  }, [winGames, seriesById])

  const [team, setTeam] = useState('ALL')

  const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi']
  const teamGoals = (goals || []).filter((g) => g.scope === 'team')
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ marginBottom: 0 }}>Team Goals</h2>
        <div>
          <div style={{ ...LBL, marginBottom: 4 }}>Measure against</div>
          <select value={team} onChange={(e) => setTeam(e.target.value)} className="search-input" style={{ minWidth: 220, fontSize: 14, padding: '8px 10px' }}>
            <option value="ALL">All teams (overall average)</option>
            {teamOptions.map((o) => <option key={o.name} value={o.name}>{o.name} ({o.n} games)</option>)}
          </select>
        </div>
      </div>
      <p className="panel-caption">
        Long-run development on the <b style={{ color: 'var(--text)' }}>prognostic</b> scale: our performance as a <b>% of our own historical baseline</b> against the team you pick{cycleOpp ? <> (next official: <b style={{ color: 'var(--text)' }}>{cycleOpp}</b>{cycleDate ? ` ${cycleDate}` : ''})</> : ''}.
        The bold <b style={{ color: '#c9a227' }}>100% line</b> is that baseline — every completed game against them <b>before July</b>, frozen. Anything <b style={{ color: '#3fb950' }}>over 100%</b> is improvement by definition — even if it&apos;s below our all-team average, we&apos;re now better than we&apos;ve historically been against that specific team. Pick a low-history opponent (say Cloud9) and the bar drops; a strong matchup (Dignitas) and it rises. The <b style={{ color: '#4c8bf5' }}>trend</b> and dots are only our games against that team, from July 1 onward — no pre-July history is plotted.
      </p>

      {loading && <div className="loading-state">Loading goals…</div>}

      {!loading && teamGoals.length === 0 && (
        <div className="empty-state">No active team goals set. Send me the goals for this week and I&apos;ll load them.</div>
      )}

      {!loading && teamGoals.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
          {teamGoals.map((g) => (
            <GoalCard key={g.id} goal={g} lib={lib} series={seriesById} games={winGames} prows={winPlayerRows} team={team} />
          ))}
        </div>
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
