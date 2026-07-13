// Turns the already-validated Evidence-Based Patterns findings (patternMining.js)
// into something coaching staff can actually act on in the 3-5 days before an
// Official: (1) a live read of where each player stands RIGHT NOW on the axes
// that have a meaningful "current state", and (2) a standing protocol of
// research-grounded interventions, only surfaced where this specific player's
// OWN official-scoped data shows a real (not-noise) pattern — per A-R1, this
// never compares players to each other, and per the same significance rule
// used in the Evidence-Based Patterns panel (baseline outside the condition's
// own 95% CI = real, inside = could be noise).
//
// Two things do NOT get a "current status" reading, on purpose: Day-of-Block
// Fatigue and Series Fatigue/Momentum are structural (about what happens
// during a scrim block or series), not slowly-changing states like sleep or
// vibe — there's no "current value" for them, so they only appear in the
// standing protocol, not the live checklist.

import { rollingAveragesAsOf } from './sleepDebt.js'
import { SLEEP_DEBT_BANDS, sleepDebtColor } from './constants.js'
import { wilsonInterval } from './patternMining.js'

// From CLAUDE.md's tDCS priority list (as of 2026-07-12). TBD for the rest of
// the roster pending first sessions — don't invent an assignment for them.
export const TDCS_PRIORITY_BY_PLAYER = {
  DARKWINGS: 'Protocol 1 (rDLPFC) — stress/working-memory degradation pattern, multiple vibe-3 flags under pressure.',
  Impact: 'Protocol 1 (rDLPFC) — high cognitive load; lateness pattern may indicate a readiness issue worth pairing this with.',
}

// One entry per axis. badKey/goodKey are condition keys from
// patternMining.js's buildStandardConditions().
export const INTERVENTION_AXES = [
  {
    id: 'sleep',
    label: 'Sleep',
    badKey: 'sleep_debt',
    goodKey: 'well_rested',
    hasCurrentStatus: true,
    intervention: {
      title: 'Protect sleep in the 3 nights before the official',
      how: 'Per S-R8: 3-night rolling avg below 6.5h is a flag, below 6.0h is a red flag, and any single night under 5h is a hard gate — no tDCS/stimulation that day. Move sessions earlier and protect wind-down time rather than shifting to the nearest open calendar slot.',
    },
  },
  {
    id: 'vibe',
    label: 'Vibe / Mood',
    badKey: 'low_vibe',
    goodKey: 'high_vibe',
    hasCurrentStatus: true,
    intervention: {
      title: 'Rule out sleep before treating it as mentality',
      how: 'Per S-R4/S-R7: one night of sleep restriction raises amygdala reactivity ~60% (Yoo & Walker 2007) and emotional regulation degrades before working memory — check 3-night sleep first. If sleep is fine and vibe is still low, Mindfulness-Acceptance-Commitment (MAC) technique or a scripted, pre-trained self-talk cue (Hatzigeorgiadis 2011) works better than anything improvised on game day.',
    },
  },
  {
    id: 'champion_pool',
    label: 'Champion Pool Discipline',
    badKey: 'off_meta_pick',
    goodKey: 'comfort_pick',
    hasCurrentStatus: true,
    intervention: {
      title: 'Lock champion pool discipline before the official',
      how: "Don't debut or start a thin-sample pick (fewer than 3 logged games) in an official. If a new pick is strategically necessary, get 3+ reps in scrims first — targeted, isolated scenario practice on that exact pick, not just more general practice volume (esports-specific finding: raw practice volume barely predicts performance, isolated repeated scenario practice does).",
    },
  },
  {
    id: 'day_position',
    label: "Day-of-Block Fatigue",
    badKey: 'late_in_day',
    goodKey: 'early_in_day',
    hasCurrentStatus: false,
    intervention: {
      title: 'Watch same-day scrim-block length',
      how: 'Where late-day fatigue shows up for a player, cap or rotate out of long same-day scrim blocks before the game it appears at, and use the Cognitive Cooldown habit between games.',
    },
  },
  {
    id: 'series_position',
    label: 'Series Fatigue',
    badKey: 'late_series',
    goodKey: 'series_opener',
    hasCurrentStatus: false,
    intervention: {
      title: 'Prioritize a strong series opener',
      how: 'A fixed pre-performance routine before Game 1 of a series raises the odds of a strong opener (Mesagno & Mullane-Grant 2010) — more valuable than trying to prevent late-series fade after the fact.',
    },
  },
  {
    id: 'momentum',
    label: 'Momentum / Tilt Recovery',
    badKey: 'after_rough_game',
    goodKey: 'after_good_game',
    hasCurrentStatus: false,
    intervention: {
      title: 'Protect momentum rather than firefighting tilt',
      how: 'Standard reset breathing between games is usually enough after one rough game. If a player tends to carry a loss into the next game, attribution/reframing training — treating the loss as specific and temporary rather than global — is the targeted fix.',
    },
  },
  {
    id: 'matchup',
    label: 'Matchup Difficulty',
    badKey: 'tough_matchup',
    goodKey: 'easier_matchup',
    hasCurrentStatus: false,
    intervention: {
      title: 'Prep harder for Tier 4-5 opponents',
      how: "Pull this player's own reflection notes logged against that specific opponent before the official (per A-R7). Stress mindset / arousal reappraisal training (Jamieson SAR) — already tested directly on esports players under pressure — reframes matchup pressure as fuel instead of threat.",
    },
  },
]

