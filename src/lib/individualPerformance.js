// Join logic for individual GRID player-game data against sleep and session-type
// data, plus derived performance metrics.
//
// Important limitations, surfaced in the UI rather than hidden here:
// - GRID only distinguishes SCRIM vs ESPORTS natively. Green/Orange/Red/Official
//   is an internal classification that lives in the `sessions` table and has to be
//   joined by date (loose join — GRID has no session id to key off of).
// - AUDIT FINDING (2026-07-09, cross-checked against Leaguepedia's Sentinels match
//   history): the internal `sessions` sheet and GRID disagree on official-match
//   dates often enough that a plain date-only join mislabels games. Confirmed via
//   Leaguepedia: (a) 4 real official matches (2026-02-01 vs Dignitas, 2026-03-07 vs
//   Cloud9 Kia, 2026-05-17 vs Dignitas, 2026-05-30 vs FlyQuest) exist in GRID as
//   ESPORTS series but have ZERO row in the internal sessions table at all; (b) at
//   least ~15 dates have a GRID SCRIM series and an internal "Official" session on
//   the same calendar day against a DIFFERENT opponent (genuine same-day scrim +
//   official, not a data error) — a naive date join would mislabel the scrim games
//   as Official on those dates; (c) GRID's own series_date is itself off by one day
//   from the true match date in at least 2 known spots (2026-01-24→GRID's 01-25 vs
//   Disguised, 2026-03-04→GRID's 03-05 vs RED Canids), confirmed by Leaguepedia
//   agreeing with the internal sheet's earlier date in both cases.
// - FIX: GRID's own series_type is now treated as authoritative for the
//   stage-vs-practice distinction. Any GRID ESPORTS series is labeled "Official"
//   directly — no date lookup, so it can never be missed just because the internal
//   sessions sheet has a gap that day. Only SCRIM games consult the internal
//   sessions table, and only among Green/Orange/Red rows (Official is excluded from
//   that lookup entirely), so a same-day official match with a different opponent
//   can no longer bleed its label onto scrim games. A handful of SCRIM dates still
//   have more than one Green/Orange/Red type logged same day; those are labeled
//   "Mixed" rather than arbitrarily picking one.
// - Separately, the internal sessions sheet's `result` column itself is wrong for
//   2026-04-18 vs FlyQuest (logged as 3 losses; GRID + Leaguepedia both confirm
//   Sentinels won that series 2-1). This doesn't affect the per-game GRID stats
//   used here (which come from grid_games.sentinels_won, confirmed correct), but it
//   does mean the internal Monitoring Master Sheet's team W-L record needs a manual
//   correction — flag to David, not fixable from this file.
// - Per A-R4, champion is attached to every row. Do not compare KDA/net worth
//   across different champions as if they were the same baseline.
// - Per A-R1, each player is their own control — these helpers never rank or
//   compare players against each other.

import { rollingAveragesAsOf } from './sleepDebt.js'

// Build a map of session_date -> { label, types } from raw `sessions` rows.
// Only Green/Orange/Red rows are considered — Official is intentionally excluded
// here because GRID's own ESPORTS flag now handles the Official label directly
// (see file header). Feeding Official rows into this map was the root cause of
// same-day scrim+official conflicts bleeding the wrong label onto scrim games.
// label is the single session_type if unambiguous, or "Mixed (A+B)" if more than
// one distinct practice type was logged on that date.
export function buildSessionTypeByDate(sessionRows) {
  const byDate = {}
  for (const s of sessionRows) {
    if (!s.session_date || !s.session_type) continue
    if (s.session_type === 'Official') continue // handled via GRID series_type instead
    if (!byDate[s.session_date]) byDate[s.session_date] = new Set()
    byDate[s.session_date].add(s.session_type)
  }
  const out = {}
  for (const [date, typesSet] of Object.entries(byDate)) {
    const types = [...typesSet]
    out[date] = {
      types,
      label: types.length === 1 ? types[0] : `Mixed (${types.join('+')})`,
      ambiguous: types.length > 1,
    }
  }
  return out
}

