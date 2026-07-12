// Performance Index: a single, comparable number per game, built to satisfy
// A-R1 (each player is their own control) and A-R4 (champion must be tagged,
// never compared cross-champion as if it were the same baseline).
//
// GRID's Open Access tier gives us kills/deaths/assists/net_worth per game —
// no damage share, CS, vision score, or in-game timing (that's the paid Series
// Events product; see reference_grid_api_tiers memory). So the Index is built
// from three components, each z-scored against the PLAYER'S OWN history:
//   1. KDA
//   2. Kill participation (share of team kills that game)
//   3. Net worth differential vs the same-role opponent in that game — a
//      laning/economy proxy, since we can't see gold-at-10-minutes directly
//
// Baseline is per-player, per-champion when that player has enough logged
// games on the champion (default 3+); otherwise it falls back to a per-player,
// per-role baseline. Never another player's numbers — that would violate A-R1.
//
// The blended z-score is mapped onto a 0-100 scale for coaching readability:
//   score = clamp(50 + avgZ * 15, 0, 100)
// 50 means "average for THIS PLAYER on this champion/role" — not average for
// the team, not average for the league. Never compare the number across
// players. A low n (see baselineN) means the baseline itself is shaky —
// surface that alongside the score, don't hide it.

function mean(nums) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  if (v.length === 0) return null
  return v.reduce((a, b) => a + b, 0) / v.length
}

function stdev(nums, avg) {
  const v = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  if (v.length < 2) return null
  const m = avg ?? mean(v)
  const variance = v.reduce((sum, n) => sum + (n - m) ** 2, 0) / (v.length - 1)
  return Math.sqrt(variance)
}

function zScore(value, avg, sd) {
  if (value == null || avg == null || sd == null || sd === 0) return null
  return (value - avg) / sd
}

// Build a lookup of `${game_id}::${role}` -> opponent net_worth, from the FULL
// raw grid_player_games rows (both teams, no is_sentinels filter). Used to
// compute netWorthDiff for each Sentinels row. If a game has no opposing
// player logged at that role (data gap), the diff is left null rather than
// guessed.
export function buildOpponentNetWorthByGameRole(allRawRows) {
  const map = new Map()
  for (const r of allRawRows) {
    if (r.is_sentinels) continue
    if (!r.game_id || !r.role) continue
    map.set(`${r.game_id}::${r.role}`, r.net_worth ?? null)
  }
  return map
}

// Attach netWorthDiff onto already-built player performance rows (from
// buildPlayerPerformanceSeries in individualPerformance.js).
export function attachNetWorthDiff(rows, opponentNetWorthByGameRole) {
  return rows.map((r) => {
    if (!r.gameId || !r.role) return { ...r, netWorthDiff: null }
    const oppNetWorth = opponentNetWorthByGameRole.get(`${r.gameId}::${r.role}`)
    const netWorthDiff = oppNetWorth != null && r.netWorth != null ? r.netWorth - oppNetWorth : null
    return { ...r, netWorthDiff }
  })
}

// Build per-player baselines, preferring champion-level (n >= minChampionGames)
// and falling back to role-level.
export function computeBaselines(rows, { minChampionGames = 3 } = {}) {
  const byChampion = {}
  const byRole = {}
  for (const r of rows) {
    if (r.champion) {
      if (!byChampion[r.champion]) byChampion[r.champion] = []
      byChampion[r.champion].push(r)
    }
    if (r.role) {
      if (!byRole[r.role]) byRole[r.role] = []
      byRole[r.role].push(r)
    }
  }

  const buildStats = (group) => {
    const kdaVals = group.map((r) => r.kda)
    const kpVals = group.map((r) => r.killParticipation).filter((v) => v != null)
    const nwVals = group.map((r) => r.netWorthDiff).filter((v) => v != null)
    const kdaMean = mean(kdaVals)
    const kpMean = mean(kpVals)
    const nwMean = mean(nwVals)
    return {
      n: group.length,
      kda: { mean: kdaMean, sd: stdev(kdaVals, kdaMean) },
      kp: { mean: kpMean, sd: stdev(kpVals, kpMean) },
      netWorthDiff: { mean: nwMean, sd: stdev(nwVals, nwMean) },
    }
  }

  const baselines = { champion: {}, role: {} }
  for (const [champ, group] of Object.entries(byChampion)) {
    if (group.length >= minChampionGames) baselines.champion[champ] = buildStats(group)
  }
  for (const [role, group] of Object.entries(byRole)) {
    baselines.role[role] = buildStats(group)
  }
  return baselines
}

