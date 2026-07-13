// Performance = Potential - Interference (Gallwey's "Inner Game" model),
// layered on top of the Performance Index already computed in performanceIndex.js.
//
// Potential (P): a player's own ceiling, estimated as the average Performance
// Index across their own top-decile scored games. Per A-R1, this is always the
// player's own history — never another player's numbers, never a league bar.
//
// Interference (I) per game = Potential - that game's Performance Index. A
// negative value just means the player exceeded their own "ceiling" estimate
// that game (a great day) — not an error, and not clamped to zero, since a
// clean run of great games should be allowed to revise the estimate over time.
//
// This file deliberately does NOT attempt a full causal decomposition (e.g.
// "40% of this game's interference is sleep, 30% is stage fear") — that would
// overstate what per-game aggregate stats can prove. Instead, games are grouped
// by CONTEXT (sleep-debt night, Official/stage, post-bad-game recovery,
// late-series fatigue) and average Interference is compared within each
// context. Where the gap concentrates is the signal, not a precise attribution
// — and a portion of interference is expected to stay unexplained (skill,
// motivation, conflict — see the manual tagging flow), not attributed to a
// context just because a number is available.

const MIN_GAMES_FOR_POTENTIAL = 5
const MIN_GAMES_FOR_CONTEXT = 3
// A gap of this many Index points between two contexts is treated as a
// meaningful pattern worth surfacing as a tDCS-relevant flag, not noise.
const FLAG_THRESHOLD = 8

