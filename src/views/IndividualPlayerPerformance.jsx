import { useMemo, useState } from 'react'
import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Line, ReferenceLine,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import {
  ROSTER_PLAYERS, SLEEP_DEBT_BANDS, sleepDebtColor, formatDate, bucketize,
  opponentTier, average,
} from '../lib/constants.js'
import { groupByPlayer } from '../lib/sleepDebt.js'
import {
  buildSessionTypeByDate, buildPlayerPerformanceSeries, averageByGroup,
  flagOverextensionCandidates,
} from '../lib/individualPerformance.js'
import {
  buildOpponentNetWorthByGameRole, attachNetWorthDiff, computePerformanceIndex,
  computeEnduranceByGameNumber, computeTiltRecovery,
} from '../lib/performanceIndex.js'
import {
  computePotential, attachInterference, computeTdcsPatternFlags,
} from '../lib/interference.js'

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
      { key: 'Game 1', ...bucket((r) => r.gameNumber === 1) },
      { key: 'Game 3+', ...bucket((r) => r.gameNumber != null && r.gameNumber >= 3) },
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

  // Fetch ALL grid_player_games rows (both teams, no is_sentinels filter) so we
  // can look up the opposing same-role player's net worth for the Performance
  // Index's economy component.
  const { data: allGridRows, error: gridError, loading: gridLoading } = useSupabaseQuery(
    () => supabase
      .from('grid_player_games')
      .select('game_id, player, role, champion, kills, deaths, assists, net_worth, is_sentinels, team_name, grid_games(game_number, sentinels_won, sentinels_kills, opponent_kills, grid_series_id, grid_series(series_date, series_type, opponent_name, sentinels_won))')
      .not('player', 'is', null),
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

  const sleepByPlayer = useMemo(() => (nightlyRows ? groupByPlayer(nightlyRows) : {}), [nightlyRows])
  const sessionTypeByDate = useMemo(() => (sessions ? buildSessionTypeByDate(sessions) : {}), [sessions])
  const sentinelsRawRows = useMemo(() => (allGridRows ? allGridRows.filter((r) => r.is_sentinels) : []), [allGridRows])
  const opponentNetWorthByGameRole = useMemo(
    () => (allGridRows ? buildOpponentNetWorthByGameRole(allGridRows) : new Map()),
    [allGridRows]
  )

  const playerRows = useMemo(() => {
    if (!allGridRows) return []
    const base = buildPlayerPerformanceSeries({ rawRows: sentinelsRawRows, player, sleepByPlayer, sessionTypeByDate })
    const withNetWorth = attachNetWorthDiff(base, opponentNetWorthByGameRole)
    return computePerformanceIndex(withNetWorth)
  }, [allGridRows, sentinelsRawRows, player, sleepByPlayer, sessionTypeByDate, opponentNetWorthByGameRole])

  const overextensionFlags = useMemo(() => flagOverextensionCandidates(playerRows), [playerRows])
  const endurance = useMemo(() => computeEnduranceByGameNumber(playerRows), [playerRows])
  const tilt = useMemo(() => computeTiltRecovery(playerRows), [playerRows])

  const loading = gridLoading || nightlyLoading || sessLoading
  const error = gridError || nightlyError || sessError

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
    () => attachInterference(playerRows, potential.potential),
    [playerRows, potential.potential]
  )
  const tdcsPatterns = useMemo(
    () => computeTdcsPatternFlags(rowsWithInterference.filter((r) => r.performanceIndex != null), tilt),
    [rowsWithInterference, tilt]
  )

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
            <h2>SCRIM vs Official — {player}</h2>
            <p className="panel-caption">
              GRID&rsquo;s native, always-available split (GRID calls it ESPORTS internally; shown here as
              Official, which is what it is) — the primary read on whether performance holds up on stage.
            </p>
            <IndexGroupChart rows={scoredRows} keyFn={(r) => seriesTypeDisplay(r.seriesType)} sortOrder={['SCRIM', 'Official']} color="#5b8def" />
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
            <h2>Endurance — Performance by Game Number in Series — {player}</h2>
            <p className="panel-caption">
              We don&rsquo;t have in-game timing (that&rsquo;s GRID&rsquo;s paid Series Events tier — see
              Coverage Caveats), so this is the closest available proxy for &ldquo;do they fade as a series
              goes on&rdquo;: average Performance Index by Game 1 vs Game 2 vs Game 3+ across all of{' '}
              {player}&rsquo;s series.
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
                can&rsquo;t see those. No in-game timeline either, so &ldquo;endurance&rdquo; is measured by
                game number within a series, not by minute within a game, and the Overextension table above
                remains a coarse proxy, not real over-chasing detection. See reference_grid_api_tiers memory.
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
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
