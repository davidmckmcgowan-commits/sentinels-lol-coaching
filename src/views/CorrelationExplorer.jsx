import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import {
  SESSION_TYPES, OPPONENT_TIERS, SLEEP_BUCKETS, VIBE_BUCKETS, GOAL_SCORE_BUCKETS, bucketize, average,
} from '../lib/constants.js'

function BucketBarChart({ title, caption, data, colorFn }) {
  return (
    <div className="panel">
      <h2>{title}</h2>
      <p className="panel-caption">{caption}</p>
      {data.every((d) => d.total === 0) ? (
        <div className="empty-state">No data for the current filters.</div>
      ) : (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="label" stroke="#9aa1ae" fontSize={12} />
              <YAxis stroke="#9aa1ae" fontSize={12} unit="%" domain={[0, 100]} />
              <Tooltip
                contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                formatter={(value, name, props) => [`${value}% (n=${props.payload.total})`, 'Win rate']}
              />
              <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                {data.map((entry, idx) => (
                  <Cell key={idx} fill={colorFn(entry.label)} />
                ))}
                <LabelList dataKey="winRate" position="top" formatter={(v) => `${v}%`} fill="#e6e8ec" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}

export default function CorrelationExplorer() {
  const [tierFilter, setTierFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const { data: sessions, error: sessError, loading: sessLoading } = useSupabaseQuery(
    () => supabase.from('sessions').select('*'),
    []
  )

  const { data: dailyEntries, error: dailyError, loading: dailyLoading } = useSupabaseQuery(
    () => supabase.from('daily_entries').select('entry_date, vibe_check'),
    []
  )

  const filteredSessions = useMemo(() => {
    if (!sessions) return []
    return sessions.filter((s) => {
      if (tierFilter !== 'all' && String(s.opponent_tier) !== String(tierFilter)) return false
      if (typeFilter !== 'all' && s.session_type !== typeFilter) return false
      return true
    })
  }, [sessions, tierFilter, typeFilter])

  const isWin = (s) => s.result === 'Win' || s.win_value > 0

  // Sleep bucket vs win rate
  const sleepChart = useMemo(() => {
    const buckets = {}
    for (const b of SLEEP_BUCKETS) buckets[b.label] = { label: b.label, wins: 0, total: 0 }
    for (const s of filteredSessions) {
      const label = bucketize(s.team_avg_sleep_hours, SLEEP_BUCKETS)
      if (!label) continue
      buckets[label].total += 1
      if (isWin(s)) buckets[label].wins += 1
    }
    return SLEEP_BUCKETS.map((b) => {
      const e = buckets[b.label]
      return { ...e, winRate: e.total > 0 ? Math.round((e.wins / e.total) * 1000) / 10 : 0 }
    })
  }, [filteredSessions])

  // Goal score bucket vs win rate
  const goalChart = useMemo(() => {
    const buckets = {}
    for (const b of GOAL_SCORE_BUCKETS) buckets[b.label] = { label: b.label, wins: 0, total: 0 }
    for (const s of filteredSessions) {
      const avgGoal = s.avg_of_goals != null
        ? s.avg_of_goals
        : average([s.goal1_score, s.goal2_score, s.goal3_score])
      const label = bucketize(avgGoal, GOAL_SCORE_BUCKETS)
      if (!label) continue
      buckets[label].total += 1
      if (isWin(s)) buckets[label].wins += 1
    }
    return GOAL_SCORE_BUCKETS.map((b) => {
      const e = buckets[b.label]
      return { ...e, winRate: e.total > 0 ? Math.round((e.wins / e.total) * 1000) / 10 : 0 }
    })
  }, [filteredSessions])

  // Vibe bucket vs win rate: average vibe per day (across all players' daily_entries),
  // and average win rate per day (across all sessions that day), then bucket by avg vibe.
  const vibeChart = useMemo(() => {
    if (!dailyEntries || filteredSessions.length === 0) {
      return VIBE_BUCKETS.map((b) => ({ label: b.label, wins: 0, total: 0, winRate: 0 }))
    }

    // Average vibe per entry_date across players
    const vibeByDate = new Map()
    for (const e of dailyEntries) {
      if (e.vibe_check == null || !e.entry_date) continue
      if (!vibeByDate.has(e.entry_date)) vibeByDate.set(e.entry_date, [])
      vibeByDate.get(e.entry_date).push(e.vibe_check)
    }

    // Average win rate per session_date across filtered sessions
    const sessionsByDate = new Map()
    for (const s of filteredSessions) {
      if (!s.session_date) continue
      if (!sessionsByDate.has(s.session_date)) sessionsByDate.set(s.session_date, [])
      sessionsByDate.get(s.session_date).push(s)
    }

    const buckets = {}
    for (const b of VIBE_BUCKETS) buckets[b.label] = { label: b.label, winRateSum: 0, dayCount: 0, total: 0, wins: 0 }

    for (const [date, sessList] of sessionsByDate.entries()) {
      const vibes = vibeByDate.get(date)
      if (!vibes || vibes.length === 0) continue
      const avgVibe = average(vibes)
      const label = bucketize(avgVibe, VIBE_BUCKETS)
      if (!label) continue
      const dayWins = sessList.filter(isWin).length
      buckets[label].total += sessList.length
      buckets[label].wins += dayWins
    }

    return VIBE_BUCKETS.map((b) => {
      const e = buckets[b.label]
      return {
        label: b.label,
        total: e.total,
        wins: e.wins,
        winRate: e.total > 0 ? Math.round((e.wins / e.total) * 1000) / 10 : 0,
      }
    })
  }, [dailyEntries, filteredSessions])

  const sleepColor = (label) => {
    if (label === '<6.5h') return '#e0524a'
    if (label === '6.5-7h') return '#e0a940'
    if (label === '7-7.5h') return '#cbb23a'
    return '#3aa76d'
  }
  const vibeColor = (label) => {
    if (label === '1-3') return '#e0524a'
    if (label === '4-5') return '#e0a940'
    if (label === '6-7') return '#cbb23a'
    return '#3aa76d'
  }
  const goalColor = (label) => {
    if (label === '0-3') return '#e0524a'
    if (label === '3-5') return '#e0a940'
    if (label === '5-7') return '#cbb23a'
    return '#3aa76d'
  }

  const loading = sessLoading || dailyLoading
  const error = sessError || dailyError

  return (
    <div>
      <div className="panel">
        <h2>Correlation Explorer</h2>
        <p className="panel-caption">
          Bucketed win-rate comparisons across sleep, vibe, and goal-score signals. Filter by opponent
          tier and session type to isolate specific contexts (e.g. readiness benchmarks vs Rank 4–5 opponents).
        </p>
        <div className="filter-row">
          <div className="filter-field">
            <label>Opponent Tier</label>
            <select value={tierFilter} onChange={(e) => setTierFilter(e.target.value)}>
              <option value="all">All tiers</option>
              {OPPONENT_TIERS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label>Session Type</label>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
              <option value="all">All types</option>
              {SESSION_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        </div>
        {loading && <div className="loading-state">Loading correlation data…</div>}
        {error && <div className="toast error">Error loading data: {error.message}</div>}
      </div>

      {!loading && !error && (
        <>
          <BucketBarChart
            title="Sleep vs Win Rate"
            caption="Team average sleep hours (bucketed) vs win rate, current filters applied."
            data={sleepChart}
            colorFn={sleepColor}
          />
          <BucketBarChart
            title="Vibe Check vs Win Rate"
            caption="Average daily vibe (across all players, bucketed) vs win rate on matching session dates."
            data={vibeChart}
            colorFn={vibeColor}
          />
          <BucketBarChart
            title="Goal Score vs Win Rate"
            caption="Average of the 3 coaching goal scores (bucketed 0-10) vs win rate."
            data={goalChart}
            colorFn={goalColor}
          />
        </>
      )}
    </div>
  )
}
