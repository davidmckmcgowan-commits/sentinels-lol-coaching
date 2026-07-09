import { useMemo, useState } from 'react'
import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ComposedChart, Line,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'
import {
  ROSTER_PLAYERS, SLEEP_DEBT_BANDS, sleepDebtColor, formatDate, bucketize,
} from '../lib/constants.js'
import { groupByPlayer } from '../lib/sleepDebt.js'
import {
  buildSessionTypeByDate, buildPlayerPerformanceSeries, averageByGroup,
  flagOverextensionCandidates,
} from '../lib/individualPerformance.js'

const SESSION_TYPE_ORDER = ['Green', 'Orange', 'Red', 'Official']

// ---- Chart 1: KDA over time, dot colored by 3-night rolling sleep band --------

function KdaTrendChart({ rows }) {
  const chartData = rows.map((r, idx) => ({
    idx,
    label: formatDate(r.date),
    date: r.date,
    kda: r.kda,
    champion: r.champion,
    rollingAvgSleep: r.rollingAvgSleep,
    sameNightSleepHours: r.sameNightSleepHours,
    opponentName: r.opponentName,
    seriesType: r.seriesType,
    sessionTypeLabel: r.sessionTypeLabel,
  }))

  if (chartData.length === 0) {
    return <div className="empty-state">No dated games found for this player.</div>
  }

  return (
    <div className="chart-wrap" style={{ height: 320 }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
          <XAxis dataKey="label" stroke="#9aa1ae" fontSize={10} minTickGap={30} />
          <YAxis stroke="#9aa1ae" fontSize={12} label={{ value: 'KDA', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
          <Tooltip
            contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
            formatter={(value, name, props) => {
              if (name === 'kda') {
                const d = props.payload
                const sleepBit = d.rollingAvgSleep != null
                  ? `3-night sleep avg: ${d.rollingAvgSleep}h`
                  : 'no 3-night sleep avg available'
                const sameNight = d.sameNightSleepHours != null ? ` (same-night: ${d.sameNightSleepHours}h)` : ''
                const typeBit = d.sessionTypeLabel ? `${d.seriesType} / ${d.sessionTypeLabel}` : `${d.seriesType} (unmatched to Green/Orange/Red/Official)`
                return [`${value} KDA on ${d.champion} vs ${d.opponentName} — ${typeBit} — ${sleepBit}${sameNight}`, 'KDA']
              }
              return [value, name]
            }}
          />
          <Line
            type="monotone"
            dataKey="kda"
            stroke="#d4a017"
            strokeWidth={1.5}
            dot={(props) => {
              const { cx, cy, payload } = props
              const color = sleepDebtColor(payload.rollingAvgSleep)
              return <circle key={`dot-${payload.idx}`} cx={cx} cy={cy} r={3} fill={color} stroke={color} />
            }}
            isAnimationActive={false}
            name="kda"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

// ---- Chart 2: avg KDA by sleep-debt band (same-night or 3-night rolling) ------

function KdaBySleepBandChart({ rows, mode }) {
  const data = useMemo(() => {
    const valueFn = mode === 'rolling' ? (r) => r.rollingAvgSleep : (r) => r.sameNightSleepHours
    const buckets = {}
    for (const b of SLEEP_DEBT_BANDS) buckets[b.label] = { label: b.label, color: b.color, sum: 0, n: 0 }
    for (const r of rows) {
      const sleepValue = valueFn(r)
      if (sleepValue == null) continue
      const label = bucketize(sleepValue, SLEEP_DEBT_BANDS)
      if (!label) continue
      buckets[label].sum += r.kda
      buckets[label].n += 1
    }
    return SLEEP_DEBT_BANDS.map((b) => {
      const e = buckets[b.label]
      return { ...e, avgKda: e.n > 0 ? Math.round((e.sum / e.n) * 100) / 100 : 0 }
    })
  }, [rows, mode])

  const anyData = data.some((d) => d.n > 0)

  return (
    <div className="chart-wrap">
      {!anyData ? (
        <div className="empty-state">
          No games could be matched to a {mode === 'rolling' ? '3-night rolling' : 'same-night'} sleep value.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
            <XAxis dataKey="label" stroke="#9aa1ae" fontSize={11} />
            <YAxis stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg KDA', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
            <Tooltip
              contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
              formatter={(value, name, props) => [`${value} avg KDA (n=${props.payload.n})`, 'Avg KDA']}
            />
            <Bar dataKey="avgKda" radius={[4, 4, 0, 0]}>
              {data.map((entry, idx) => (
                <Cell key={idx} fill={entry.color} />
              ))}
              <LabelList dataKey="avgKda" position="top" formatter={(v) => (v > 0 ? v : '')} fill="#e6e8ec" fontSize={11} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ---- Chart 3: avg KDA by SCRIM vs ESPORTS (native GRID split, full sample) ----

function ScrimVsEsportsChart({ rows }) {
  const data = useMemo(
    () => averageByGroup(rows, (r) => r.seriesType, (r) => r.kda).sort((a, b) => a.key.localeCompare(b.key)),
    [rows]
  )

  const esportsRow = data.find((d) => d.key === 'ESPORTS')
  const smallSample = esportsRow && esportsRow.n < 30

  return (
    <>
      {smallSample && (
        <div className="flag-banner amber">
          Small sample: only {esportsRow.n} ESPORTS games logged for this player. Treat any SCRIM-vs-ESPORTS
          gap here as directional, not conclusive — see Coverage Caveats below.
        </div>
      )}
      <div className="chart-wrap">
        {data.length === 0 ? (
          <div className="empty-state">No games available.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="key" stroke="#9aa1ae" fontSize={12} />
              <YAxis stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg KDA', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                formatter={(value, name, props) => [`${value} avg KDA (n=${props.payload.n})`, 'Avg KDA']}
              />
              <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill="#5b8def">
                <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v} (n=${data[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  )
}

// ---- Chart 4: avg KDA by Green/Orange/Red/Official (matched subset only) -----

function SessionTypeChart({ rows }) {
  const matchedRows = rows.filter((r) => r.sessionTypeLabel && !r.sessionTypeAmbiguous)
  const data = useMemo(
    () => averageByGroup(matchedRows, (r) => r.sessionTypeLabel, (r) => r.kda)
      .sort((a, b) => SESSION_TYPE_ORDER.indexOf(a.key) - SESSION_TYPE_ORDER.indexOf(b.key)),
    [matchedRows]
  )

  const totalScrimRows = rows.filter((r) => r.seriesType === 'SCRIM').length
  const matchRate = totalScrimRows > 0 ? Math.round((matchedRows.length / totalScrimRows) * 1000) / 10 : 0

  return (
    <>
      <div className="flag-banner amber">
        Only {matchedRows.length} of {totalScrimRows} SCRIM games for this player ({matchRate}%) could be
        matched to a Green/Orange/Red/Official label — GRID has no session id, so this is a date join
        against the sessions table, and most scrim dates aren&rsquo;t in both places. The rest are excluded
        here rather than guessed.
      </div>
      <div className="chart-wrap">
        {data.length === 0 ? (
          <div className="empty-state">No games matched to a session type for this player.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
              <XAxis dataKey="key" stroke="#9aa1ae" fontSize={11} />
              <YAxis stroke="#9aa1ae" fontSize={12} label={{ value: 'Avg KDA', angle: -90, position: 'insideLeft', fill: '#676f7d', fontSize: 11 }} />
              <Tooltip
                contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                formatter={(value, name, props) => [`${value} avg KDA (n=${props.payload.n})`, 'Avg KDA']}
              />
              <Bar dataKey="avg" radius={[4, 4, 0, 0]} fill="#8a6fd4">
                <LabelList dataKey="avg" position="top" formatter={(v, i) => `${v} (n=${data[i]?.n ?? ''})`} fill="#e6e8ec" fontSize={11} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  )
}

export default function IndividualPlayerPerformance() {
  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])
  const [sleepMode, setSleepMode] = useState('rolling') // 'rolling' | 'sameNight'

  const { data: gridRows, error: gridError, loading: gridLoading } = useSupabaseQuery(
    () => supabase
      .from('grid_player_games')
      .select('player, role, champion, kills, deaths, assists, net_worth, grid_games(game_number, sentinels_won, sentinels_kills, opponent_kills, grid_series_id, grid_series(series_date, series_type, opponent_name, sentinels_won))')
      .eq('is_sentinels', true)
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

  const sleepByPlayer = useMemo(() => (nightlyRows ? groupByPlayer(nightlyRows) : {}), [nightlyRows])
  const sessionTypeByDate = useMemo(() => (sessions ? buildSessionTypeByDate(sessions) : {}), [sessions])

  const playerRows = useMemo(() => {
    if (!gridRows) return []
    return buildPlayerPerformanceSeries({ rawRows: gridRows, player, sleepByPlayer, sessionTypeByDate })
  }, [gridRows, player, sleepByPlayer, sessionTypeByDate])

  const overextensionFlags = useMemo(() => flagOverextensionCandidates(playerRows), [playerRows])

  const loading = gridLoading || nightlyLoading || sessLoading
  const error = gridError || nightlyError || sessError

  const esportsCount = playerRows.filter((r) => r.seriesType === 'ESPORTS').length
  const scrimCount = playerRows.filter((r) => r.seriesType === 'SCRIM').length

  return (
    <div>
      <div className="panel">
        <h2>Individual Player Performance</h2>
        <p className="panel-caption">
          Per-player KDA and kill participation from GRID match data, cross-referenced against sleep
          (same-night and 3-night rolling average, using the same methodology as Sleep Debt Analysis) and
          against session intensity. Per A-R1, this view never compares one player&rsquo;s numbers to
          another&rsquo;s — each player is judged against their own trend only. Per A-R4, champion is shown
          on every game; a dip on an off-meta pick is not the same signal as a dip on a comfort pick.
        </p>
        {loading && <div className="loading-state">Loading GRID, sleep, and session data…</div>}
        {error && <div className="toast error">Error loading data: {error.message}</div>}
      </div>

      {!loading && !error && (
        <>
          <div className="panel">
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
            <p className="panel-caption">
              {playerRows.length} dated games for {player} ({scrimCount} SCRIM, {esportsCount} ESPORTS).
            </p>
          </div>

          <div className="panel">
            <h2>KDA Over Time — {player}</h2>
            <p className="panel-caption">
              Dot color follows the same sleep-debt bands as Sleep Debt Analysis (green optimal → red
              severe), based on the 3-night rolling average as of that game&rsquo;s date. Hover a point for
              champion, opponent, session type, and both same-night and rolling sleep figures.
            </p>
            <KdaTrendChart rows={playerRows} />
          </div>

          <div className="panel">
            <h2>KDA vs Sleep — {player}</h2>
            <p className="panel-caption">
              Average KDA bucketed by sleep-debt band. Toggle between same-night sleep on game day and the
              3-night rolling average — per S-R1, the rolling average is the more reliable readiness signal;
              same-night is shown for comparison, not as the primary read.
            </p>
            <div className="player-tabs" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className={`player-tab ${sleepMode === 'rolling' ? 'active' : ''}`}
                onClick={() => setSleepMode('rolling')}
              >
                3-night rolling avg
              </button>
              <button
                type="button"
                className={`player-tab ${sleepMode === 'sameNight' ? 'active' : ''}`}
                onClick={() => setSleepMode('sameNight')}
              >
                Same-night
              </button>
            </div>
            <KdaBySleepBandChart rows={playerRows} mode={sleepMode === 'rolling' ? 'rolling' : 'sameNight'} />
          </div>

          <div className="panel">
            <h2>SCRIM vs ESPORTS — {player}</h2>
            <p className="panel-caption">
              This is GRID&rsquo;s native, always-available split (no date-join risk). Use this as the
              primary read on whether performance holds up on stage; use the Green/Orange/Red/Official cut
              below as a secondary, lower-coverage view.
            </p>
            <ScrimVsEsportsChart rows={playerRows} />
          </div>

          <div className="panel">
            <h2>Green / Orange / Red / Official — {player}</h2>
            <p className="panel-caption">
              Secondary cut, built by joining GRID&rsquo;s series date to your internal sessions table.
              Coverage is partial (see the match-rate note below the chart) — treat this as a supplementary
              signal, not the primary stage-performance read.
            </p>
            <SessionTypeChart rows={playerRows} />
          </div>

          <div className="panel">
            <h2>Overextension Candidates (Weak Signal) — {player}</h2>
            <p className="panel-caption">
              GRID&rsquo;s Series Events product (kill/death timing and positions) is not included in the
              current Open Access API key, so true &ldquo;over-chasing / giving body&rdquo; detection isn&rsquo;t
              possible from this data. As a coarse proxy, games below are flagged where {player} died
              {' '}5+ times, deaths outnumbered kills by 3+, and the game was lost. This is not a validated
              measurement of over-extension — it&rsquo;s a starting point for manual review, nothing more.
            </p>
            {overextensionFlags.length === 0 ? (
              <div className="empty-state">No games matched this coarse pattern for {player}.</div>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Champion</th>
                      <th>Opponent</th>
                      <th>K/D/A</th>
                      <th>Session</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overextensionFlags.map((r, i) => (
                      <tr key={i}>
                        <td>{formatDate(r.date)}</td>
                        <td>{r.champion}</td>
                        <td>{r.opponentName}</td>
                        <td>{r.kills}/{r.deaths}/{r.assists}</td>
                        <td>{r.seriesType}{r.sessionTypeLabel ? ` / ${r.sessionTypeLabel}` : ''}</td>
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
                GRID series-type is SCRIM/ESPORTS only. Green/Orange/Red/Official comes from a date join to
                the sessions table with roughly 13% overall match coverage (93 of 706 GRID series dates) —
                most scrim dates simply aren&rsquo;t in both places, so the Green/Orange/Red/Official chart
                above will show a smaller n than SCRIM vs ESPORTS.
              </li>
              <li>
                A few matched dates had more than one session_type logged (e.g. Green then Orange same day)
                and are excluded from the Green/Orange/Red/Official chart as ambiguous rather than guessed.
              </li>
              <li>
                ESPORTS sample size is small across the whole roster (28 series total, since this roster
                formed mid-January 2026 and has only played one full season plus Americas Cup / Esports
                World Cup Qualifier). Any SCRIM-vs-ESPORTS gap should be read as directional, not conclusive.
              </li>
              <li>
                KDA and kill participation don&rsquo;t control for champion or matchup difficulty — always
                check the champion shown on hover before reading a dip as a performance issue rather than a
                hard matchup or off-meta pick.
              </li>
              <li>
                Sleep figures use the same 3-night rolling methodology as Sleep Debt Analysis: most recent
                logged nights, not strict calendar nights, with stale windows still included but not
                specially flagged in this view (see Sleep Debt Analysis for that detail per player).
              </li>
            </ul>
          </div>
        </>
      )}
    </div>
  )
}