// Derived per-game metrics for one grid_player_games row (already joined to its
// grid_games + grid_series parent via the nested select in the view).
export function deriveGameMetrics(row) {
  const kills = row.kills ?? 0
  const deaths = row.deaths ?? 0
  const assists = row.assists ?? 0
  const netWorth = row.net_worth ?? 0
  const teamKills = row.grid_games?.sentinels_kills ?? null

  const kda = deaths === 0 ? kills + assists : (kills + assists) / deaths
  const killParticipation = teamKills && teamKills > 0 ? (kills + assists) / teamKills : null

  return {
    kills,
    deaths,
    assists,
    netWorth,
    kda: Math.round(kda * 100) / 100,
    killParticipation: killParticipation != null ? Math.round(killParticipation * 1000) / 10 : null, // percent
  }
}

// Flatten raw grid_player_games rows (with nested grid_games/grid_series) into
// one record per game for a single player, attaching:
// - champion, derived KDA/kill participation/net worth
// - series date, GRID series_type (SCRIM/ESPORTS), opponent, series result
// - session_type label from the loose date join (or null if unmatched)
// - same-night sleep hours (exact date match) and 3-night rolling avg as-of that date
export function buildPlayerPerformanceSeries({ rawRows, player, sleepByPlayer, sessionTypeByDate }) {
  const playerNights = sleepByPlayer[player] || []
  const nightsByDate = new Map(playerNights.map((n) => [n.date, n.hours]))

  const rows = rawRows
    .filter((r) => r.player === player)
    .map((r) => {
      const series = r.grid_games?.grid_series
      const date = series?.series_date ?? null
      const metrics = deriveGameMetrics(r)
      const isEsports = series?.series_type === 'ESPORTS'
      // GRID's own series_type is authoritative for Official — see file header.
      // Only SCRIM games fall through to the internal Green/Orange/Red date lookup.
      const sessionInfo = isEsports
        ? { label: 'Official', ambiguous: false }
        : date
          ? sessionTypeByDate[date]
          : undefined

      let rollingAvg = null
      let rollingStale = null
      if (date) {
        const asOf = rollingAveragesAsOf(sleepByPlayer, date)
        const entry = asOf[player]
        if (entry) {
          rollingAvg = entry.rollingAvg
          rollingStale = entry.staleWindow
        }
      }

      return {
        date,
        champion: r.champion,
        role: r.role,
        gameId: r.game_id ?? null,
        seriesId: r.grid_games?.grid_series_id ?? null,
        netWorth: r.net_worth ?? null,
        gameNumber: r.grid_games?.game_number ?? null,
        sentinelsWonGame: r.grid_games?.sentinels_won ?? null,
        opponentName: series?.opponent_name ?? null,
        seriesType: series?.series_type ?? null, // SCRIM | ESPORTS (native GRID field)
        sessionTypeLabel: sessionInfo?.label ?? null, // Green/Orange/Red/Official/Mixed, or null if unmatched
        sessionTypeAmbiguous: sessionInfo?.ambiguous ?? false,
        sameNightSleepHours: date && nightsByDate.has(date) ? nightsByDate.get(date) : null,
        rollingAvgSleep: rollingAvg,
        rollingAvgStale: rollingStale,
        ...metrics,
      }
    })
    .filter((r) => r.date) // exclude rows we can't date-anchor at all
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  return rows
}

// Aggregate helper: average a numeric field across rows, grouped by an arbitrary
// key function, returning [{ key, avg, n }] — used for SCRIM vs ESPORTS and
// Green/Orange/Red/Official bar charts. Groups with n === 0 are omitted.
export function averageByGroup(rows, keyFn, valueFn) {
  const groups = {}
  for (const r of rows) {
    const key = keyFn(r)
    if (key == null) continue
    const value = valueFn(r)
    if (value == null || Number.isNaN(value)) continue
    if (!groups[key]) groups[key] = { sum: 0, n: 0 }
    groups[key].sum += value
    groups[key].n += 1
  }
  return Object.entries(groups).map(([key, { sum, n }]) => ({
    key,
    avg: Math.round((sum / n) * 100) / 100,
    n,
  }))
}

// Weak overextension proxy: flag games where deaths are high relative to kills
// and the game was lost, using only aggregate per-game fields (no death-timing
// data is available — see reference_grid_api_tiers memory: GRID's Series Events
// timeline product is paid, not part of the current Open Access key). This is a
// coarse, unvalidated signal, not a measurement of actual over-extension — label
// it as such everywhere it's surfaced.
export function flagOverextensionCandidates(rows, { minDeaths = 5, deathsMinusKills = 3 } = {}) {
  return rows.filter((r) => r.deaths >= minDeaths && r.deaths - r.kills >= deathsMinusKills && r.sentinelsWonGame === false)
}
