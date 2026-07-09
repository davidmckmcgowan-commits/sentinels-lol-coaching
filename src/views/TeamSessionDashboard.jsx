import { useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell, LabelList,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import {
  SESSION_TYPES, READINESS_SESSION_TYPES, OPPONENT_TIERS, SLEEP_BUCKETS, bucketize, formatDate,
} from '../lib/constants.js'

function TierChip({ tier }) {
  if (tier === null || tier === undefined) return <span>—</span>
  return <span className={`tier-chip tier-${tier}`}>{tier}</span>
}

function ResultBadge({ result }) {
  if (!result) return <span>—</span>
  const cls = result === 'Win' ? 'badge-win' : 'badge-loss'
  return <span className={`badge ${cls}`}>{result}</span>
}

function SessionTypeBadge({ type }) {
  if (!type) return <span>—</span>
  return <span className={`badge badge-session-${type}`}>{type}</span>
}

export default function TeamSessionDashboard() {
  const [tierFilter, setTierFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [readinessMode, setReadinessMode] = useState('all') // 'all' | 'readiness'

  const { data, error, loading } = useSupabaseQuery(
    () => supabase.from('sessions').select('*').order('session_date', { ascending: false }),
    []
  )

  const filtered = useMemo(() => {
    if (!data) return []
    return data.filter((s) => {
      if (tierFilter !== 'all' && String(s.opponent_tier) !== String(tierFilter)) return false
      if (typeFilter !== 'all' && s.session_type !== typeFilter) return false
      if (dateFrom && s.session_date < dateFrom) return false
      if (dateTo && s.session_date > dateTo) return false
      if (readinessMode === 'readiness' && !READINESS_SESSION_TYPES.includes(s.session_type)) return false
      return true
    })
  }, [data, tierFilter, typeFilter, dateFrom, dateTo, readinessMode])

  const sleepBucketChart = useMemo(() => {
    const buckets = {}
    for (const b of SLEEP_BUCKETS) buckets[b.label] = { label: b.label, wins: 0, total: 0 }
    for (const s of filtered) {
      const label = bucketize(s.team_avg_sleep_hours, SLEEP_BUCKETS)
      if (!label) continue
      buckets[label].total += 1
      if (s.result === 'Win' || s.win_value > 0) buckets[label].wins += 1
    }
    return SLEEP_BUCKETS.map((b) => {
      const entry = buckets[b.label]
      const winRate = entry.total > 0 ? Math.round((entry.wins / entry.total) * 1000) / 10 : 0
      return { ...entry, winRate }
    })
  }, [filtered])

  const barColor = (label) => {
    if (label === '<6.5h') return '#e0524a'
    if (label === '6.5-7h') return '#e0a940'
    if (label === '7-7.5h') return '#cbb23a'
    return '#3aa76d'
  }

  return (
    <div>
      <div className="panel">
        <h2>Session Filters</h2>
        <p className="panel-caption">
          Filter by opponent tier, session type, and date range. Use the readiness toggle below to
          restrict conclusions to Red/Official sessions only.
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
          <div className="filter-field">
            <label>From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          </div>
          <div className="filter-field">
            <label>To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
          </div>
          <div className="filter-field">
            <label>Readiness Mode</label>
            <div className="toggle-group">
              <button
                type="button"
                className={readinessMode === 'all' ? 'active' : ''}
                onClick={() => setReadinessMode('all')}
              >
                All sessions
              </button>
              <button
                type="button"
                className={readinessMode === 'readiness' ? 'active' : ''}
                onClick={() => setReadinessMode('readiness')}
              >
                Red + Official only (readiness)
              </button>
            </div>
          </div>
        </div>
        <p className="section-note">
          Session hierarchy: Green (experimentation, lowest signal) &lt; Orange &lt; Red (full intensity) &lt; Official
          (ground truth). Patterns are valid across all session types, but readiness conclusions should only be
          drawn from Red and Official sessions — never lead a readiness call with a Green result.
        </p>
      </div>

      <div className="panel">
        <h2>Win Rate by Sleep Tier</h2>
        <p className="panel-caption">
          Team average sleep hours bucketed against win rate, using the current filters
          ({filtered.length} session{filtered.length === 1 ? '' : 's'} in view).
        </p>
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={sleepBucketChart} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="label" stroke="#9aa1ae" fontSize={12} />
              <YAxis stroke="#9aa1ae" fontSize={12} unit="%" domain={[0, 100]} />
              <Tooltip
                contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                formatter={(value, name, props) => [`${value}% (${props.payload.wins}/${props.payload.total})`, 'Win rate']}
              />
              <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
                {sleepBucketChart.map((entry, idx) => (
                  <Cell key={idx} fill={barColor(entry.label)} />
                ))}
                <LabelList dataKey="winRate" position="top" formatter={(v) => `${v}%`} fill="#e6e8ec" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="panel">
        <h2>Sessions</h2>
        {loading && <div className="loading-state">Loading sessions…</div>}
        {error && <div className="toast error">Error loading sessions: {error.message}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="empty-state">No sessions match the current filters.</div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Type</th>
                  <th>Opponent</th>
                  <th>Tier</th>
                  <th>Result</th>
                  <th>Avg Sleep (h)</th>
                  <th>Goal 1</th>
                  <th>Goal 2</th>
                  <th>Goal 3</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td>{formatDate(s.session_date)}</td>
                    <td><SessionTypeBadge type={s.session_type} /></td>
                    <td>{s.opponent}</td>
                    <td><TierChip tier={s.opponent_tier} /></td>
                    <td><ResultBadge result={s.result} /></td>
                    <td>{s.team_avg_sleep_hours != null ? s.team_avg_sleep_hours.toFixed(2) : '—'}</td>
                    <td>
                      {s.goal1_score != null ? s.goal1_score.toFixed(1) : '—'}
                      {s.goal1_name ? <span className="section-note"> {s.goal1_name}</span> : null}
                    </td>
                    <td>
                      {s.goal2_score != null ? s.goal2_score.toFixed(1) : '—'}
                      {s.goal2_name ? <span className="section-note"> {s.goal2_name}</span> : null}
                    </td>
                    <td>
                      {s.goal3_score != null ? s.goal3_score.toFixed(1) : '—'}
                      {s.goal3_name ? <span className="section-note"> {s.goal3_name}</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
