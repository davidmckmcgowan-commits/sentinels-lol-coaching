import { useMemo, useState } from 'react'
import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Line, ReferenceLine, ReferenceArea, Legend,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import {
  ROSTER_PLAYERS, SLEEP_DEBT_BANDS, sleepDebtColor, formatDate, bucketize,
  opponentTier, average, SEASON_CUTOFF_DATE, canonicalOpponentName,
} from '../lib/constants.js'
import { groupByPlayer } from '../lib/sleepDebt.js'
import {
  buildSessionTypeByDate, buildPlayerPerformanceSeries, averageByGroup,
  flagOverextensionCandidates,
} from '../lib/individualPerformance.js'
import {
  buildOpponentNetWorthByGameRole, attachNetWorthDiff, computePerformanceIndex,
  computeEnduranceByGameNumber, computeEnduranceByDaySequence, attachDaySequence, computeTiltRecovery,
} from '../lib/performanceIndex.js'
import {
  computePotential, attachInterference, computeTdcsPatternFlags,
} from '../lib/interference.js'
import {
  attachPriorGameGood, computeConditionCards,
} from '../lib/patternMining.js'

const TAG_OPTIONS = [
  { value: 'skill_gap', label: 'Skill / Knowledge Gap' },
  { value: 'motivation', label: 'Motivation' },
  { value: 'conflict', label: 'Conflict' },
  { value: 'other', label: 'Other' },
]

const SESSION_TYPE_ORDER = ['Green', 'Orange', 'Red', 'Official']
const TIER_ORDER = ['Tier 5', 'Tier 4', 'Tier 3', 'Tier 2', 'Tier 1', 'Unranked']

// GRID's native field calls stage matches "ESPORTS" — display it as "Official"
// everywhere in the UI instead, since that's what it actually is to the coaching
// staff. The underlying data field/join logic still uses GRID's 'ESPORTS' value.
function seriesTypeDisplay(seriesType) {
  return seriesType === 'ESPORTS' ? 'Official' : seriesType
}

// ---- Performance Index trend over time, dot colored by 3-night sleep band -