// Compute the Performance Index for every row, using each row's own champion
// baseline when available, else its role baseline. Rows with neither (should
// only happen if role is also missing) get a null index rather than a guess.
export function computePerformanceIndex(rows, { minChampionGames = 3 } = {}) {
  const baselines = computeBaselines(rows, { minChampionGames })

  return rows.map((r) => {
    const champBaseline = r.champion ? baselines.champion[r.champion] : null
    const roleBaseline = r.role ? baselines.role[r.role] : null
    const baseline = champBaseline || roleBaseline
    const baselineSource = champBaseline ? 'champion' : roleBaseline ? 'role' : null

    if (!baseline) {
      return { ...r, performanceIndex: null, baselineSource: null, baselineN: 0, components: {} }
    }

    const zKda = zScore(r.kda, baseline.kda.mean, baseline.kda.sd)
    const zKp = zScore(r.killParticipation, baseline.kp.mean, baseline.kp.sd)
    const zNw = zScore(r.netWorthDiff, baseline.netWorthDiff.mean, baseline.netWorthDiff.sd)

    const zs = [zKda, zKp, zNw].filter((z) => z != null)
    const avgZ = zs.length > 0 ? zs.reduce((a, b) => a + b, 0) / zs.length : null
    const performanceIndex = avgZ != null ? Math.round(Math.max(0, Math.min(100, 50 + avgZ * 15))) : null

    return {
      ...r,
      performanceIndex,
      baselineSource, // 'champion' | 'role'
      baselineN: baseline.n,
      components: { zKda, zKp, zNw },
    }
  })
}

// ---- Endurance: performance by game number within a series ----------------
// True within-game fade (laning vs late-game) needs GRID's paid Series Events
// timeline, which we don't have. Game-number-within-series is the closest
// available proxy for "do they fade as a series goes on."
export function computeEnduranceByGameNumber(rows) {
  const buckets = { 1: [], 2: [], '3+': [] }
  for (const r of rows) {
    if (r.performanceIndex == null || !r.gameNumber) continue
    const key = r.gameNumber >= 3 ? '3+' : String(r.gameNumber)
    buckets[key].push(r.performanceIndex)
  }
  return ['1', '2', '3+'].map((key) => ({
    key: `Game ${key}`,
    avg: buckets[key].length > 0 ? Math.round(mean(buckets[key]) * 10) / 10 : null,
    n: buckets[key].length,
  }))
}

// ---- Tilt detector: performance in the game right after a bad game --------
// "Bad game" = bottom quartile of the player's OWN Performance Index
// distribution (A-R1: own control, not a league-wide bar). "Right after" =
// the next game_number within the SAME GRID series — we don't have timestamps
// finer than the series date, so same-series next-game is the cleanest
// "immediately after" signal available from this data.
export function computeTiltRecovery(rows) {
  const withIndex = rows.filter((r) => r.performanceIndex != null && r.seriesId && r.gameNumber != null)
  if (withIndex.length < 4) return { insufficientData: true }

  const sorted = [...withIndex].sort((a, b) => a.performanceIndex - b.performanceIndex)
  const p25 = sorted[Math.floor(sorted.length * 0.25)].performanceIndex

  const bySeries = {}
  for (const r of withIndex) {
    if (!bySeries[r.seriesId]) bySeries[r.seriesId] = []
    bySeries[r.seriesId].push(r)
  }
  for (const games of Object.values(bySeries)) games.sort((a, b) => a.gameNumber - b.gameNumber)

  const recoveryIndices = []
  for (const games of Object.values(bySeries)) {
    for (let i = 0; i < games.length - 1; i++) {
      if (games[i].performanceIndex <= p25) {
        recoveryIndices.push(games[i + 1].performanceIndex)
      }
    }
  }

  const overallAvg = mean(withIndex.map((r) => r.performanceIndex))
  const avgAfterBad = recoveryIndices.length > 0 ? mean(recoveryIndices) : null

  return {
    insufficientData: false,
    badGameThreshold: Math.round(p25),
    badGameCount: sorted.filter((r) => r.performanceIndex <= p25).length,
    recoverySampleSize: recoveryIndices.length,
    overallAvgIndex: overallAvg != null ? Math.round(overallAvg * 10) / 10 : null,
    avgIndexAfterBadGame: avgAfterBad != null ? Math.round(avgAfterBad * 10) / 10 : null,
  }
}
