import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { ROSTER_PLAYERS, SEASON_CUTOFF_DATE, SEASON_CUTOFF_LABEL, formatDate, opponentTier } from '../lib/constants.js'
import { groupByPlayer } from '../lib/sleepDebt.js'
import { buildSessionTypeByDate, buildPlayerPerformanceSeries } from '../lib/individualPerformance.js'
import {
  buildOpponentNetWorthByGameRole, attachNetWorthDiff, computePerformanceIndex, attachDaySequence,
} from '../lib/performanceIndex.js'
import { attachPriorGameGood, computeConditionCards } from '../lib/patternMining.js'
import {
  computeCurrentStatus, buildStandingProtocol, computeTeamActivationSummary, computeCurrentSeasonSummary,
} from '../lib/interventions.js'

function todayDateString() {
  return new Date().toISOString().slice(0, 10)
}

const STATUS_LABEL = {
  ok: 'On track',
  watch: 'Watch',
  amber: 'Flag',
  critical: 'CRITICAL',
  unknown: 'No recent data',
}
const STATUS_CLASS = {
  ok: 'flag-good',
  watch: 'flag-amber',
  amber: 'flag-amber',
  critical: 'flag-critical',
  unknown: '',
}

function CurrentStatusCard({ label, level, detail }) {
  return (
    <div className={`stat-card ${STATUS_CLASS[level] ?? ''}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" style={{ fontSize: 18 }}>{STATUS_LABEL[level] ?? 'Unknown'}</div>
      <div className="stat-sub">{detail}</div>
    </div>
  )
}

function InterventionCard({ item, player }) {
  const cls = item.status === 'confirmed-risk' ? 'risk' : item.status === 'confirmed-benefit' ? 'benefit' : 'unconfirmed'
  const tag = item.status === 'confirmed-risk' ? 'Confirmed risk for ' + player
    : item.status === 'confirmed-benefit' ? 'Confirmed benefit for ' + player
    : 'Not yet confirmed for ' + player

  let evidence = null
  if (item.status === 'confirmed-risk' && item.badCard) {
    const c = item.badCard
    evidence = `Official-day evidence: ${c.pGood}% good vs ${c.baseline}% baseline (${c.lift > 0 ? '+' : ''}${c.lift} pts, n=${c.n}).`
  } else if (item.status === 'confirmed-benefit' && item.goodCard) {
    const c = item.goodCard
    evidence = `Official-day evidence: ${c.pGood}% good vs ${c.baseline}% baseline (${c.lift > 0 ? '+' : ''}${c.lift} pts, n=${c.n}).`
  } else {
    const relevant = item.badCard?.insufficientData ? item.badCard : item.goodCard
    evidence = relevant
      ? `Not enough Official-day games yet for ${player} on this axis (n=${relevant.n} vs n=${relevant.nOther} — need 5+ on both sides). Standing recommendation below is from general sleep/performance-psych research, not this player's own official-day sample yet.`
      : `No Official-day read on this axis yet for ${player}. Standing recommendation below is from general research, not this player's own sample.`
  }

  return (
    <div className={`intervention-card ${cls}`}>
      <div className="intervention-tag">{tag}</div>
      <div className="intervention-title">{item.intervention.title}</div>
      <div className="intervention-evidence">{evidence}</div>
      <div className="intervention-how">{item.intervention.how}</div>
      {item.tdcsNote && <div className="intervention-tdcs">tDCS priority for {player}: {item.tdcsNote}</div>}
    </div>
  )
}

export default function Interventions() {
  const [player, setPlayer] = useState(ROSTER_PLAYERS[0])

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
  const { data: dailyEntries, error: dailyError, loading: dailyLoading } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('daily_entries').select('player, entry_date, vibe_check')),
    []
  )

  const loading = gridLoading || nightlyLoading || sessLoading || dailyLoading
  const error = gridError || nightlyError || sessError || dailyError

  const sleepByPlayer = useMemo(() => (nightlyRows ? groupByPlayer(nightlyRows) : {}), [nightlyRows])
  const sessionTypeByDate = useMemo(() => (sessions ? buildSessionTypeByDate(sessions) : {}), [sessions])
  const sentinelsRawRows = useMemo(() => (allGridRows ? allGridRows.filter((r) => r.is_sentinels) : []), [allGridRows])
  const opponentNetWorthByGameRole = useMemo(
    () => (allGridRows ? buildOpponentNetWorthByGameRole(allGridRows) : new Map()),
    [allGridRows]
  )

  // Build every player's scored rows once, so the "current status" cards can
  // work off real data regardless of which player tab is selected.
  const scoredRowsByPlayer = useMemo(() => {
    if (!allGridRows) return {}
    const out = {}
    for (const p of ROSTER_PLAYERS) {
      const base = buildPlayerPerformanceSeries({ rawRows: sentinelsRawRows, player: p, sleepByPlayer, sessionTypeByDate })
      const withNetWorth = attachNetWorthDiff(base, opponentNetWorthByGameRole)
      // Baselines frozen to the pre-Split-2 body of work (see constants.js) —
      // Current Season Tracking below depends on this NOT including the
      // current-season rows it's being compared against.
      const scored = computePerformanceIndex(withNetWorth, { baselineCutoffDate: SEASON_CUTOFF_DATE })
      out[p] = attachDaySequence(scored)
    }
    return out
  }, [allGridRows, sentinelsRawRows, sleepByPlayer, sessionTypeByDate, opponentNetWorthByGameRole])

  const playerRows = scoredRowsByPlayer[player] ?? []

  // computeConditionCards' high_vibe/low_vibe/tough_matchup/easier_matchup
  // conditions read r.vibe and r.tier — buildPlayerPerformanceSeries doesn't
  // set those (it doesn't know about daily_entries or the opponent-tier
  // table), so they have to be attached here the same way
  // IndividualPlayerPerformance.jsx does it, or every vibe/matchup condition
  // silently reads as "insufficient data" instead of a real pattern.
  const vibeByDateForPlayer = useMemo(() => {
    const map = new Map()
    for (const e of dailyEntries ?? []) {
      if (e.player === player && e.entry_date != null && e.vibe_check != null) {
        map.set(e.entry_date, e.vibe_check)
      }
    }
    return map
  }, [dailyEntries, player])

  const officialRows = useMemo(() => {
    const withVibeAndTier = playerRows.map((r) => ({
      ...r,
      vibe: r.date && vibeByDateForPlayer.has(r.date) ? vibeByDateForPlayer.get(r.date) : null,
      tier: opponentTier(r.opponentName),
    }))
    return attachPriorGameGood(withVibeAndTier).filter((r) => r.seriesType === 'ESPORTS')
  }, [playerRows, vibeByDateForPlayer])
  const officialConditionCards = useMemo(
    () => computeConditionCards(officialRows, undefined, player).cards,
    [officialRows, player]
  )
  const standingProtocol = useMemo(() => buildStandingProtocol(officialConditionCards, player), [officialConditionCards, player])

  const currentStatus = useMemo(
    () => computeCurrentStatus({ player, sleepByPlayer, dailyEntries: dailyEntries ?? [], scoredRows: playerRows, asOfDate: todayDateString() }),
    [player, sleepByPlayer, dailyEntries, playerRows]
  )

  const confirmedRiskCount = standingProtocol.filter((i) => i.status === 'confirmed-risk').length

  const teamActivation = useMemo(() => computeTeamActivationSummary(scoredRowsByPlayer), [scoredRowsByPlayer])
  const currentSeason = useMemo(() => computeCurrentSeasonSummary(scoredRowsByPlayer, SEASON_CUTOFF_DATE), [scoredRowsByPlayer])

  return (
    <div>
      {!loading && !error && (
        <div className="panel">
          <h2>Current Season Tracking — {SEASON_CUTOFF_LABEL}</h2>
          <p className="panel-caption">
            Champion/role baselines below are frozen to games through {formatDate(SEASON_CUTOFF_DATE)} (everything
            before Split 2 practice resumed) — every game from {formatDate(SEASON_CUTOFF_DATE)} onward is scored
            against that fixed reference rather than a baseline that keeps absorbing the very games being judged.
            That's the honest way to answer &ldquo;is potential increasing right now&rdquo; instead of a number
            that can never move much because the yardstick keeps redrawing itself around it. Samples since Jul 7
            are still small, so read these as early reads, not verdicts.
          </p>
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Baseline (through {formatDate(SEASON_CUTOFF_DATE)})</th>
                <th>Current Season (since Jul 7)</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {currentSeason.map((p) => (
                <tr key={p.player}>
                  <td>{p.player}</td>
                  <td>{p.baselinePGood != null ? `${p.baselinePGood}% good (n=${p.baselineN})` : `n=${p.baselineN}`}</td>
                  <td>{p.currentPGood != null ? `${p.currentPGood}% good (${p.currentLow}–${p.currentHigh}%, n=${p.currentN})` : `n=${p.currentN}, not enough data yet`}</td>
                  <td>{p.delta != null ? `${p.delta > 0 ? '+' : ''}${p.delta} pts` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !error && (
        <div className="panel">
          <h2>Team-Wide: Practice Activation</h2>
          <p className="panel-caption">
            A process-level finding (2026-07-13), not a per-player read — this showed up the same way for
            everyone. Every player scores dramatically better in Officials than Scrims on their own history, and
            it isn&rsquo;t explained by champion-pool selection alone, opponent tier, or the internal
            Green/Orange/Red intensity label (all three were tested and ruled out or only partial). That points
            away from stage-day &ldquo;interference&rdquo; (choking) and toward routine practice under-activating
            the same potential real stakes bring out. Separately, month-by-month Scrim performance rises through
            the Lock-In (Jan 24-Mar 1) and Americas Cup (Mar 4-8) window and fully reverts to January-level
            baseline by May, in lockstep across the roster — performance so far looks event-driven rather than a
            durable, compounding improvement. There&rsquo;s also a complete data gap for June, so treat the most
            recent numbers as provisional until that&rsquo;s backfilled.
          </p>
          <table>
            <thead>
              <tr>
                <th>Player</th>
                <th>Official — % good (95% CI, n)</th>
                <th>Scrim — % good (95% CI, n)</th>
                <th>Gap</th>
              </tr>
            </thead>
            <tbody>
              {teamActivation.perPlayer.map((p) => (
                <tr key={p.player}>
                  <td>{p.player}</td>
                  <td>{p.officialPGood != null ? `${p.officialPGood}% (${p.officialLow}–${p.officialHigh}%, n=${p.officialN})` : `n=${p.officialN}, not enough data`}</td>
                  <td>{p.scrimPGood != null ? `${p.scrimPGood}% (${p.scrimLow}–${p.scrimHigh}%, n=${p.scrimN})` : `n=${p.scrimN}, not enough data`}</td>
                  <td>{p.gap != null ? `${p.gap > 0 ? '+' : ''}${p.gap} pts` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel-caption" style={{ marginTop: 14 }}>
            Does the Green/Orange/Red practice-intensity label actually predict anything? Pooled across the whole
            roster (a process check, not a player comparison):
          </p>
          <table>
            <thead>
              <tr>
                <th>Session Type</th>
                <th>% good (95% CI, n)</th>
              </tr>
            </thead>
            <tbody>
              {teamActivation.sessionTypeRows.map((s) => (
                <tr key={s.label}>
                  <td>{s.label}</td>
                  <td>{s.pGood != null ? `${s.pGood}% (${s.low}–${s.high}%, n=${s.n})` : `n=${s.n}, not enough data`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="panel-caption" style={{ marginTop: 10 }}>
            If these three rows come back statistically flat, that&rsquo;s the finding: the label isn&rsquo;t
            currently producing a measurable difference in output, which is worth an audit of what actually
            happens differently in a Red session versus a Green one. The practical lever this points to is
            building real stakes into routine practice (internal scoring, consequences, standings) rather than
            relying on the event calendar to supply intensity.
          </p>
        </div>
      )}

      <div className="player-tabs">
        {ROSTER_PLAYERS.map((p) => (
          <button key={p} type="button" className={`player-tab ${player === p ? 'active' : ''}`} onClick={() => setPlayer(p)}>
            {p}
          </button>
        ))}
      </div>

      {loading && <div className="empty-state">Loading…</div>}
      {error && <div className="flag-banner critical">Error loading data: {error.message ?? String(error)}</div>}

      {!loading && !error && (
        <>
          <div className="panel">
            <h2>Pre-Official Interventions — {player}</h2>
            <p className="panel-caption">
              What coaching staff should be doing for {player} in the 3-5 days before an Official, built from two
              things: a live read of where {player} stands right now on Sleep, Vibe, and Champion Pool discipline
              (the axes that actually have a &ldquo;current value&rdquo;), and a standing protocol of research-backed
              interventions — only labeled a confirmed risk or benefit where {player}&rsquo;s own Official-day data
              (Evidence-Based Patterns, Official Only scope) actually shows a real pattern, not just noise. Per A-R1,
              nothing here compares {player} to any other player.
            </p>
          </div>

          <div className="panel">
            <h2>Current Status — {player}</h2>
            <p className="panel-caption">Right now, based on the most recently logged data.</p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <CurrentStatusCard
                label="Sleep (3-night rolling)"
                level={currentStatus.sleep.level}
                detail={
                  currentStatus.sleep.rollingAvg != null
                    ? `${currentStatus.sleep.rollingAvg}h as of ${formatDate(currentStatus.sleep.asOfDate)}${currentStatus.sleep.latestNightHours != null && currentStatus.sleep.latestNightHours < 5 ? ' — a logged night under 5h is a hard gate, no tDCS today' : ''}`
                    : 'No sleep data logged yet.'
                }
              />
              <CurrentStatusCard
                label="Vibe (avg of last 3 entries)"
                level={currentStatus.vibe.level}
                detail={currentStatus.vibe.avg != null ? `${currentStatus.vibe.avg} avg over ${currentStatus.vibe.n} entr${currentStatus.vibe.n === 1 ? 'y' : 'ies'}, most recent ${formatDate(currentStatus.vibe.lastDate)}` : 'No vibe check logged yet.'}
              />
              <CurrentStatusCard
                label="Champion Pool (last 8 games)"
                level={currentStatus.championPool.level}
                detail={
                  currentStatus.championPool.n > 0
                    ? `${currentStatus.championPool.offMetaCount} of ${currentStatus.championPool.n} recent games on an off-meta/thin-sample pick${currentStatus.championPool.recentOffMetaChampions.length > 0 ? ` (${currentStatus.championPool.recentOffMetaChampions.join(', ')})` : ''}`
                    : 'No recent scored games.'
                }
              />
            </div>
          </div>

          <div className="panel">
            <h2>Standing Pre-Official Protocol — {player}</h2>
            <p className="panel-caption">
              {confirmedRiskCount > 0
                ? `${confirmedRiskCount} confirmed risk${confirmedRiskCount === 1 ? '' : 's'} for ${player} specifically, shown first.`
                : `No confirmed Official-day risks for ${player} yet in this data — the items below are general standing guidance.`}
            </p>
            {standingProtocol.map((item) => (
              <InterventionCard key={item.id} item={item} player={player} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