function PerformanceTrendChart({ rows }) {
  const chartData = rows
    .filter((r) => r.performanceIndex != null)
    .map((r, idx) => ({
      idx,
      label: formatDate(r.date),
      date: r.date,
      performanceIndex: r.performanceIndex,
      champion: r.champion,
      rollingAvgSleep: r.rollingAvgSleep,
      sameNightSleepHours: r.sameNightSleepHours,
      opponentName: r.opponentName,
      seriesType: r.seriesType,
      sessionTypeLabel: r.sessionTypeLabel,
      baselineSource: r.baselineSource,
    }))

  if (chartData.length === 0) {
    return <div className="empty-state">No scored games for this player yet.</div>
  }

  return (
    <div className="chart-wrap" style={{ height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="label" stroke="#9aa1ae" fontSize={10} minTickGap={30} />
          <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Performance Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" label={{ value: 'own average', position: 'insideTopRight', fill: '#676f7d', fontSize: 10 }} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => {
              if (name === 'performanceIndex') {
                const d = props.payload
                const sleepBit = d.rollingAvgSleep != null ? `3-night sleep avg: ${d.rollingAvgSleep}h` : 'no 3-night sleep avg available'
                const sameNight = d.sameNightSleepHours != null ? ` (same-night: ${d.sameNightSleepHours}h)` : ''
                const display = seriesTypeDisplay(d.seriesType)
                const typeBit = d.seriesType === 'ESPORTS'
                  ? 'Official'
                  : d.sessionTypeLabel
                    ? `${display} / ${d.sessionTypeLabel}`
                    : `${display} (unmatched to Green/Orange/Red/Official)`
                const baselineBit = d.baselineSource === 'role' ? ' — role-level baseline (low champion sample)' : ''
                return [`${value} on ${d.champion} vs ${d.opponentName} — ${typeBit} — ${sleepBit}${sameNight}${baselineBit}`, 'Performance Index']
              }
              return [value, name]
            }}
          />
          <Line
            type="monotone"
            dataKey="performanceIndex"
            stroke="#d4a017"
            strokeWidth={1.5}
            dot={(props) => {
              const { cx, cy, payload } = props
              const color = sleepDebtColor(payload.rollingAvgSleep)
              return <circle key={`dot-${payload.idx}`} cx={cx} cy={cy} r={3} fill={color} stroke={color} />
            }}
            isAnimationActive={false}
            name="performanceIndex"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Avg Performance Index by sleep-debt band ------------------------------

function IndexBySleepBandChart({ rows, mode }) {
  const data = useMemo(() => {
    const valueFn = mode === 'rolling' ? (r) => r.rollingAvgSleep : (r) => r.sameNightSleepHours
    const buckets = {}
    for (const b of SLEEP_DEBT_BANDS) buckets[b.label] = { label: b.label, color: b.color, sum: 0, n: 0 }
    for (const r of rows) {
      if (r.performanceIndex == null) continue
      const sleepValue = valueFn(r)
      if (sleepValue == null) continue
      const label = bucketize(sleepValue, SLEEP_DEBT_BANDS)
      if (!label) continue
      buckets[label].sum += r.performanceIndex
      buckets[label].n += 1
    }
    return SLEEP_DEBT_BANDS.map((b) => {
      const e = buckets[b.label]
      return { ...e, avg: e.n > 0 ? Math.round((e.sum / e.n) * 10) / 10 : 0 }
    })
  }, [rows, mode])

  const anyData = data.some((d) => d.n > 0)

  return (
    <div className="chart-wrap">
      {!anyData ? (
        <div className="empty-state">No games could be matched to a {mode === 'rolling' ? '3-night rolling' : 'same-night'} sleep value.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="label" stroke="#9aa1ae" fontSize={11} />
            <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
            <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" />
            <Tooltip
              contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
              formatter={(value, name, props) => [`${value} avg Index (n=${props.payload.n})`, 'Avg Index']}
            />
            <Bar dataKey="avg" radius={[4, 4, 0, 0]}>
              {data.map((entry, idx) => (<Cell key={idx} fill={entry.color} />))}
              <LabelList dataKey="avg" position="top" formatter={(v) => (v > 0 ? v : '')} fill="#e6e8ec" fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ---- Generic small bar chart for Index grouped by an arbitrary key ---------

function IndexGroupChart({ rows, keyFn, sortOrder, color = '#5b8def', yLabel = 'Avg Index' }) {
  const data = useMemo(() => {
    const grouped = averageByGroup(rows, keyFn, (r) => r.performanceIndex)
    if (sortOrder) {
      return grouped.sort((a, b) => sortOrder.indexOf(a.key) - sortOrder.indexOf(b.key))
    }
    return grouped.sort((a, b) => b.avg - a.avg)
  }, [rows, keyFn, sortOrder])

  if (data.length === 0) return <div className="empty-state">No scored games available for this cut.</div>

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="key" stroke="#9aa1ae" fontSize={11} interval={0} angle={data.length > 6 ? -25 : 0} textAnchor={data.length > 6 ? 'end' : 'middle'} height={data.length > 6 ? 50 : 30} />
          <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: yLabel, angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => [`${value} avg Index (n=${props.payload.n})`, 'Avg Index']}
          />
          <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill={color}>
            <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v} (n=${data[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- One opponent's SCRIM vs Official, against the rest of the field -------
// Four bars: for the selected team AND for every OTHER team (that team removed
// from the baseline), the player's average Index in SCRIM and in Official —
// kept strictly separate (GRID's own SCRIM/ESPORTS flag; scrim never mixes into
// official or vice versa).

// LabelList content renderer that reads the true game count off the data row by
// index. recharts' `formatter` second arg is NOT the row index in this build
// (it was printing n=0); `content` gives a reliable index.
function makeBarLabel(data, nKey, fill, fontSize) {
  const Label = (props) => {
    const { x, y, width, index, value } = props
    if (value == null || x == null || y == null) return null
    const n = data[index]?.[nKey] ?? 0
    return (
      <text x={x + width / 2} y={y - 5} fill={fill} fontSize={fontSize} textAnchor="middle">
        {value} (n={n})
      </text>
    )
  }
  return Label
}

function OpponentComparisonChart({ data, opponentName }) {
  const anyData = data.some((d) => d.teamN > 0 || d.restN > 0)
  if (!anyData) return <div className="empty-state">No scored games vs {opponentName} yet.</div>

  return (
    <div className="chart-wrap" style={{ height: 340 }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 18, right: 20, left: 0, bottom: 0 }} barGap={6}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="type" stroke="#9aa1ae" fontSize={12} />
          <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" label={{ value: 'own average', position: 'insideTopRight', fill: '#676f7d', fontSize: 10 }} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => {
              const n = props.dataKey === 'team' ? props.payload.teamN : props.payload.restN
              return [`${value == null ? '—' : value} avg Index (n=${n} games)`, name]
            }}
          />
          <Bar dataKey="team" name={`vs ${opponentName}`} radius={[4, 4, 0, 0]} fill="#5b8def" isAnimationActive={false}>
            <LabelList content={makeBarLabel(data, 'teamN', '#e6e8ec', 11)} />
          </Bar>
          <Bar dataKey="rest" name="vs all other teams" radius={[4, 4, 0, 0]} fill="#3f5a8a" isAnimationActive={false}>
            <LabelList content={makeBarLabel(data, 'restN', '#aeb6c4', 11)} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Development over time: one end-of-day point per day played -----------
// Blue line = that day's scrim average; gold line = trailing-5-scrim-day smooth
// (the trend read); amber diamonds = official (stage) days. 50 = frozen own avg.

function DailyDevelopmentChart({ days, floor, ceiling, boundaryLabel, firstLabel }) {
  if (!days || days.length === 0) return <div className="empty-state">No scored games yet for this player.</div>
  return (
    <div className="chart-wrap" style={{ height: 360 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={days} margin={{ top: 16, right: 72, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          {boundaryLabel && firstLabel && (
            <ReferenceArea x1={firstLabel} x2={boundaryLabel} fill="#5b8def" fillOpacity={0.05} />
          )}
          <XAxis dataKey="label" stroke="#9aa1ae" fontSize={10} minTickGap={28} />
          <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Performance Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          {ceiling != null && (
            <ReferenceLine y={ceiling} stroke="#3aa76d" strokeDasharray="5 3" label={{ value: `ceiling ${ceiling}`, position: 'right', fill: '#3aa76d', fontSize: 10 }} />
          )}
          <ReferenceLine y={50} stroke="#c9ccd2" strokeDasharray="4 4" label={{ value: 'your 50', position: 'right', fill: '#c9ccd2', fontSize: 10 }} />
          {floor != null && (
            <ReferenceLine y={floor} stroke="#e0a940" strokeDasharray="5 3" label={{ value: `floor ${floor}`, position: 'right', fill: '#e0a940', fontSize: 10 }} />
          )}
          {boundaryLabel && (
            <ReferenceLine x={boundaryLabel} stroke="#8a6fd4" strokeWidth={1.5} label={{ value: 'Summer prep →', position: 'insideTopLeft', fill: '#b39ee0', fontSize: 10 }} />
          )}
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            labelFormatter={(label, payload) => {
              const p = payload && payload[0] && payload[0].payload
              return p && p.opponents ? `${label} — vs ${p.opponents}` : label
            }}
            formatter={(value, name, props) => {
              const p = props.payload
              if (name.startsWith('Daily scrim')) return [`${value} (n=${p.scrimN} game${p.scrimN === 1 ? '' : 's'})`, 'Scrim day avg']
              if (name.startsWith('Trend')) return [`${value}`, 'Trend (5 scrim days)']
              if (name.startsWith('Official')) return [`${value} (n=${p.officialN} game${p.officialN === 1 ? '' : 's'})`, 'Official day']
              return [value, name]
            }}
          />
          <Line type="monotone" dataKey="scrimAvg" name="Daily scrim avg" stroke="#5b8def" strokeWidth={1.5} connectNulls dot={{ r: 2.5, fill: '#5b8def', stroke: '#5b8def' }} isAnimationActive={false} />
          <Line type="monotone" dataKey="trend" name="Trend (last 5 scrim days)" stroke="#d4a017" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} />
          <Line dataKey="officialAvg" name="Official day" stroke="transparent" legendType="diamond" connectNulls={false} dot={{ r: 5, fill: '#e0a940', stroke: '#171a21', strokeWidth: 1 }} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Interference by context (not mutually-exclusive buckets) -------------

function InterferenceContextChart({ rows, tilt }) {
  const data = useMemo(() => {
    const withInt = rows.filter((r) => r.interference != null)
    const bucket = (filterFn) => {
      const vals = withInt.filter(filterFn).map((r) => r.interference)
      const avg = average(vals)
      return { avg: avg != null ? Math.round(avg * 10) / 10 : null, n: vals.length }
    }
    const out = [
      { key: 'Scrim', ...bucket((r) => r.seriesType === 'SCRIM') },
      { key: 'Official', ...bucket((r) => r.seriesType === 'ESPORTS') },
      { key: 'Low Sleep <6.5h', ...bucket((r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5) },
      { key: 'High Sleep 7.5h+', ...bucket((r) => r.rollingAvgSleep != null && r.rollingAvgSleep >= 7.5) },
      // GRID's game_number is 0-indexed within a series: 0 = Game 1, 2 = Game 3.
      { key: 'Series Game 1', ...bucket((r) => r.gameNumber === 0) },
      { key: 'Series Game 3+', ...bucket((r) => r.gameNumber != null && r.gameNumber >= 2) },
      { key: 'Day Game 1-2', ...bucket((r) => r.daySequence != null && r.daySequence <= 2) },
      { key: 'Day Game 5+', ...bucket((r) => r.daySequence != null && r.daySequence >= 5) },
    ]
    if (tilt && !tilt.insufficientData && tilt.avgIndexAfterBadGame != null && tilt.overallAvgIndex != null) {
      out.push({
        key: 'After Bad Game',
        avg: Math.round((tilt.overallAvgIndex - tilt.avgIndexAfterBadGame) * 10) / 10,
        n: tilt.recoverySampleSize,
      })
    }
    return out.filter((d) => d.n > 0)
  }, [rows, tilt])

  if (data.length === 0) return <div className="empty-state">Not enough data yet for a context breakdown.</div>

  return (
    <div className="chart-wrap">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="key" stroke="#9aa1ae" fontSize={11} interval={0} angle={-20} textAnchor="end" height={55} />
          <YAxis stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg Interference', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          <ReferenceLine y={0} stroke="#676f7d" strokeDasharray="4 4" />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => [`${value} avg interference (n=${props.payload.n})`, 'Interference']}
          />
          <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill="#e0524a">
            <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v} (n=${data[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Manual tagging for unexplained (residual) interference ---------------

function InterferenceTaggingForm({ player, rows, existingTags, tagsLoading, tagsError, onTagged }) {
  const candidates = useMemo(
    () => rows
      .filter((r) => r.interference != null)
      .slice()
      .sort((a, b) => b.interference - a.interference)
      .slice(0, 30),
    [rows]
  )

  const [selectedIdx, setSelectedIdx] = useState('')
  const [tag, setTag] = useState('skill_gap')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [status, setStatus] = useState(null) // 'success' | 'error'
  const [msg, setMsg] = useState('')

  async function submitTag(e) {
    e.preventDefault()
    setStatus(null)
    if (selectedIdx === '') {
      setStatus('error')
      setMsg('Pick a game first.')
      return
    }
    const row = candidates[Number(selectedIdx)]
    setSubmitting(true)
    const { error } = await supabase.from('interference_tags').insert({
      player,
      game_id: row.gameId,
      game_date: row.date,
      opponent_name: row.opponentName,
      champion: row.champion,
      performance_index: row.performanceIndex,
      interference_amount: row.interference,
      tag,
      note: note.trim() || null,
    })
    setSubmitting(false)
    if (error) {
      setStatus('error')
      setMsg(`Save failed: ${error.message}`)
    } else {
      setStatus('success')
      setMsg('Tagged.')
      setNote('')
      setSelectedIdx('')
      onTagged?.()
    }
  }

  return (
    <div>
      <form onSubmit={submitTag} style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-end', marginBottom: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', flex: '1 1 320px' }}>
          Game (highest interference first)
          <select value={selectedIdx} onChange={(e) => setSelectedIdx(e.target.value)}>
            <option value="">Select a game…</option>
            {candidates.map((r, i) => (
              <option key={i} value={i}>
                {formatDate(r.date)} vs {r.opponentName} ({r.champion}) — interference {r.interference}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)' }}>
          Cause
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            {TAG_OPTIONS.map((t) => (<option key={t.value} value={t.value}>{t.label}</option>))}
          </select>
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', flex: '1 1 260px' }}>
          Note (optional)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
        </label>
        <button type="submit" className="primary" disabled={submitting}>{submitting ? 'Saving…' : 'Tag It'}</button>
      </form>
      {status === 'error' && <div className="toast error" style={{ marginBottom: 12 }}>{msg}</div>}
      {status === 'success' && <div className="toast" style={{ marginBottom: 12 }}>{msg}</div>}

      {tagsLoading ? (
        <div className="loading-state">Loading tagged games…</div>
      ) : tagsError ? (
        <div className="toast error">Error loading tags: {tagsError.message}</div>
      ) : !existingTags || existingTags.length === 0 ? (
        <div className="empty-state">No games tagged for {player} yet.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Date</th><th>Opponent</th><th>Champion</th><th>Interference</th><th>Cause</th><th>Note</th></tr>
            </thead>
            <tbody>
              {existingTags.map((t) => (
                <tr key={t.id}>
                  <td>{formatDate(t.game_date)}</td>
                  <td>{t.opponent_name}</td>
                  <td>{t.champion}</td>
                  <td>{t.interference_amount ?? '—'}</td>
                  <td>{TAG_OPTIONS.find((o) => o.value === t.tag)?.label ?? t.tag}</td>
                  <td>{t.note ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function IndividualPlayerPerformance() {
  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])
  const [sleepMode, setSleepMode] = useState('rolling') // 'rolling' | 'sameNight'
  const [perfOpponent, setPerfOpponent] = useState('all') // 'all' | canonical opponent name
  const [devOpponent, setDevOpponent] = useState('all') // Development panel opponent filter

  // Fetch ALL grid_player_games rows (both teams, no is_sentinels filter) so we
  // can look up the opposing same-role player's net worth for the Performance
  // Index's economy component.
  // Paginated via fetchAllRows: this table passed 11,000+ rows once daily GRID
  // sync came online, well past PostgREST's silent 1000-row default cap — a
  // plain .select() here was truncating the data and made Official games look
  // like they didn't exist for most players (bug found 2026-07-13).
  const { data: allGridRows, error: gridError, loading: gridLoading } = useSupabaseQuery(
    () => fetchAllRows(() =>
      supabase
        .from('grid_player_games')
        .select('game_id, player, role, champion, kills, deaths, assists, net_worth, is_sentinels, team_name, grid_games(game_number, sentinels_won, sentinels_kills, opponent_kills, grid_series_id, grid_series(series_date, series_type, opponent_name, sentinels_won, start_time_scheduled))')
        .not('player', 'is', null)
    ),
    []
  )

  const { data: nightlyRows, error: nightlyError, loading: nightlyLoading } = useSupabaseQuery(
    () => supabase.from('nightly_sleep').select('*').order('sleep_date', { ascending: true }),
    []
  )

  const { data: sessions, error: sessError, loading: sessLoading } = useSupabaseQuery(
    () => supabase.from('sessions').select('session_date, session_type'),
    []
  )

  const { data: tagRows, error: tagError, loading: tagLoading, refetch: refetchTags } = useSupabaseQuery(
    () => supabase.from('interference_tags').select('*').eq('player', player).order('created_at', { ascending: false }),
    [player]
  )

  const { data: dailyEntries, error: dailyError, loading: dailyLoading } = useSupabaseQuery(
    () => supabase.from('daily_entries').select('player, entry_date, vibe_check'),
    []
  )

  const sleepByPlayer = useMemo(() => (nightlyRows ? groupByPlayer(nightlyRows) : {}), [nightlyRows])
  const sessionTypeByDate = useMemo(() => (sessions ? buildSessionTypeByDate(sessions) : {}), [sessions])
  const vibeByDate = useMemo(() => {
    const map = new Map()
    if (dailyEntries) {
      for (const e of dailyEntries) {
        if (e.player === player && e.entry_date != null && e.vibe_check != null) {
          map.set(e.entry_date, e.vibe_check)
        }
      }
    }
    return map
  }, [dailyEntries, player])
  const sentinelsRawRows = useMemo(() => (allGridRows ? allGridRows.filter((r) => r.is_sentinels) : []), [allGridRows])
  const opponentNetWorthByGameRole = useMemo(
    () => (allGridRows ? buildOpponentNetWorthByGameRole(allGridRows) : new Map()),
    [allGridRows]
  )

  const playerRows = useMemo(() => {
    if (!allGridRows) return []
    const base = buildPlayerPerformanceSeries({ rawRows: sentinelsRawRows, player, sleepByPlayer, sessionTypeByDate })
    const withNetWorth = attachNetWorthDiff(base, opponentNetWorthByGameRole)
    // Baselines frozen to the pre-Split-2 body of work (through SEASON_CUTOFF_DATE,
    // see constants.js) so this stays consistent with the Interventions tab's
    // Current Season Tracking panel — same games should score the same
    // Performance Index everywhere in the app.
    return computePerformanceIndex(withNetWorth, { baselineCutoffDate: SEASON_CUTOFF_DATE })
  }, [allGridRows, sentinelsRawRows, player, sleepByPlayer, sessionTypeByDate, opponentNetWorthByGameRole])

  const overextensionFlags = useMemo(() => flagOverextensionCandidates(playerRows), [playerRows])
  const endurance = useMemo(() => computeEnduranceByGameNumber(playerRows), [playerRows])
  // Day-sequence needs start_time_scheduled, which is only populated for series
  // synced since 2026-07-12 — older rows simply won't get a daySequence value
  // (excluded from this chart rather than guessed), so this fills in as more
  // days get re-synced.
  const rowsWithDaySequence = useMemo(() => attachDaySequence(playerRows), [playerRows])
  const enduranceByDay = useMemo(() => computeEnduranceByDaySequence(rowsWithDaySequence), [rowsWithDaySequence])
  const daySequenceCoverage = rowsWithDaySequence.filter((r) => r.daySequence != null).length
  const tilt = useMemo(() => computeTiltRecovery(playerRows), [playerRows])

  const loading = gridLoading || nightlyLoading || sessLoading || dailyLoading
  const error = gridError || nightlyError || sessError || dailyError

  const scoredRows = playerRows.filter((r) => r.performanceIndex != null)
  const officialRows = scoredRows.filter((r) => r.seriesType === 'ESPORTS')
  const scrimRows = scoredRows.filter((r) => r.seriesType === 'SCRIM')
  const avgOfficial = average(officialRows.map((r) => r.performanceIndex))
  const avgScrim = average(scrimRows.map((r) => r.performanceIndex))
  const champBackedCount = scoredRows.filter((r) => r.baselineSource === 'champion').length
  const roleFallbackCount = scoredRows.filter((r) => r.baselineSource === 'role').length
  const unscoredCount = playerRows.length - scoredRows.length

  const potential = useMemo(() => computePotential(scoredRows), [scoredRows])
  const rowsWithInterference = useMemo(
    () => attachInterference(rowsWithDaySequence, potential.potential),
    [rowsWithDaySequence, potential.potential]
  )
  const tdcsPatterns = useMemo(
    () => computeTdcsPatternFlags(rowsWithInterference.filter((r) => r.performanceIndex != null), tilt),
    [rowsWithInterference, tilt]
  )

  // Enrich with vibe (same-day), opponent tier, and prior-game-good — the
  // extra fields the Evidence-Based Patterns and Match Report Card panels
  // need beyond what performanceIndex.js/interference.js already attach.
  const enrichedRows = useMemo(() => {
    const withVibeAndTier = rowsWithInterference.map((r) => ({
      ...r,
      vibe: r.date && vibeByDate.has(r.date) ? vibeByDate.get(r.date) : null,
      tier: opponentTier(r.opponentName),
    }))
    return attachPriorGameGood(withVibeAndTier)
  }, [rowsWithInterference, vibeByDate])

  const [patternScope, setPatternScope] = useState('all') // 'all' | 'scrim' | 'official'
  const patternRows = useMemo(() => {
    if (patternScope === 'scrim') return enrichedRows.filter((r) => r.seriesType === 'SCRIM')
    if (patternScope === 'official') return enrichedRows.filter((r) => r.seriesType === 'ESPORTS')
    return enrichedRows
  }, [enrichedRows, patternScope])
  const conditionCards = useMemo(() => computeConditionCards(patternRows, undefined, player), [patternRows, player])

  const [matchIdx, setMatchIdx] = useState('')
  const matchOptions = useMemo(
    () => enrichedRows.filter((r) => r.performanceIndex != null).slice().sort((a, b) => (a.date < b.date ? 1 : -1)),
    [enrichedRows]
  )
  const selectedMatch = matchIdx !== '' ? matchOptions[Number(matchIdx)] : matchOptions[0]
  const matchPercentile = useMemo(() => {
    if (!selectedMatch || selectedMatch.performanceIndex == null) return null
    const all = scoredRows.map((r) => r.performanceIndex)
    if (all.length === 0) return null
    const below = all.filter((v) => v <= selectedMatch.performanceIndex).length
    return Math.round((below / all.length) * 100)
  }, [selectedMatch, scoredRows])

  // Per-opponent SCRIM-vs-Official breakdown for this player (canonicalised so
  // e.g. "Team Liquid" and "Team Liquid Alienware" are one entry). Counts are
  // GAMES (individual grid_player_games rows), with distinct SERIES counts kept
  // alongside because Officials are BO3s — 6 official games can be just 2 series
  // (2 match days), and the series count is the honest independent-sample size.
  const opponentBreakdown = useMemo(() => {
    const map = new Map()
    for (const r of scoredRows) {
      const name = canonicalOpponentName(r.opponentName)
      if (!name) continue
      if (!map.has(name)) {
        map.set(name, {
          name,
          scrim: { sum: 0, n: 0, series: new Set() },
          official: { sum: 0, n: 0, series: new Set() },
        })
      }
      const e = map.get(name)
      const bucket = r.seriesType === 'ESPORTS' ? e.official : r.seriesType === 'SCRIM' ? e.scrim : null
      if (!bucket) continue
      bucket.sum += r.performanceIndex // scoredRows are already performanceIndex != null
      bucket.n += 1
      if (r.seriesId) bucket.series.add(r.seriesId)
    }
    return Array.from(map.values())
      .map((e) => {
        const scrimAvg = e.scrim.n ? Math.round((e.scrim.sum / e.scrim.n) * 10) / 10 : null
        const officialAvg = e.official.n ? Math.round((e.official.sum / e.official.n) * 10) / 10 : null
        return {
          name: e.name,
          scrimGames: e.scrim.n, scrimSeries: e.scrim.series.size, scrimAvg,
          officialGames: e.official.n, officialSeries: e.official.series.size, officialAvg,
          gap: scrimAvg != null && officialAvg != null ? Math.round((officialAvg - scrimAvg) * 10) / 10 : null,
        }
      })
      .sort((a, b) => (b.scrimGames + b.officialGames) - (a.scrimGames + a.officialGames) || a.name.localeCompare(b.name))
  }, [scoredRows])

  // Opponents this player has actually played on stage — used to default the
  // comparison to a well-sampled team.
  const officialOpponents = opponentBreakdown.filter((o) => o.officialGames > 0)

  // Which opponent the comparison shows. Default to the team with the most
  // official games (FlyQuest) so all four bars are populated on load; fall back
  // to the most-played team, or null if this player has no scored games. The
  // 'all' initial state simply means "not chosen yet → use the default".
  const defaultOpponent = officialOpponents[0]?.name ?? opponentBreakdown[0]?.name ?? null
  const activePerfOpponent = perfOpponent && perfOpponent !== 'all' && opponentBreakdown.some((o) => o.name === perfOpponent)
    ? perfOpponent
    : defaultOpponent

  // Development-panel opponent filter — falls back to All if the selected team
  // isn't in this player's list (e.g. after switching players).
  const activeDevOpponent = devOpponent !== 'all' && opponentBreakdown.some((o) => o.name === devOpponent)
    ? devOpponent
    : 'all'

  // The four data points: this player's average Index in SCRIM and in Official,
  // each computed (a) vs the selected team only and (b) vs every OTHER team
  // (the selected team removed from that baseline). SCRIM and Official are kept
  // strictly separate — no scrim game counts toward an official number or the
  // reverse.
  const comparison = useMemo(() => {
    if (!activePerfOpponent) return null
    const summarise = (rows, type) => {
      const f = rows.filter((r) => r.seriesType === type)
      const avg = f.length ? Math.round((f.reduce((s, r) => s + r.performanceIndex, 0) / f.length) * 10) / 10 : null
      const series = new Set(f.map((r) => r.seriesId).filter(Boolean)).size
      return { avg, n: f.length, series }
    }
    const teamRows = scoredRows.filter((r) => canonicalOpponentName(r.opponentName) === activePerfOpponent)
    const restRows = scoredRows.filter((r) => canonicalOpponentName(r.opponentName) !== activePerfOpponent)
    return {
      scrimTeam: summarise(teamRows, 'SCRIM'),
      officialTeam: summarise(teamRows, 'ESPORTS'),
      scrimRest: summarise(restRows, 'SCRIM'),
      officialRest: summarise(restRows, 'ESPORTS'),
    }
  }, [scoredRows, activePerfOpponent])

  const comparisonChartData = comparison
    ? [
        { type: 'SCRIM', team: comparison.scrimTeam.avg, teamN: comparison.scrimTeam.n, rest: comparison.scrimRest.avg, restN: comparison.scrimRest.n },
        { type: 'Official', team: comparison.officialTeam.avg, teamN: comparison.officialTeam.n, rest: comparison.officialRest.avg, restN: comparison.officialRest.n },
      ]
    : []

  // DEVELOPMENT OVER TIME — one end-of-day snapshot per day the player played.
  // Each day = the average Performance Index across that day's games (scrim and
  // official kept separate), so daily training reads as a trajectory instead of
  // game-by-game noise. A trailing 5-scrim-day average is the smoothed trend
  // line; a plain-English direction compares the last 5 training days to the 5
  // before. Baseline stays frozen (SEASON_CUTOFF_DATE), so a rising line is real
  // improvement, not a moving goalpost.
  const dailyDevelopment = useMemo(() => {
    // Optionally restrict to one opponent so a run of easy scrim partners can't
    // inflate (or a hard stretch deflate) the daily trend. Floor/ceiling/50 stay
    // the player's OVERALL range (from tilt/potential) — the selected opponent's
    // days are read against that fixed range, not a wobbly one-opponent baseline.
    const devRows = activeDevOpponent === 'all'
      ? scoredRows
      : scoredRows.filter((r) => canonicalOpponentName(r.opponentName) === activeDevOpponent)
    const byDate = new Map()
    for (const r of devRows) {
      if (!r.date) continue
      if (!byDate.has(r.date)) byDate.set(r.date, { date: r.date, scrimSum: 0, scrimN: 0, offSum: 0, offN: 0, opponents: new Set() })
      const e = byDate.get(r.date)
      if (r.seriesType === 'ESPORTS') { e.offSum += r.performanceIndex; e.offN += 1 }
      else if (r.seriesType === 'SCRIM') { e.scrimSum += r.performanceIndex; e.scrimN += 1 }
      const name = canonicalOpponentName(r.opponentName)
      if (name) e.opponents.add(name)
    }
    const days = Array.from(byDate.values())
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((e) => ({
        date: e.date,
        label: formatDate(e.date),
        scrimAvg: e.scrimN ? Math.round((e.scrimSum / e.scrimN) * 10) / 10 : null,
        scrimN: e.scrimN,
        officialAvg: e.offN ? Math.round((e.offSum / e.offN) * 10) / 10 : null,
        officialN: e.offN,
        opponents: Array.from(e.opponents).join(', '),
      }))
    // trailing 5-scrim-day rolling average as the trend line
    const K = 5
    const window = []
    for (const d of days) {
      if (d.scrimAvg != null) {
        window.push(d.scrimAvg)
        if (window.length > K) window.shift()
        d.trend = Math.round((window.reduce((s, v) => s + v, 0) / window.length) * 10) / 10
      } else {
        d.trend = null
      }
    }
    // direction: last 5 scrim days vs the 5 before
    const scrimDays = days.filter((d) => d.scrimAvg != null)
    const mean = (arr) => (arr.length ? Math.round((arr.reduce((s, d) => s + d.scrimAvg, 0) / arr.length) * 10) / 10 : null)
    const last5 = scrimDays.slice(-5)
    const prev5 = scrimDays.slice(-10, -5)
    const recentAvg = mean(last5)
    const priorAvg = mean(prev5)
    const delta = recentAvg != null && priorAvg != null ? Math.round((recentAvg - priorAvg) * 10) / 10 : null
    // Boundary between the historical baseline (defines 50) and the Summer-split
    // prep block (July 7 onward, > SEASON_CUTOFF_DATE) — the part that can move.
    const boundaryDay = days.find((d) => d.date > SEASON_CUTOFF_DATE)
    return {
      days,
      recentAvg, priorAvg, delta,
      recentN: last5.length, priorN: prev5.length, scrimDayCount: scrimDays.length,
      firstLabel: days.length ? days[0].label : null,
      boundaryLabel: boundaryDay ? boundaryDay.label : null,
    }
  }, [scoredRows, activeDevOpponent])

  return (
    <div>
      <div className="panel">
        <h2>Player Performance Dashboard</h2>
        <p className="panel-caption">
          Performance Index blends KDA, kill participation, and net-worth differential vs the same-role
          opponent — each z-scored against this player&rsquo;s own history on that champion (or role, when
          the champion sample is thin), then mapped to a 0-100 scale where 50 is that player&rsquo;s own
          average. Per A-R1, this never compares one player&rsquo;s number to another&rsquo;s. Per A-R4,
          champion is attached everywhere. See Coverage Caveats at the bottom for exactly what this can and
          can&rsquo;t see.
        </p>
        {loading && <div className="loading-state">Loading GRID, sleep, and session data…</div>}
        {error && <div className="toast error">Error loading data: {error.message}</div>}
      </div>

      {!loading && !error && (
        <>
          <div className="panel">
            <h2>Scrim vs Official — Opponent Comparison</h2>
            <p className="panel-caption">
              For the chosen player and opponent, four numbers kept strictly separate: their average
              Performance Index in <strong>scrim</strong> games and in <strong>official</strong> games, each
              shown <strong>against that opponent</strong> and <strong>against every other team</strong> (the
              selected opponent removed from that baseline — a clean this-team-vs-the-rest read). Scrim and
              official never mix. The dashed line at 50 is this player&rsquo;s own all-games average. Officials
              are a small sample, so the caption below gives the exact game and series counts.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginBottom: 16 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', minWidth: 160 }}>
                Player
                <select value={player} onChange={(e) => setPlayer(e.target.value)}>
                  {ROSTER_PLAYERS.map((p) => (<option key={p} value={p}>{p}</option>))}
                </select>
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', flex: '1 1 320px', maxWidth: 460 }}>
                Opponent
                <select value={activePerfOpponent ?? ''} onChange={(e) => setPerfOpponent(e.target.value)}>
                  {opponentBreakdown.map((o) => (
                    <option key={o.name} value={o.name}>
                      {o.name} — {o.scrimGames} scrim game{o.scrimGames === 1 ? '' : 's'}, {o.officialGames} official game{o.officialGames === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {!activePerfOpponent || !comparison ? (
              <div className="empty-state">No scored games for {player} yet.</div>
            ) : (
              <>
                <OpponentComparisonChart data={comparisonChartData} opponentName={activePerfOpponent} />
                <p className="panel-caption" style={{ marginTop: 10 }}>
                  <strong>{player} vs {activePerfOpponent}</strong> — scrim {comparison.scrimTeam.avg ?? '—'}
                  {' '}({comparison.scrimTeam.n} game{comparison.scrimTeam.n === 1 ? '' : 's'}), official{' '}
                  {comparison.officialTeam.avg ?? '—'} ({comparison.officialTeam.n} game{comparison.officialTeam.n === 1 ? '' : 's'}
                  {comparison.officialTeam.n > 0 ? ` across ${comparison.officialTeam.series} series` : ''}).{' '}
                  <strong>vs the rest of the field</strong> (excludes {activePerfOpponent}) — scrim{' '}
                  {comparison.scrimRest.avg ?? '—'} ({comparison.scrimRest.n} games), official{' '}
                  {comparison.officialRest.avg ?? '—'} ({comparison.officialRest.n} games).
                  {comparison.officialTeam.n === 0
                    ? ` No official games vs ${activePerfOpponent} yet — the official "vs ${activePerfOpponent}" bar is empty.`
                    : comparison.officialTeam.series < 3
                      ? ` Only ${comparison.officialTeam.series} official series vs ${activePerfOpponent} — treat the on-stage bar as directional.`
                      : ''}
                </p>
              </>
            )}
          </div>

          <div className="panel">
            <h2>Development Over Time — {player}</h2>
            <p className="panel-caption">
              One point per day the player played — the end-of-day average across that day&rsquo;s games, so
              daily training reads as a trajectory instead of game-by-game noise. The blue line is each
              day&rsquo;s <strong>scrim</strong> average; the gold line smooths it (trailing 5 scrim days);
              amber diamonds are <strong>official (stage) days</strong>. The three dashed guides are this
              player&rsquo;s range: the grey <strong>&ldquo;your 50&rdquo;</strong> line is their historical
              middle — the average of their highs and lows through the end of June, not a floor — with their
              typical bad-game <strong>floor</strong> (amber) below it and their <strong>ceiling</strong>
              (Potential, green) above. Everything left of the purple <strong>&ldquo;Summer prep&rdquo;</strong>
              divider is the historical baseline that <em>defines</em> that 50, so it sits on the line by
              design; everything right of it is Summer-split prep (July onward) — the part that can actually
              climb above the 50 or slip below it. A low single day can be a Green (experimental) scrim rather
              than a real drop — check the session before reading it as a problem. Filter to one opponent to
              stop a run of easy (or hard) scrim partners inflating or deflating the trend — the floor / 50 /
              ceiling range stays the player&rsquo;s overall history so the opponent&rsquo;s days are read
              against their true range.
            </p>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', marginBottom: 14, maxWidth: 420 }}>
              Opponent
              <select value={activeDevOpponent} onChange={(e) => setDevOpponent(e.target.value)}>
                <option value="all">All opponents</option>
                {opponentBreakdown.map((o) => (
                  <option key={o.name} value={o.name}>
                    {o.name} — {o.scrimGames} scrim game{o.scrimGames === 1 ? '' : 's'}, {o.officialGames} official game{o.officialGames === 1 ? '' : 's'}
                  </option>
                ))}
              </select>
            </label>
            {dailyDevelopment.days.length === 0 ? (
              <div className="empty-state">
                No scored games for {player}{activeDevOpponent === 'all' ? '' : ` vs ${activeDevOpponent}`} yet.
              </div>
            ) : (
              <>
                <div className="stat-grid">
                  <div className="stat-card">
                    <div className="stat-label">Recent scrim level</div>
                    <div className="stat-value">{dailyDevelopment.recentAvg ?? '—'}</div>
                    <div className="stat-sub">avg of last {dailyDevelopment.recentN} training day{dailyDevelopment.recentN === 1 ? '' : 's'} · 50 = historical middle</div>
                  </div>
                  <div className={`stat-card ${dailyDevelopment.delta == null ? '' : dailyDevelopment.delta >= 1.5 ? 'flag-good' : dailyDevelopment.delta <= -1.5 ? 'flag-amber' : ''}`}>
                    <div className="stat-label">Trend</div>
                    <div className="stat-value">
                      {dailyDevelopment.delta == null ? '—' : `${dailyDevelopment.delta > 0 ? '+' : ''}${dailyDevelopment.delta}`}
                      {dailyDevelopment.delta != null && (
                        <span style={{ fontSize: 13, marginLeft: 6, color: 'var(--text-dim)' }}>
                          {dailyDevelopment.delta >= 1.5 ? 'improving' : dailyDevelopment.delta <= -1.5 ? 'slipping' : 'holding'}
                        </span>
                      )}
                    </div>
                    <div className="stat-sub">last {dailyDevelopment.recentN} vs previous {dailyDevelopment.priorN} training days</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Floor (typical bad game)</div>
                    <div className="stat-value">{tilt.insufficientData ? '—' : tilt.badGameThreshold}</div>
                    <div className="stat-sub">low end of their range — bottom-quartile game</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Ceiling (Potential)</div>
                    <div className="stat-value">{potential.insufficientData ? '—' : potential.potential}</div>
                    <div className="stat-sub">top of their range — the target to train toward</div>
                  </div>
                </div>
                <DailyDevelopmentChart
                  days={dailyDevelopment.days}
                  floor={tilt.insufficientData ? null : tilt.badGameThreshold}
                  ceiling={potential.insufficientData ? null : potential.potential}
                  boundaryLabel={dailyDevelopment.boundaryLabel}
                  firstLabel={dailyDevelopment.firstLabel}
                />
              </>
            )}
          </div>

          <div className="panel">
            <div className="player-tabs">
              {ROSTER_PLAYERS.map((p) => (
                <button key={p} type="button" className={`player-tab ${player === p ? 'active' : ''}`} onClick={() => setPlayer(p)}>
                  {p}
                </button>
              ))}
            </div>

            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-label">Performance Index — Official</div>
                <div className="stat-value">{avgOfficial != null ? avgOfficial.toFixed(1) : '—'}</div>
                <div className="stat-sub">n={officialRows.length} Official games</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Performance Index — Scrim</div>
                <div className="stat-value">{avgScrim != null ? avgScrim.toFixed(1) : '—'}</div>
                <div className="stat-sub">n={scrimRows.length} SCRIM games</div>
              </div>
              <div className={`stat-card ${tilt.insufficientData || tilt.avgIndexAfterBadGame == null ? '' : tilt.avgIndexAfterBadGame < tilt.overallAvgIndex - 5 ? 'flag-amber' : ''}`}>
                <div className="stat-label">Index After a Bad Game</div>
                <div className="stat-value">{tilt.insufficientData ? '—' : (tilt.avgIndexAfterBadGame ?? '—')}</div>
                <div className="stat-sub">
                  {tilt.insufficientData ? 'not enough series data yet' : `own avg ${tilt.overallAvgIndex} · n=${tilt.recoverySampleSize} recoveries`}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Baseline Confidence</div>
                <div className="stat-value">{playerRows.length > 0 ? Math.round((champBackedCount / playerRows.length) * 100) : 0}%</div>
                <div className="stat-sub">{champBackedCount} champion-backed · {roleFallbackCount} role fallback · {unscoredCount} unscored</div>
              </div>
            </div>
            <p className="panel-caption">
              {playerRows.length} dated games for {player} — {scoredRows.length} scored, {unscoredCount} not
              yet scored (still building a baseline).
            </p>
          </div>

          <div className="panel">
            <h2>Match Report Card — {player}</h2>
            <p className="panel-caption">
              Pick a game to get an objective read the moment a result comes in — was this actually a
              below-normal performance, or did the team lose (or win) despite {player} playing to their own
              standard? Independent of the scoreboard.
            </p>
            {matchOptions.length === 0 ? (
              <div className="empty-state">No scored games available yet for {player}.</div>
            ) : (
              <>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', marginBottom: 14, maxWidth: 480 }}>
                  Game
                  <select value={matchIdx} onChange={(e) => setMatchIdx(e.target.value)}>
                    {matchOptions.map((r, i) => (
                      <option key={i} value={i}>
                        {formatDate(r.date)} vs {r.opponentName} ({r.champion}) — {r.sentinelsWonGame === true ? 'Win' : r.sentinelsWonGame === false ? 'Loss' : 'Result unknown'}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedMatch && (
                  <>
                    <p style={{ fontSize: 14, lineHeight: 1.6, marginBottom: 14 }}>
                      {selectedMatch.performanceIndex > 55 && (
                        <>Objectively, this was an <strong>above-normal</strong> performance for {player} on {selectedMatch.champion} — Index {selectedMatch.performanceIndex} (their own {matchPercentile}th percentile), independent of the {selectedMatch.sentinelsWonGame ? 'win' : 'loss'}.</>
                      )}
                      {selectedMatch.performanceIndex <= 55 && selectedMatch.performanceIndex >= 45 && (
                        <>Objectively, this was <strong>roughly normal</strong> for {player} on {selectedMatch.champion} — Index {selectedMatch.performanceIndex} (their own {matchPercentile}th percentile). The {selectedMatch.sentinelsWonGame ? 'win' : 'loss'} isn&rsquo;t explained by an individual performance dip here.</>
                      )}
                      {selectedMatch.performanceIndex < 45 && (
                        <>Objectively, this was a <strong>below-normal</strong> performance for {player} on {selectedMatch.champion} — Index {selectedMatch.performanceIndex} (their own {matchPercentile}th percentile), {Math.abs(selectedMatch.interference ?? 0)} pts of interference below their Potential.</>
                      )}
                    </p>
                    <div className="stat-grid">
                      <div className="stat-card">
                        <div className="stat-label">Performance Index</div>
                        <div className="stat-value">{selectedMatch.performanceIndex}</div>
                        <div className="stat-sub">{matchPercentile}th percentile of own history</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">K / D / A</div>
                        <div className="stat-value">{selectedMatch.kills}/{selectedMatch.deaths}/{selectedMatch.assists}</div>
                        <div className="stat-sub">KDA {selectedMatch.kda} · KP {selectedMatch.killParticipation ?? '—'}%</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Net Worth Diff vs Lane</div>
                        <div className="stat-value">{selectedMatch.netWorthDiff ?? '—'}</div>
                        <div className="stat-sub">vs same-role opponent</div>
                      </div>
                      <div className="stat-card">
                        <div className="stat-label">Sleep Context</div>
                        <div className="stat-value">{selectedMatch.rollingAvgSleep ?? '—'}h</div>
                        <div className="stat-sub">3-night rolling{selectedMatch.sameNightSleepHours != null ? ` · same-night ${selectedMatch.sameNightSleepHours}h` : ''}</div>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </div>

          <div className="panel">
            <h2>Interference — {player}</h2>
            <p className="panel-caption">
              Performance = Potential − Interference (Gallwey&rsquo;s Inner Game model). Potential is{' '}
              {player}&rsquo;s own ceiling — the average Index across their own best scored games.
              Interference per game is Potential minus that game&rsquo;s Index: how far below their own best
              they fell, never a comparison to a teammate.
            </p>
            {potential.insufficientData ? (
              <div className="empty-state">Not enough scored games yet to estimate Potential for {player} (need at least 5).</div>
            ) : (
              <>
                <div className="stat-grid">
                  <div className="stat-card">
                    <div className="stat-label">Potential (P)</div>
                    <div className="stat-value">{potential.potential}</div>
                    <div className="stat-sub">avg of top {potential.topN} of {potential.n} scored games</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-label">Avg Interference (I)</div>
                    <div className="stat-value">{tdcsPatterns.overallAvgInterference ?? '—'}</div>
                    <div className="stat-sub">Potential − Index, averaged across all scored games</div>
                  </div>
                </div>

                <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 4 }}>Interference by Context</h3>
                <p className="panel-caption">
                  Where the Potential-minus-Performance gap concentrates. Contexts overlap (a game can be both
                  Official and Low Sleep) — this is about where the gap shows up, not a precise split of one
                  game&rsquo;s interference into percentages.
                </p>
                <InterferenceContextChart rows={rowsWithInterference} tilt={tilt} />

                <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 8 }}>tDCS-Relevant Patterns</h3>
                {tdcsPatterns.insufficientData ? (
                  <div className="empty-state">Not enough data yet to check for tDCS-relevant patterns.</div>
                ) : tdcsPatterns.flags.length === 0 ? (
                  <div className="empty-state">No context shows a meaningful interference gap (≥8 pts) for {player} yet.</div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {tdcsPatterns.flags.map((f, i) => (
                      <div key={i} className={`flag-banner ${f.type === 'sleep_debt' ? 'critical' : 'amber'}`}>
                        <strong>{f.protocol}</strong> — {f.summary}
                        <br />
                        <span style={{ fontSize: 12, opacity: 0.85 }}>{f.evidence}</span>
                      </div>
                    ))}
                  </div>
                )}

                <h3 style={{ fontSize: 14, marginTop: 20, marginBottom: 8 }}>Unexplained Interference — Tag It</h3>
                <p className="panel-caption">
                  These patterns don&rsquo;t cover everything — lack of skill/knowledge, motivation, and
                  conflict have no structured signal in this data. Tag specific games below so those causes
                  build into a real record instead of staying anecdotal.
                </p>
                <InterferenceTaggingForm
                  player={player}
                  rows={rowsWithInterference}
                  existingTags={tagRows}
                  tagsLoading={tagLoading}
                  tagsError={tagError}
                  onTagged={refetchTags}
                />
              </>
            )}
          </div>

          <div className="panel">
            <h2>Evidence-Based Patterns — {player}</h2>
            <p className="panel-caption">
              &ldquo;When {player} does X, how often is that a good performance (Index &gt;50, above their own
              average)?&rdquo; Each tile leads with a plain-English read — a green border means the gap is bigger
              than the sample&rsquo;s own uncertainty and worth acting on; an amber border is the same but in the
              wrong direction; no color means it could just be normal game-to-game noise, not a real pattern yet.
              The numbers underneath (a 95% confidence interval, not a bare percentage) are there if you want to
              check the tile&rsquo;s work. Officials and Scrims can behave differently, so pick a scope below
              rather than reading one blended number.
            </p>
            <div className="player-tabs" style={{ marginBottom: 14 }}>
              <button type="button" className={`player-tab ${patternScope === 'all' ? 'active' : ''}`} onClick={() => setPatternScope('all')}>All Games</button>
              <button type="button" className={`player-tab ${patternScope === 'scrim' ? 'active' : ''}`} onClick={() => setPatternScope('scrim')}>Scrim Only</button>
              <button type="button" className={`player-tab ${patternScope === 'official' ? 'active' : ''}`} onClick={() => setPatternScope('official')}>Official Only</button>
            </div>
            <p className="panel-caption">
              Baseline: {player} has a good performance {conditionCards.baseline ?? '—'}% of the time overall
              in this scope (n={conditionCards.totalScored} scored games).
            </p>
            {conditionCards.totalScored < 10 ? (
              <div className="empty-state">Only {conditionCards.totalScored} scored games in this scope — not enough to mine patterns reliably yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10 }}>
                {conditionCards.cards.map((c) => (
                  <div key={c.key} className={`stat-card ${c.insufficientData ? '' : c.significant ? (c.direction === 'better' ? 'flag-good' : 'flag-amber') : ''}`}>
                    <div className="stat-label">{c.label}</div>
                    <div className="stat-verdict">{c.verdict}</div>
                    {!c.insufficientData && (
                      <div className="stat-sub">
                        {c.pGood}% good · 95% CI {c.ciLow}–{c.ciHigh}% · n={c.n} · baseline {c.baseline}% ({c.lift > 0 ? '+' : ''}{c.lift} pts)
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Performance Index Over Time — {player}</h2>
            <p className="panel-caption">
              Dot color follows the same sleep-debt bands as Sleep Debt Analysis (green optimal → red severe),
              based on the 3-night rolling average as of that game&rsquo;s date. The dashed line at 50 is
              {' '}{player}&rsquo;s own average — not a league or team benchmark.
            </p>
            <PerformanceTrendChart rows={playerRows} />
          </div>

          <div className="panel">
            <h2>By Champion — {player}</h2>
            <p className="panel-caption">
              Average Performance Index per champion played. A champion with a small n here has a shakier
              baseline (see Baseline Confidence above) — read a dip on a rarely-played pick as low-confidence,
              not as a real trend, per A-R4.
            </p>
            <IndexGroupChart rows={scoredRows} keyFn={(r) => r.champion} color="#d4a017" />
          </div>

          <div className="panel">
            <h2>By Opponent Tier — {player}</h2>
            <p className="panel-caption">
              Tier 5 = TL/Lyon, Tier 4 = C9/FLY, Tier 3 = SR/DIG/DSG, per CLAUDE.md&rsquo;s ranking. Americas
              Cup / regional opponents (Furia, RED Canids Kalunga, etc.) aren&rsquo;t in that ranking and are
              grouped as Unranked rather than guessed at.
            </p>
            <IndexGroupChart rows={scoredRows} keyFn={(r) => { const t = opponentTier(r.opponentName); return t ? `Tier ${t}` : 'Unranked' }} sortOrder={TIER_ORDER} color="#8a6fd4" />
          </div>

          <div className="panel">
            <h2>Green / Orange / Red / Official — {player}</h2>
            <p className="panel-caption">
              Secondary cut. Official comes directly from GRID&rsquo;s ESPORTS flag (always complete);
              Green/Orange/Red comes from a date join to the sessions table for SCRIM games only, and
              coverage there is partial.
            </p>
            <IndexGroupChart rows={scoredRows.filter((r) => r.sessionTypeLabel && !r.sessionTypeAmbiguous)} keyFn={(r) => r.sessionTypeLabel} sortOrder={SESSION_TYPE_ORDER} color="#8a6fd4" />
          </div>

          <div className="panel">
            <h2>Endurance — Performance by Position in the Day&rsquo;s Scrim Block — {player}</h2>
            <p className="panel-caption">
              The real fade signal: Sentinels typically play 5-8 (sometimes more) consecutive BO1s in a day
              against the same or rotating opponents. This orders every game {player} played on a given date
              by its actual start time (from GRID&rsquo;s schedule data) and averages Performance Index by
              1st game of the day, 2nd, 3rd, 4th, 5th+. Coverage: {daySequenceCoverage} of {playerRows.length} games
              have a timestamp so far — this fills in as more history gets re-synced with real GRID timestamps
              (see Coverage Caveats).
            </p>
            <div className="chart-wrap">
              {enduranceByDay.every((e) => e.n === 0) ? (
                <div className="empty-state">No day-sequence data yet — needs games synced with GRID start-time data.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={enduranceByDay} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                    <XAxis dataKey="key" stroke="#9aa1ae" fontSize={11} />
                    <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
                    <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" />
                    <Tooltip
                      contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                      formatter={(value, name, props) => [`${value} avg Index (n=${props.payload.n})`, 'Avg Index']}
                    />
                    <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill="#3aa76d">
                      <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v ?? ''} (n=${enduranceByDay[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Endurance — Performance by Game Number Within a Series — {player}</h2>
            <p className="panel-caption">
              Secondary lens: fade within a single BO3+ series (Officials only — 97.6% of scrims are
              single-game BO1s, so they only ever populate &ldquo;Game 1&rdquo; here; use the day-sequence
              chart above for scrim fade). Average Performance Index by Game 1 vs Game 2 vs Game 3+ within
              the same series.
            </p>
            <div className="chart-wrap">
              {endurance.every((e) => e.n === 0) ? (
                <div className="empty-state">No multi-game series data available.</div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={endurance} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                    <XAxis dataKey="key" stroke="#9aa1ae" fontSize={11} />
                    <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg Index', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
                    <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" />
                    <Tooltip
                      contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                      formatter={(value, name, props) => [`${value} avg Index (n=${props.payload.n})`, 'Avg Index']}
                    />
                    <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill="#3aa76d">
                      <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v ?? ''} (n=${endurance[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Tilt Detector — {player}</h2>
            <p className="panel-caption">
              &ldquo;Bad game&rdquo; is defined as the bottom quartile of {player}&rsquo;s own Performance
              Index distribution (A-R1: own control, not a team-wide bar). &ldquo;Recovery&rdquo; is the next
              game_number within the same GRID series — the closest available proxy for &ldquo;immediately
              after,&rdquo; since we don&rsquo;t have finer timestamps. Per S-R4, cross-check same-night and
              3-night sleep before reading a poor recovery as a mentality issue rather than a sleep-debt one.
            </p>
            {tilt.insufficientData ? (
              <div className="empty-state">Not enough series data yet to compute a tilt-recovery signal for {player}.</div>
            ) : (
              <div className="stat-grid">
                <div className="stat-card">
                  <div className="stat-label">Bad-Game Threshold</div>
                  <div className="stat-value">≤{tilt.badGameThreshold}</div>
                  <div className="stat-sub">{tilt.badGameCount} games at/below this line</div>
                </div>
                <div className="stat-card">
                  <div className="stat-label">Own Average Index</div>
                  <div className="stat-value">{tilt.overallAvgIndex}</div>
                </div>
                <div className={`stat-card ${tilt.avgIndexAfterBadGame != null && tilt.avgIndexAfterBadGame < tilt.overallAvgIndex - 5 ? 'flag-amber' : ''}`}>
                  <div className="stat-label">Avg Index — Game Right After a Bad One</div>
                  <div className="stat-value">{tilt.avgIndexAfterBadGame ?? '—'}</div>
                  <div className="stat-sub">n={tilt.recoverySampleSize} same-series follow-up games</div>
                </div>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Sleep vs Performance Index — {player}</h2>
            <p className="panel-caption">
              Average Performance Index bucketed by sleep-debt band. Per S-R1, the 3-night rolling average is
              the more reliable readiness signal; same-night is shown for comparison, not as the primary read.
            </p>
            <div className="player-tabs" style={{ marginBottom: 12 }}>
              <button type="button" className={`player-tab ${sleepMode === 'rolling' ? 'active' : ''}`} onClick={() => setSleepMode('rolling')}>3-night rolling avg</button>
              <button type="button" className={`player-tab ${sleepMode === 'sameNight' ? 'active' : ''}`} onClick={() => setSleepMode('sameNight')}>Same-night</button>
            </div>
            <IndexBySleepBandChart rows={playerRows} mode={sleepMode === 'rolling' ? 'rolling' : 'sameNight'} />
          </div>

          <div className="panel">
            <h2>Overextension Candidates (Weak Signal) — {player}</h2>
            <p className="panel-caption">
              GRID&rsquo;s Series Events product (kill/death timing and positions) isn&rsquo;t in the current
              Open Access API key, so true over-chasing/giving-body detection isn&rsquo;t possible from this
              data. As a coarse proxy, games below are flagged where {player} died 5+ times, deaths outnumbered
              kills by 3+, and the game was lost — a starting point for manual review, not a validated measure.
            </p>
            {overextensionFlags.length === 0 ? (
              <div className="empty-state">No games matched this coarse pattern for {player}.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr><th>Date</th><th>Champion</th><th>Opponent</th><th>K/D/A</th><th>Perf. Index</th><th>Session</th></tr>
                  </thead>
                  <tbody>
                    {overextensionFlags.map((r, i) => (
                      <tr key={i}>
                        <td>{formatDate(r.date)}</td>
                        <td>{r.champion}</td>
                        <td>{r.opponentName}</td>
                        <td>{r.kills}/{r.deaths}/{r.assists}</td>
                        <td>{r.performanceIndex ?? '—'}</td>
                        <td>{r.seriesType === 'ESPORTS' ? 'Official' : `${r.seriesType}${r.sessionTypeLabel ? ` / ${r.sessionTypeLabel}` : ''}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Coverage Caveats</h2>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.6 }}>
              <li>
                <strong>Performance Index methodology (added 2026-07-09):</strong> blends KDA, kill
                participation, and net-worth differential vs the same-role opponent, each z-scored against
                this player&rsquo;s own history on that champion (3+ games) or role (fallback). Blended
                z-score maps to 0-100 via 50 + z&times;15, clamped. 50 is this player&rsquo;s own average —
                never compare the number across players (A-R1). A low Baseline Confidence % means more of
                this player&rsquo;s games are still on the shakier role-level fallback.
              </li>
              <li>
                Net-worth differential requires an opposing player logged at the same role in the same game —
                a small number of games may be missing that opponent row in GRID and get a null diff, which
                is excluded from that component rather than guessed.
              </li>
              <li>
                No damage share, CS/min, or vision score in the current GRID Open Access tier — the Index
                can&rsquo;t see those. No in-game timeline either, so endurance is measured between whole
                games, not by minute within a game, and the Overextension table above remains a coarse
                proxy, not real over-chasing detection. See reference_grid_api_tiers memory.
              </li>
              <li>
                <strong>Game-numbering bug fixed (2026-07-12):</strong> GRID numbers games 0-indexed within a
                series (a real BO3 came back numbered 0, 1, 2). The within-series Endurance chart and the
                Series Opener / Late Series conditions in Evidence-Based Patterns previously treated 0 as
                falsy/missing and silently dropped it — since 97.6% of series are single-game BO1s, that was
                nearly every scrim&rsquo;s only game. Both are now corrected to GRID&rsquo;s real numbering.
              </li>
              <li>
                <strong>Day-sequence Endurance added (2026-07-12):</strong> Sentinels play most scrims as 5-8+
                consecutive BO1s in a day, not multi-game series — so within-series game number can&rsquo;t
                see fade across that block at all (every BO1 is &ldquo;Game 1&rdquo;). The new chart above
                orders games chronologically within a calendar day using GRID&rsquo;s start_time_scheduled,
                which is only populated for series synced since this date — older history will fill in as
                it gets re-synced via the daily GRID import.
              </li>
              <li>
                Official is taken directly from GRID&rsquo;s own ESPORTS flag (audited against Leaguepedia&rsquo;s
                Sentinels match history 2026-07-09) — complete and not affected by gaps in the internal
                sessions sheet. Green/Orange/Red still relies on a partial date join for SCRIM games only.
              </li>
              <li>
                Separately (not fixable from this view): the internal sessions sheet&rsquo;s result for
                2026-04-18 vs FlyQuest is wrong — logged as 3 losses; GRID and Leaguepedia both confirm a 2-1
                win. Doesn&rsquo;t affect the numbers here, but the Monitoring Master Sheet needs a manual fix.
              </li>
              <li>
Official-match sample size is small across the whole roster (28 series total, GRID's ESPORTS
                flag — this roster formed mid-January 2026). Any SCRIM-vs-Official or opponent-tier gap
                should be read as directional.
              </li>
              <li>
                Opponent tier mapping only covers CLAUDE.md&rsquo;s ranked LCS opponents; Americas Cup /
                regional opponents are grouped as Unranked rather than assigned a guessed tier.
              </li>
              <li>
                <strong>Interference / Potential / tDCS flags (added 2026-07-12):</strong> Potential is a
                statistical ceiling estimate (top-decile of a player&rsquo;s own scored games), not a claim
                about their true skill limit — it can and will shift as more games are logged. tDCS pattern
                flags are grounded in the tdcs-sleep-research folder's actual evidence, including its
                caveats (e.g. Ankri 2023's mixed rDLPFC result, S022's null tilt-reset result) — they surface
                a pattern worth a conversation, not an automated prescription. Skill gaps, motivation, and
                conflict have no structured signal here; the tagging tool exists specifically because this
                model can&rsquo;t see those on its own.
              </li>
              <li>
                <strong>Match Report Card / Evidence-Based Patterns (added 2026-07-12):</strong> &ldquo;good
                performance&rdquo; means Index &gt;50 (above this player&rsquo;s own average) — a modest bar,
                not an elite one. Pattern probabilities use a Wilson confidence interval specifically because
                small samples (this whole roster has ~60-70 scored games per player, fewer for Official-only)
                produce wide, honest intervals rather than a falsely precise percentage — read the interval,
                not just the point estimate. Vibe is same-day (entry_date = game date) from the daily check-in;
                a day with no logged vibe simply excludes that game from vibe-based conditions rather than
                guessing.
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
