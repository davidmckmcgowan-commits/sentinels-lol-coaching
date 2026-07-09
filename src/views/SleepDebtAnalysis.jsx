import { useMemo, useState } from 'react'
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
  ReferenceArea, Scatter, ComposedChart,
  BarChart, Bar, Cell, LabelList,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import {
  ROSTER_PLAYERS, SLEEP_DEBT_BANDS, sleepDebtColor, formatDate, bucketize,
  HARD_GATE_HOURS, ROLLING_WINDOW_GAP_DAYS,
} from '../lib/constants.js'
import { groupByPlayer, computeRollingSeries, rollingAveragesAsOf } from '../lib/sleepDebt.js'

// ---- Chart 1: per-player rolling-average trend --------------------------------

function RollingTrendChart({ series }) {
  // Split into segments at gap boundaries so recharts doesn't draw a line across
  // multi-week gaps. Each segment is rendered as its own <Line> sharing one chart,
  // using a dataKey unique to that segment; points outside a segment are null so
  // recharts leaves a break rather than interpolating.
  const segments = useMemo(() => {
    const segs = []
    let current = []
    for (const point of series) {
      if (point.startsNewSegment && current.length > 0) {
        segs.push(current)
        current = []
      }
      current.push(point)
    }
    if (current.length > 0) segs.push(current)
    return segs
  }, [series])

  const chartData = useMemo(() => {
    return series.map((point, idx) => {
      const row = {
        date: point.date,
        label: formatDate(point.date),
        hours: point.hours,
        rollingAvg: point.rollingAvg,
        staleWindow: point.staleWindow,
        isHardGate: point.isHardGate,
        isIsolatedDisruption: point.isIsolatedDisruption,
        idx,
      }
      for (let s = 0; s < segments.length; s += 1) {
        row[`seg${s}`] = segments[s].includes(point) ? point.rollingAvg : null
      }
      return row
    })
  }, [series, segments])

  const hardGatePoints = useMemo(
    () => chartData.filter((d) => d.isHardGate).map((d) => ({ ...d, y: d.rollingAvg })),
    [chartData]
  )
  const isolatedPoints = useMemo(
    () => chartData.filter((d) => d.isIsolatedDisruption).map((d) => ({ ...d, y: d.rollingAvg })),
    [chartData]
  )

  // Shade gap regions (no-data) between segments.
  const gapRegions = useMemo(() => {
    const regions = []
    for (let s = 1; s < segments.length; s += 1) {
      const prevSeg = segments[s - 1]
      const prevIdxInChart = chartData.findIndex((d) => d.date === prevSeg[prevSeg.length - 1].date)
      const nextIdxInChart = chartData.findIndex((d) => d.date === segments[s][0].date)
      if (prevIdxInChart >= 0 && nextIdxInChart >= 0) {
        regions.push({
          x1: chartData[prevIdxInChart].label,
          x2: chartData[nextIdxInChart].label,
          days: segments[s][0].gapFromPrevDays,
        })
      }
    }
    return regions
  }, [segments, chartData])

  if (chartData.length === 0) {
    return <div className="empty-state">No sleep data logged for this player.</div>
  }

  return (
    <div className="chart-wrap" style={{ height: 340 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="label" stroke="#9aa1ae" fontSize={10} minTickGap={25} />
          <YAxis stroke="#9aa1ae" fontSize={12} domain={[0, 14]} label={{ value: 'Rolling 3-night avg (h)', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          {gapRegions.map((g, i) => (
            <ReferenceArea key={i} x1={g.x1} x2={g.x2} strokeOpacity={0} fill="#3a3f4a" fillOpacity={0.35} />
          ))}
          <ReferenceLine y={7.5} stroke="#3aa76d" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={7.0} stroke="#cbb23a" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={6.5} stroke="#e0a940" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={6.0} stroke="#e0524a" strokeDasharray="3 3" strokeOpacity={0.5} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => {
              if (name.startsWith('seg')) {
                const d = props.payload
                const flags = []
                if (d.isHardGate) flags.push('HARD GATE <5h')
                if (d.isIsolatedDisruption) flags.push('isolated disruption')
                if (d.staleWindow) flags.push('stale window (gap >4d or <3 nights)')
                return [
                  `avg ${value}h (night: ${d.hours}h)${flags.length ? ' — ' + flags.join(', ') : ''}`,
                  'Rolling 3-night avg',
                ]
              }
              return [value, name]
            }}
            labelFormatter={(label) => label}
          />
          {segments.map((_, s) => (
            <Line
              key={s}
              type="monotone"
              dataKey={`seg${s}`}
              stroke="#d4a017"
              strokeWidth={2}
              dot={(props) => {
                const { cx, cy, payload } = props
                if (payload[`seg${s}`] == null) return null
                const color = sleepDebtColor(payload.rollingAvg)
                return <circle key={`dot-${payload.idx}`} cx={cx} cy={cy} r={2.5} fill={color} stroke={color} />
              }}
              connectNulls={false}
              isAnimationActive={false}
              legendType="none"
              name={`seg${s}`}
            />
          ))}
          {/* Isolated bad-night markers: single night <6.5h while rolling avg still >=7.0h */}
          <Scatter data={isolatedPoints} dataKey="y" fill="#e0a940" shape="diamond" legendType="none" />
          {/* Hard-gate markers: any single night <5h, regardless of rolling avg */}
          <Scatter data={hardGatePoints} dataKey="y" fill="#b23b3b" shape="star" legendType="none" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Chart 2: team sleep-debt bucket vs win rate -------------------------------

function DebtBucketBarChart({ data }) {
  return (
    <div className="chart-wrap">
      {data.every((d) => d.total === 0) ? (
        <div className="empty-state">No sessions could be matched to a team rolling-debt score.</div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="label" stroke="#9aa1ae" fontSize={11} />
            <YAxis stroke="#9aa1ae" fontSize={12} unit="%" domain={[0, 100]} />
            <Tooltip
              contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
              formatter={(value, name, props) => [`${value}% (n=${props.payload.total})`, 'Win rate']}
            />
            <Bar dataKey="winRate" radius={[4, 4, 0, 0]}>
              {data.map((entry, idx) => (
                <Cell key={idx} fill={entry.color} />
              ))}
              <LabelList dataKey="winRate" position="top" formatter={(v) => `${v}%`} fill="#e6e8ec" fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function SleepDebtAnalysis() {
  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])

  const { data: nightlyRows, error: nightlyError, loading: nightlyLoading } = useSupabaseQuery(
    () => supabase.from('nightly_sleep').select('*').order('sleep_date', { ascending: true }),
    []
  )

  const { data: sessions, error: sessError, loading: sessLoading } = useSupabaseQuery(
    () => supabase.from('sessions').select('session_date, result, win_value').order('session_date', { ascending: true }),
    []
  )

  const byPlayer = useMemo(() => {
    if (!nightlyRows) return {}
    return groupByPlayer(nightlyRows)
  }, [nightlyRows])

  const playerSeries = useMemo(() => {
    const nights = byPlayer[player] || []
    return computeRollingSeries(nights)
  }, [byPlayer, player])

  // Caveats: coverage span + gap analysis per player, computed dynamically (not hardcoded).
  const coverageNotes = useMemo(() => {
    const notes = []
    const today = new Date()
    for (const p of ROSTER_PLAYERS) {
      const nights = byPlayer[p] || []
      if (nights.length === 0) {
        notes.push(`${p}: no nightly sleep data logged at all.`)
        continue
      }
      const first = nights[0].date
      const last = nights[nights.length - 1].date
      const lastDate = new Date(last)
      const daysSinceLast = Math.round((today.getTime() - lastDate.getTime()) / 86400000)
      // Count internal gaps > ROLLING_WINDOW_GAP_DAYS
      let gapCount = 0
      let maxGap = 0
      for (let i = 1; i < nights.length; i += 1) {
        const gap = (new Date(nights[i].date).getTime() - new Date(nights[i - 1].date).getTime()) / 86400000
        if (gap > ROLLING_WINDOW_GAP_DAYS) {
          gapCount += 1
          if (gap > maxGap) maxGap = gap
        }
      }
      const parts = [`${p}: logged ${nights.length} night(s), ${formatDate(first)} to ${formatDate(last)}`]
      if (daysSinceLast > 30) {
        parts.push(`no entries in the last ${daysSinceLast} days as of today — log appears to have stopped`)
      }
      if (gapCount > 0) {
        parts.push(`${gapCount} internal gap(s) of more than ${ROLLING_WINDOW_GAP_DAYS} calendar days (largest: ${Math.round(maxGap)} days)`)
      }
      notes.push(parts.join('; ') + '.')
    }
    return notes
  }, [byPlayer])

  // Chart 2 data: for each session with a result, compute team rolling-debt score,
  // bucket it, and compute win rate per bucket.
  const teamDebtBuckets = useMemo(() => {
    if (!sessions || Object.keys(byPlayer).length === 0) {
      return SLEEP_DEBT_BANDS.map((b) => ({ label: b.label, color: b.color, wins: 0, total: 0, winRate: 0 }))
    }
    const buckets = {}
    for (const b of SLEEP_DEBT_BANDS) buckets[b.label] = { label: b.label, color: b.color, wins: 0, total: 0 }

    for (const s of sessions) {
      if (!s.session_date || !s.result) continue
      const asOf = rollingAveragesAsOf(byPlayer, s.session_date)
      const available = Object.values(asOf).map((v) => v.rollingAvg)
      if (available.length === 0) continue // exclude session rather than guess
      const teamAvg = available.reduce((a, b) => a + b, 0) / available.length
      const label = bucketize(teamAvg, SLEEP_DEBT_BANDS)
      if (!label) continue
      buckets[label].total += 1
      const isWin = s.result === 'Win' || s.win_value > 0
      if (isWin) buckets[label].wins += 1
    }

    return SLEEP_DEBT_BANDS.map((b) => {
      const e = buckets[b.label]
      return { ...e, winRate: e.total > 0 ? Math.round((e.wins / e.total) * 1000) / 10 : 0 }
    })
  }, [sessions, byPlayer])

  const loading = nightlyLoading || sessLoading
  const error = nightlyError || sessError

  const hardGateCount = playerSeries.filter((p) => p.isHardGate).length
  const isolatedCount = playerSeries.filter((p) => p.isIsolatedDisruption).length

  return (
    <div>
      <div className="panel">
        <h2>Sleep Debt Analysis</h2>
        <p className="panel-caption">
          3-night rolling-average sleep debt per player, and how the team performs under cumulative
          sleep debt going into a session — as distinct from same-night sleep on game day
          (see Correlation Explorer's "Sleep vs Win Rate" panel for that cut). Rolling averages use
          the most recent <b>logged</b> nights for each player, not strict consecutive calendar
          nights, so a window built from a stale entry after a data gap is flagged rather than
          presented as if it reflects the last 3 nights.
        </p>

        {loading && <div className="loading-state">Loading nightly sleep and session data…</div>}
        {error && <div className="toast error">Error loading data: {error.message}</div>}
      </div>

      {!loading && !error && (
        <>
          <div className="panel">
            <h2>Rolling 3-Night Average — {player}</h2>
            <p className="panel-caption">
              Line color bands: green ≥7.5h optimal, yellow 7.0–7.5h minor debt, orange 6.5–7.0h
              moderate debt, red-orange 6.0–6.5h significant debt, red &lt;6.0h severe debt.
              Diamond markers = isolated bad night (single night &lt;6.5h while the rolling average is
              still ≥7.0h — acute impairment the average hides). Star markers = hard gate (single
              night &lt;{HARD_GATE_HOURS}h, critical regardless of average). Shaded bands = no data
              logged for that stretch (line breaks rather than connecting across the gap).
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

            {hardGateCount > 0 && (
              <div className="flag-banner critical">
                CRITICAL: {hardGateCount} hard-gate night(s) (&lt;{HARD_GATE_HOURS}h) logged for {player}.
              </div>
            )}
            {isolatedCount > 0 && (
              <div className="flag-banner amber">
                {isolatedCount} isolated-disruption night(s) for {player} — single night &lt;6.5h while
                the 3-night rolling average stayed ≥7.0h. Vibe/comms issues on these dates should not
                be attributed to mentality alone.
              </div>
            )}

            <RollingTrendChart series={playerSeries} />
          </div>

          <div className="panel">
            <h2>Team Performance Under Cumulative Sleep Debt</h2>
            <p className="panel-caption">
              For every session with a logged result, each available player's 3-night rolling average
              as of that session date is averaged across the roster (players with no rolling average
              near that date are excluded from that session's team score, not guessed), then bucketed
              into the same threshold bands used above. This is the <b>3-night cumulative debt going
              into game day</b> cut — contrast with Correlation Explorer's "Sleep vs Win Rate" panel,
              which uses same-night team_avg_sleep_hours only.
            </p>
            <DebtBucketBarChart data={teamDebtBuckets} />
          </div>

          <div className="panel">
            <h2>Coverage Caveats</h2>
            <p className="panel-caption">
              Computed directly from the current nightly_sleep data — will stay accurate as more rows
              are added. Do not assume a missing night was "normal"; rolling averages after a gap are
              built from the most recent logged nights, which may be materially older than 3 calendar
              days.
            </p>
            <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13, lineHeight: 1.6 }}>
              {coverageNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
