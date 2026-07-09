import { useMemo, useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  BarChart, Bar, Cell, LabelList,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import { ROSTER_PLAYERS, ALL_HABIT_KEYS, BREATHING_KEYS, formatDate } from '../lib/constants.js'

function vibeClass(vibe) {
  if (vibe == null) return ''
  if (vibe <= 3) return 'critical'
  if (vibe <= 5) return 'amber'
  return 'ok'
}

export default function PlayerWellbeing() {
  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])

  const { data: entries, error, loading } = useSupabaseQuery(
    () => supabase.from('daily_entries').select('*').order('entry_date', { ascending: true }),
    []
  )

  const { data: lates, error: latesError, loading: latesLoading } = useSupabaseQuery(
    () => supabase.from('lates').select('*').order('lates_count', { ascending: false }),
    []
  )

  const playerEntries = useMemo(() => {
    if (!entries) return []
    return entries.filter((e) => e.player === player)
  }, [entries, player])

  const vibeTrend = useMemo(() => {
    return playerEntries
      .filter((e) => e.vibe_check != null)
      .map((e) => ({ date: e.entry_date, vibe: e.vibe_check, label: formatDate(e.entry_date) }))
  }, [playerEntries])

  const habitStats = useMemo(() => {
    if (playerEntries.length === 0) {
      return { overallRate: null, sleepRate: null, breathingRate: null, n: 0 }
    }
    let totalTrue = 0
    let totalPossible = 0
    let sleepTrue = 0
    let breathingTrue = 0
    let breathingPossible = 0
    for (const e of playerEntries) {
      for (const key of ALL_HABIT_KEYS) {
        if (e[key] === true) totalTrue += 1
        if (e[key] === true || e[key] === false) totalPossible += 1
      }
      if (e.sleep_7_30 === true) sleepTrue += 1
      for (const key of BREATHING_KEYS) {
        if (e[key] === true) breathingTrue += 1
        if (e[key] === true || e[key] === false) breathingPossible += 1
      }
    }
    return {
      overallRate: totalPossible > 0 ? Math.round((totalTrue / totalPossible) * 1000) / 10 : null,
      sleepRate: Math.round((sleepTrue / playerEntries.length) * 1000) / 10,
      breathingRate: breathingPossible > 0 ? Math.round((breathingTrue / breathingPossible) * 1000) / 10 : null,
      n: playerEntries.length,
    }
  }, [playerEntries])

  const vibeFlags = useMemo(() => {
    const amber = playerEntries.filter((e) => e.vibe_check != null && e.vibe_check <= 5 && e.vibe_check > 3).length
    const critical = playerEntries.filter((e) => e.vibe_check != null && e.vibe_check <= 3).length
    return { amber, critical }
  }, [playerEntries])

  const reflectionFeed = useMemo(() => {
    return [...playerEntries]
      .filter((e) => e.reflection_well || e.reflection_improve)
      .sort((a, b) => (a.entry_date < b.entry_date ? 1 : -1))
  }, [playerEntries])

  const latesChart = useMemo(() => {
    if (!lates) return []
    return [...lates]
      .map((l) => ({ ...l, displayName: l.person }))
      .sort((a, b) => b.lates_count - a.lates_count)
  }, [lates])

  return (
    <div>
      <div className="panel">
        <h2>Player Wellbeing Dashboard</h2>
        <p className="panel-caption">
          Vibe trend, habit completion, and reflection feed per roster player. Vibe ≤ 5 is flagged amber;
          vibe ≤ 3 is a critical flag requiring attention.
        </p>
        <div className="player-tabs">
          {ROSTER_PLAYERS.map((p) => (
            <button
              key={p}
              type="button"
              className={`player-tab ${player === p ? 'active' : ''}`}
              onClick={() => setPlayer(p)}
            >
              {p}
            </button>
          ))}
        </div>

        {loading && <div className="loading-state">Loading daily entries…</div>}
        {error && <div className="toast error">Error loading daily entries: {error.message}</div>}

        {!loading && !error && (
          <>
            {vibeFlags.critical > 0 && (
              <div className="flag-banner critical">
                CRITICAL: {vibeFlags.critical} vibe-check entr{vibeFlags.critical === 1 ? 'y' : 'ies'} at ≤ 3 for {player}.
                {player === 'DARKWINGS' && ' Known pattern: dips correlate with losing matchups and uncertainty about game plan — cross-reference 3-night sleep average before attributing to mentality.'}
              </div>
            )}
            {vibeFlags.critical === 0 && vibeFlags.amber > 0 && (
              <div className="flag-banner amber">
                {vibeFlags.amber} vibe-check entr{vibeFlags.amber === 1 ? 'y' : 'ies'} at ≤ 5 for {player}. Monitor.
              </div>
            )}
            {vibeFlags.critical === 0 && vibeFlags.amber === 0 && playerEntries.length > 0 && (
              <div className="flag-banner ok">No low-vibe flags for {player} in the logged data.</div>
            )}

            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-label">Entries logged</div>
                <div className="stat-value">{habitStats.n}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Overall habit completion</div>
                <div className="stat-value">{habitStats.overallRate != null ? `${habitStats.overallRate}%` : '—'}</div>
                <div className="stat-sub">Across all ~24 tracked habits</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Sleep 7:30+ rate</div>
                <div className="stat-value">{habitStats.sleepRate != null ? `${habitStats.sleepRate}%` : '—'}</div>
              </div>
              <div className={`stat-card ${habitStats.breathingRate != null && habitStats.breathingRate < 20 ? 'flag-critical' : ''}`}>
                <div className="stat-label">Breathing protocol compliance</div>
                <div className="stat-value">{habitStats.breathingRate != null ? `${habitStats.breathingRate}%` : '—'}</div>
                <div className="stat-sub">Pre/post-training + in-game breathing — known coaching gap</div>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="two-col">
        <div className="panel">
          <h2>Vibe Check Trend — {player}</h2>
          <p className="panel-caption">Self-reported vibe (1–10) over time, ordered by entry date.</p>
          {!loading && !error && vibeTrend.length === 0 && (
            <div className="empty-state">No vibe-check entries logged for {player}.</div>
          )}
          {!loading && !error && vibeTrend.length > 0 && (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={vibeTrend} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                  <XAxis dataKey="label" stroke="#9aa1ae" fontSize={11} minTickGap={20} />
                  <YAxis stroke="#9aa1ae" fontSize={12} domain={[0, 10]} />
                  <ReferenceLine y={5} stroke="#e0a940" strokeDasharray="4 4" label={{ value: 'Flag ≤5', fill: '#e0a940', fontSize: 10, position: 'insideTopRight' }} />
                  <ReferenceLine y={3} stroke="#e0524a" strokeDasharray="4 4" label={{ value: 'Critical ≤3', fill: '#e0524a', fontSize: 10, position: 'insideBottomRight' }} />
                  <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }} />
                  <Line type="monotone" dataKey="vibe" stroke="#d4a017" strokeWidth={2} dot={{ r: 2 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="panel">
          <h2>Lateness Log — All Personnel</h2>
          <p className="panel-caption">Impact's lates should visually stand out against the rest of the roster/staff.</p>
          {latesLoading && <div className="loading-state">Loading lates…</div>}
          {latesError && <div className="toast error">Error loading lates: {latesError.message}</div>}
          {!latesLoading && !latesError && (
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={latesChart} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                  <XAxis dataKey="displayName" stroke="#9aa1ae" fontSize={11} />
                  <YAxis stroke="#9aa1ae" fontSize={12} allowDecimals={false} />
                  <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }} />
                  <Bar dataKey="lates_count" radius={[4, 4, 0, 0]}>
                    {latesChart.map((entry, idx) => (
                      <Cell key={idx} fill={entry.lates_count >= 10 ? '#e0524a' : '#3a4a5c'} />
                    ))}
                    <LabelList dataKey="lates_count" position="top" fill="#e6e8ec" fontSize={11} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div className="panel">
        <h2>Reflection Feed — {player}</h2>
        <p className="panel-caption">
          "Something done well" / "something to improve" entries, most recent first. Doubles as
          opponent-specific coaching intel via the team_played field.
        </p>
        {!loading && !error && reflectionFeed.length === 0 && (
          <div className="empty-state">No reflections logged for {player}.</div>
        )}
        {!loading && !error && reflectionFeed.length > 0 && (
          <div className="reflection-feed">
            {reflectionFeed.map((e) => {
              const vc = vibeClass(e.vibe_check)
              return (
                <div key={e.id} className={`reflection-card ${vc === 'amber' ? 'vibe-amber' : vc === 'critical' ? 'vibe-critical' : ''}`}>
                  <div className="rc-head">
                    <span>{formatDate(e.entry_date)} {e.team_played ? `· vs ${e.team_played}` : ''}</span>
                    {e.vibe_check != null && (
                      <span className={`rc-vibe ${vc === 'critical' ? 'vibe-critical-chip' : vc === 'amber' ? 'vibe-amber-chip' : 'vibe-ok-chip'}`}>
                        Vibe {e.vibe_check}
                      </span>
                    )}
                  </div>
                  {e.reflection_well && <div className="rc-line"><b>Went well:</b> {e.reflection_well}</div>}
                  {e.reflection_improve && <div className="rc-line"><b>To improve:</b> {e.reflection_improve}</div>}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
