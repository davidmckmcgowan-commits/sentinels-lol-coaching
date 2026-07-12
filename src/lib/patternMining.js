// Evidence-based pattern mining: "when a player does X, how often is that a
// good performance vs not, and how confident can we actually be?"
//
// "Good performance" is defined as Performance Index > 50 — i.e. above this
// player's OWN average (Index is already z-scored to their own champion/role
// baseline, so >50 literally means "better than their own normal this game").
// Per A-R1, every condition and every probability below is scoped to one
// player's own history — never compared across players.
//
// Small-sample honesty: with as few as 5-15 games in a bucket, a raw
// percentage like "83% good" is not a reliable 95%-confidence claim on its
// own. Every probability here is reported with a Wilson score interval (more
// accurate than a normal approximation at small n) so a wide, honest interval
// is shown instead of a falsely precise point estimate. Conditions with too
// few games on either side are marked insufficient rather than reported.

const MIN_N_PER_SIDE = 5

// Wilson score interval for a binomial proportion — better behaved than the
// normal approximation when n is small, which is the normal case here.
function wilsonInterval(successes, n, z = 1.96) {
  if (n === 0) return { point: null, low: null, high: null }
  const pHat = successes / n
  const denom = 1 + (z * z) / n
  const center = pHat + (z * z) / (2 * n)
  const margin = z * Math.sqrt((pHat * (1 - pHat)) / n + (z * z) / (4 * n * n))
  return {
    point: Math.round(pHat * 1000) / 10, // percent, 1 decimal
    low: Math.round(((center - margin) / denom) * 1000) / 10,
    high: Math.round(((center + margin) / denom) * 1000) / 10,
  }
}

// Standard set of candidate conditions to test. Each predicate runs against a
// single performance row (already carrying performanceIndex, rollingAvgSleep,
// vibe, opponentTier-derived label, gameNumber, baselineSource, and — for the
// "after a rough game" condition — a precomputed `priorGameGood` flag).
export function buildStandardConditions() {
  return [
    { key: 'well_rested', label: 'Well-Rested (3-night rolling 7.5h+)', predicate: (r) => r.rollingAvgSleep != null && r.rollingAvgSleep >= 7.5 },
    { key: 'sleep_debt', label: 'Sleep Debt (3-night rolling <6.5h)', predicate: (r) => r.rollingAvgSleep != null && r.rollingAvgSleep < 6.5 },
    { key: 'high_vibe', label: 'High Vibe (7+)', predicate: (r) => r.vibe != null && r.vibe >= 7 },
    { key: 'low_vibe', label: 'Low Vibe (≤5)', predicate: (r) => r.vibe != null && r.vibe <= 5 },
    { key: 'tough_matchup', label: 'Tough Matchup (Opponent Tier 4-5)', predicate: (r) => { const t = r.tier; return t === 4 || t === 5 } },
    { key: 'easier_matchup', label: 'Easier Matchup (Tier 1-3 / Unranked)', predicate: (r) => { const t = r.tier; return t == null || t <= 3 } },
    { key: 'series_opener', label: 'Series Opener (Game 1)', predicate: (r) => r.gameNumber === 1 },
    { key: 'late_series', label: 'Late Series (Game 3+)', predicate: (r) => r.gameNumber != null && r.gameNumber >= 3 },
    { key: 'after_rough_game', label: 'Right After a Rough Game (same series)', predicate: (r) => r.priorGameGood === false },
    { key: 'after_good_game', label: 'Right After a Good Game (same series)', predicate: (r) => r.priorGameGood === true },
    { key: 'comfort_pick', label: 'Comfort Pick (3+ games on this champion)', predicate: (r) => r.baselineSource === 'champion' },
    { key: 'off_meta_pick', label: 'Off-Meta / New Pick (role-level baseline)', predicate: (r) => r.baselineSource === 'role' },
  ]
}

// Attach `priorGameGood` (bool|null) — whether the PREVIOUS game_number in the
// same GRID series was itself a good performance — needed for the
// after-a-rough-game / after-a-good-game conditions.
export function attachPriorGameGood(rows) {
  const bySeries = {}
  for (const r of rows) {
    if (!r.seriesId || r.gameNumber == null) continue
    if (!bySeries[r.seriesId]) bySeries[r.seriesId] = []
    bySeries[r.seriesId].push(r)
  }
  for (const games of Object.values(bySeries)) games.sort((a, b) => a.gameNumber - b.gameNumber)

  const priorGoodByRowRef = new Map()
  for (const games of Object.values(bySeries)) {
    for (let i = 1; i < games.length; i++) {
      const prev = games[i - 1]
      if (prev.performanceIndex != null) {
        priorGoodByRowRef.set(games[i], prev.performanceIndex > 50)
      }
    }
  }

  return rows.map((r) => ({ ...r, priorGameGood: priorGoodByRowRef.has(r) ? priorGoodByRowRef.get(r) : null }))
}

// Compute a "condition card" for every standard condition against the given
// row set (already filtered to Combined / Scrim-only / Official-only upstream
// — this function itself doesn't know or care which).
export function computeConditionCards(rows, conditions = buildStandardConditions()) {
  const scored = rows.filter((r) => r.performanceIndex != null)
  const totalGood = scored.filter((r) => r.performanceIndex > 50).length
  const baseline = scored.length > 0 ? Math.round((totalGood / scored.length) * 1000) / 10 : null

  const cards = conditions.map((c) => {
    const meets = scored.filter((r) => c.predicate(r))
    const notMeets = scored.filter((r) => !c.predicate(r))
    const meetsGood = meets.filter((r) => r.performanceIndex > 50).length
    const insufficientData = meets.length < MIN_N_PER_SIDE || notMeets.length < MIN_N_PER_SIDE
    const ci = wilsonInterval(meetsGood, meets.length)
    return {
      key: c.key,
      label: c.label,
      n: meets.length,
      nOther: notMeets.length,
      pGood: ci.point,
      ciLow: ci.low,
      ciHigh: ci.high,
      baseline,
      lift: ci.point != null && baseline != null ? Math.round((ci.point - baseline) * 10) / 10 : null,
      insufficientData,
    }
  })

  return { baseline, totalScored: scored.length, cards }
}