// Cross-references this player's OFFICIAL-scoped condition cards (already
// computed by computeConditionCards) against the axis list above. "Real"
// uses the exact same rule as the Evidence-Based Patterns tile verdicts:
// card.significant + card.direction. Sorts confirmed risks first (the most
// actionable), confirmed benefits next (protect what's working), then
// axes with no confirmed pattern yet for this player.
export function buildStandingProtocol(officialCards, player) {
  const cardByKey = Object.fromEntries((officialCards ?? []).map((c) => [c.key, c]))
  const items = INTERVENTION_AXES.map((axis) => {
    const badCard = cardByKey[axis.badKey] ?? null
    const goodCard = cardByKey[axis.goodKey] ?? null
    const badReal = !!(badCard && badCard.significant && badCard.direction === 'worse')
    const goodReal = !!(goodCard && goodCard.significant && goodCard.direction === 'better')
    const status = badReal ? 'confirmed-risk' : goodReal ? 'confirmed-benefit' : 'unconfirmed'
    return {
      ...axis,
      status,
      badCard,
      goodCard,
      tdcsNote: (axis.id === 'sleep' || axis.id === 'vibe') ? TDCS_PRIORITY_BY_PLAYER[player] ?? null : null,
    }
  })
  const order = { 'confirmed-risk': 0, 'confirmed-benefit': 1, unconfirmed: 2 }
  return items.sort((a, b) => order[a.status] - order[b.status])
}

// Live read of where a player stands right now on Sleep / Vibe / Champion
// Pool — the three axes where a "current value" actually means something.
// `scoredRows` should be this player's full performanceIndex-scored rows
// (any scope), already sorted by date ascending (buildPlayerPerformanceSeries
// sorts that way).
export function computeCurrentStatus({ player, sleepByPlayer, dailyEntries, scoredRows, asOfDate }) {
  const nights = sleepByPlayer[player] || []
  const latestNight = nights.length > 0 ? nights[nights.length - 1] : null
  const rollingInfo = rollingAveragesAsOf(sleepByPlayer, asOfDate)[player] ?? null

  let sleepLevel = 'unknown'
  if (latestNight && latestNight.hours < 5) sleepLevel = 'critical' // hard gate, S-R8
  else if (rollingInfo) {
    const band = SLEEP_DEBT_BANDS.find((b) => rollingInfo.rollingAvg >= b.min && rollingInfo.rollingAvg < b.max) ?? SLEEP_DEBT_BANDS[SLEEP_DEBT_BANDS.length - 1]
    if (band.label.includes('severe') || band.label.includes('significant')) sleepLevel = 'critical'
    else if (band.label.includes('moderate')) sleepLevel = 'amber'
    else sleepLevel = 'ok'
  }
  const sleep = {
    level: sleepLevel,
    rollingAvg: rollingInfo?.rollingAvg ?? null,
    asOfDate: rollingInfo?.asOfDate ?? null,
    latestNightHours: latestNight?.hours ?? null,
    color: rollingInfo ? sleepDebtColor(rollingInfo.rollingAvg) : '#5a606c',
  }

  const playerVibeEntries = (dailyEntries || [])
    .filter((e) => e.player === player && e.vibe_check != null)
    .sort((a, b) => (a.entry_date < b.entry_date ? -1 : a.entry_date > b.entry_date ? 1 : 0))
  const recentVibe = playerVibeEntries.slice(-3)
  const vibeAvg = recentVibe.length > 0 ? Math.round((recentVibe.reduce((s, e) => s + e.vibe_check, 0) / recentVibe.length) * 10) / 10 : null
  const vibeLevel = vibeAvg == null ? 'unknown' : vibeAvg <= 3 ? 'critical' : vibeAvg <= 5 ? 'amber' : vibeAvg >= 7 ? 'ok' : 'watch'
  const vibe = {
    level: vibeLevel,
    avg: vibeAvg,
    n: recentVibe.length,
    lastDate: recentVibe.length > 0 ? recentVibe[recentVibe.length - 1].entry_date : null,
  }

  const scored = (scoredRows || []).filter((r) => r.performanceIndex != null)
  const recentGames = scored.slice(-8)
  const offMetaCount = recentGames.filter((r) => r.baselineSource === 'role').length
  const championPoolLevel = recentGames.length === 0 ? 'unknown' : offMetaCount >= 3 ? 'critical' : offMetaCount >= 1 ? 'amber' : 'ok'
  const championPool = {
    level: championPoolLevel,
    offMetaCount,
    n: recentGames.length,
    recentOffMetaChampions: recentGames.filter((r) => r.baselineSource === 'role').map((r) => r.champion),
  }

  return { sleep, vibe, championPool }
}