function mean(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  if (v.length === 0) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

// Potential = average Performance Index across this player's own top-decile
// scored games (default: top 10%, minimum 1 game). Requires at least
// MIN_GAMES_FOR_POTENTIAL scored games before it's considered reliable.
export function computePotential(scoredRows, { decileFraction = 0.1 } = {}) {
  const withIndex = scoredRows.filter((r) => r.performanceIndex != null)
  if (withIndex.length < MIN_GAMES_FOR_POTENTIAL) {
    return { potential: null, n: withIndex.length, insufficientData: true }
  }
  const sorted = [...withIndex].sort((a, b) => b.performanceIndex - a.performanceIndex)
  const topN = Math.max(1, Math.round(sorted.length * decileFraction))
  const top = sorted.slice(0, topN)
  const potential = top.reduce((sum, r) => sum + r.performanceIndex, 0) / top.length
  return {
    potential: Math.round(potential * 10) / 10,
    n: withIndex.length,
    topN,
    insufficientData: false,
  }
}

// Attach interference = potential - performanceIndex to every row.
export function attachInterference(rows, potential) {
  if (potential == null) return rows.map((r) => ({ ...r, interference: null }))
  return rows.map((r) => ({
    ...r,
    interference: r.performanceIndex != null ? Math.round((potential - r.performanceIndex) * 10) / 10 : null,
  }))
}

// Identify contexts where average Interference is meaningfully elevated, and
// map each to the tDCS protocol whose research actually targets that context
// — grounded in the tdcs-sleep-research folder, evidence AND caveats included.
// This never auto-recommends a protocol; it surfaces a pattern for a coach to
// weigh, with the supporting and complicating evidence attached.
export function computeTdcsPatternFlags(rows, tiltResult) {
  const withInterference = rows.filter((r) => r.interference != null)
  if (withInterference.length < MIN_GAMES_FOR_POTENTIAL) {
    return { insufficientData: true, flags: [] }
  }

  const overallAvg = mean(withInterference.map((r) => r.interference))
  const flags = []

  // --- Stage/pressure pattern -> Protocol 1 (rDLPFC) -----------------------
  const officialRows = withInterference.filter((r) => r.seriesType === 'ESPORTS')
  const scrimRows = withInterference.filter((r) => r.seriesType === 'SCRIM')
  if (officialRows.length >= MIN_GAMES_FOR_CONTEXT && scrimRows.length >= MIN_GAMES_FOR_CONTEXT) {
    const officialAvg = mean(officialRows.map((r) => r.interference))
    const scrimAvg = mean(scrimRows.map((r) => r.interference))
    const gap = officialAvg - scrimAvg
    // Don't flag stage pressure if the Official games just happen to coincide
    // with worse sleep — that's a sleep problem, not a pressure problem.
    const officialLowSleepShare = officialRows.filter((r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5).length / officialRows.length
    if (gap >= FLAG_THRESHOLD && officialLowSleepShare < 0.5) {
      flags.push({
        type: 'stage_pressure',
        protocol: 'Protocol 1 — rDLPFC',
        magnitude: Math.round(gap * 10) / 10,
        n: officialRows.length,
        summary: `Interference runs ${Math.round(gap * 10) / 10} pts higher in Official vs Scrim (n=${officialRows.length} Official games) — not explained by worse sleep on those days.`,
        evidence: 'Supporting: Plewnia 2016 (n=120, RCT) — anodal rDLPFC prevented stress-induced working-memory collapse; athlete studies show reduced pre-competition anxiety and cortisol. Caveat: Ankri 2023 (n=130) found rDLPFC did NOT protect working memory under stress and reversed the effect on one measure — treat this as a promising pattern to discuss, not a guaranteed fix.',
      })
    }
  }

  // --- Sleep-debt pattern -> NOT a tDCS candidate --------------------------
  const lowSleepRows = withInterference.filter((r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5)
  if (lowSleepRows.length >= MIN_GAMES_FOR_CONTEXT && overallAvg != null) {
    const lowSleepAvg = mean(lowSleepRows.map((r) => r.interference))
    const gap = lowSleepAvg - overallAvg
    if (gap >= FLAG_THRESHOLD) {
      flags.push({
        type: 'sleep_debt',
        protocol: 'Not a tDCS candidate — sleep protocol',
        magnitude: Math.round(gap * 10) / 10,
        n: lowSleepRows.length,
        summary: `Interference runs ${Math.round(gap * 10) / 10} pts higher on nights with a 3-night rolling average under 6.5h (n=${lowSleepRows.length}).`,
        evidence: 'The research does not frame tDCS as a sleep-debt compensator beyond a narrow ~6-hour vigilance/attention window (S018/S019) — it does not address working memory, emotional regulation, or decision-making deficits caused by sleep loss. This needs the sleep protocol (S-R1–S-R8), not stimulation.',
      })
    }
  }

  // --- Tilt/recovery pattern -> Protocol 3 (Tilt Reset) --------------------
  if (tiltResult && !tiltResult.insufficientData && tiltResult.avgIndexAfterBadGame != null && tiltResult.overallAvgIndex != null) {
    const tiltGap = tiltResult.overallAvgIndex - tiltResult.avgIndexAfterBadGame
    if (tiltGap >= FLAG_THRESHOLD && tiltResult.recoverySampleSize >= MIN_GAMES_FOR_CONTEXT) {
      flags.push({
        type: 'tilt_recovery',
        protocol: 'Protocol 3 — Tilt Reset (left IFG)',
        magnitude: Math.round(tiltGap * 10) / 10,
        n: tiltResult.recoverySampleSize,
        summary: `Performance runs ${Math.round(tiltGap * 10) / 10} pts below own average in the game right after a bottom-quartile performance (n=${tiltResult.recoverySampleSize} recoveries).`,
        evidence: 'Supporting: inhibitory-control research (S017) behind the Tilt Reset protocol. Caveat: a null result exists on record for this protocol in a different population/dose (S022) — treat as a pattern worth a conversation, not a proven fix.',
      })
    }
  }

  // --- Late-series fatigue pattern -> Protocol 4/5 -------------------------
  // GRID's game_number is 0-indexed within a series (0 = Game 1) — fixed
  // 2026-07-12. Small sample: only meaningful for the ~17 multi-game (BO3+)
  // series, since 97.6% of scrims are single-game BO1s.
  const game1Rows = withInterference.filter((r) => r.gameNumber === 0)
  const lateGameRows = withInterference.filter((r) => r.gameNumber != null && r.gameNumber >= 2)
  if (game1Rows.length >= MIN_GAMES_FOR_CONTEXT && lateGameRows.length >= MIN_GAMES_FOR_CONTEXT) {
    const game1Avg = mean(game1Rows.map((r) => r.interference))
    const lateGameAvg = mean(lateGameRows.map((r) => r.interference))
    const gap = lateGameAvg - game1Avg
    const lateLowSleepShare = lateGameRows.filter((r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5).length / lateGameRows.length
    if (gap >= FLAG_THRESHOLD && lateLowSleepShare < 0.5) {
      flags.push({
        type: 'late_series_fatigue',
        protocol: 'Protocol 4/5 — Frontopolar endurance / post-match recovery',
        magnitude: Math.round(gap * 10) / 10,
        n: lateGameRows.length,
        summary: `Interference runs ${Math.round(gap * 10) / 10} pts higher in Game 3+ of a series vs Game 1 (n=${lateGameRows.length} late games) — not explained by worse sleep on those days.`,
        evidence: 'Supporting: frontopolar tDCS extends vigilance/attention under sustained load for up to ~6 hours post-session (S018/S019); dual-site protocol also studied for back-to-back match-day recovery (S012/S026). This is about sustaining attention under fatigue, not masking sleep debt.',
      })
    }
  }

  // --- Late-in-day fatigue pattern -> Protocol 4/5 (day-sequence lens) -----
  // Same idea, but using position within a whole DAY'S block of consecutive
  // BO1 scrims (via daySequence, added 2026-07-12) rather than game number
  // within a single series — the lens that actually applies to how Sentinels
  // scrim (5-8+ BO1s back to back), where the series-based check above has
  // almost no sample.
  const dayEarlyRows = withInterference.filter((r) => r.daySequence != null && r.daySequence <= 2)
  const dayLateRows = withInterference.filter((r) => r.daySequence != null && r.daySequence >= 5)
  if (dayEarlyRows.length >= MIN_GAMES_FOR_CONTEXT && dayLateRows.length >= MIN_GAMES_FOR_CONTEXT) {
    const dayEarlyAvg = mean(dayEarlyRows.map((r) => r.interference))
    const dayLateAvg = mean(dayLateRows.map((r) => r.interference))
    const gap = dayLateAvg - dayEarlyAvg
    const dayLateLowSleepShare = dayLateRows.filter((r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5).length / dayLateRows.length
    if (gap >= FLAG_THRESHOLD && dayLateLowSleepShare < 0.5) {
      flags.push({
        type: 'late_in_day_fatigue',
        protocol: 'Protocol 4/5 — Frontopolar endurance / post-match recovery',
        magnitude: Math.round(gap * 10) / 10,
        n: dayLateRows.length,
        summary: `Interference runs ${Math.round(gap * 10) / 10} pts higher on the 5th+ game of a day's scrim block vs the 1st-2nd (n=${dayLateRows.length} late-block games) — not explained by worse sleep on those days.`,
        evidence: 'Supporting: frontopolar tDCS extends vigilance/attention under sustained load for up to ~6 hours post-session (S018/S019). Requires GRID start-time data, only populated for series synced since 2026-07-12 — sample will grow as history gets re-synced.',
      })
    }
  }

  return { insufficientData: false, overallAvgInterference: overallAvg != null ? Math.round(overallAvg * 10) / 10 : null, flags }
}