// Team-wide "Practice Activation" summary (2026-07-13 finding). Distinct from
// everything else in this file: this is NOT a per-player risk/benefit read.
// It's a process-level finding that showed up the same way for every player,
// so it's surfaced once, above the player tabs, rather than duplicated five
// times. See project_lol_coaching_app memory for the full write-up and the
// Lock-In (Jan 24-Mar 1 2026) / Americas Cup (Mar 4-8 2026) date cross-check.
//
// `scoredRowsByPlayer` is { [player]: rows[] } where each row already has
// performanceIndex, seriesType ('SCRIM'|'ESPORTS'), sessionTypeLabel
// (Green/Orange/Red/Mixed/Official), and sessionTypeAmbiguous.
export function computeTeamActivationSummary(scoredRowsByPlayer) {
  const perPlayer = Object.entries(scoredRowsByPlayer).map(([player, rows]) => {
    const scored = (rows || []).filter((r) => r.performanceIndex != null)
    const official = scored.filter((r) => r.seriesType === 'ESPORTS')
    const scrim = scored.filter((r) => r.seriesType === 'SCRIM')
    const officialCi = wilsonInterval(official.filter((r) => r.performanceIndex > 50).length, official.length)
    const scrimCi = wilsonInterval(scrim.filter((r) => r.performanceIndex > 50).length, scrim.length)
    return {
      player,
      officialN: official.length,
      officialPGood: officialCi.point,
      officialLow: officialCi.low,
      officialHigh: officialCi.high,
      scrimN: scrim.length,
      scrimPGood: scrimCi.point,
      scrimLow: scrimCi.low,
      scrimHigh: scrimCi.high,
      gap: officialCi.point != null && scrimCi.point != null ? Math.round((officialCi.point - scrimCi.point) * 10) / 10 : null,
    }
  })

  // Whether the internal Green/Orange/Red practice-intensity LABEL itself
  // predicts anything — a team-level process question about how practice is
  // run, not a per-player comparison, so pooling everyone's rows here doesn't
  // violate A-R1 (nobody is being ranked against anybody).
  const allScrimRows = Object.values(scoredRowsByPlayer)
    .flat()
    .filter((r) => r.performanceIndex != null && r.seriesType === 'SCRIM' && !r.sessionTypeAmbiguous)
  const bySessionType = {}
  for (const r of allScrimRows) {
    if (!r.sessionTypeLabel || r.sessionTypeLabel.startsWith('Mixed')) continue
    if (!bySessionType[r.sessionTypeLabel]) bySessionType[r.sessionTypeLabel] = []
    bySessionType[r.sessionTypeLabel].push(r)
  }
  const sessionTypeRows = ['Green', 'Orange', 'Red'].map((label) => {
    const rows = bySessionType[label] || []
    const ci = wilsonInterval(rows.filter((r) => r.performanceIndex > 50).length, rows.length)
    return { label, n: rows.length, pGood: ci.point, low: ci.low, high: ci.high }
  })

  return { perPlayer, sessionTypeRows }
}

// Is Split 2 practice (2026-07-07 onward) actually better than the frozen
// baseline, or does it just look that way because the baseline itself keeps
// absorbing the newest games? Requires rows to have been scored with
// computePerformanceIndex's baselineCutoffDate option (see performanceIndex.js)
// — otherwise this is comparing current-season rows against a baseline that
// includes them, which is exactly the circularity this is meant to avoid.
export function computeCurrentSeasonSummary(scoredRowsByPlayer, cutoffDate) {
  return Object.entries(scoredRowsByPlayer).map(([player, rows]) => {
    const scored = (rows || []).filter((r) => r.performanceIndex != null)
    const baseline = scored.filter((r) => r.date && r.date <= cutoffDate)
    const current = scored.filter((r) => r.date && r.date > cutoffDate)
    const baselineCi = wilsonInterval(baseline.filter((r) => r.performanceIndex > 50).length, baseline.length)
    const currentCi = wilsonInterval(current.filter((r) => r.performanceIndex > 50).length, current.length)
    return {
      player,
      baselineN: baseline.length,
      baselinePGood: baselineCi.point,
      currentN: current.length,
      currentPGood: currentCi.point,
      currentLow: currentCi.low,
      currentHigh: currentCi.high,
      delta: baselineCi.point != null && currentCi.point != null ? Math.round((currentCi.point - baselineCi.point) * 10) / 10 : null,
    }
  })
}
