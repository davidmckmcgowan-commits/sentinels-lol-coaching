// Rolling 3-night sleep-debt calculations for nightly_sleep data.
//
// Core rule (per research doc): a "3-night rolling average" is the average of the
// most recent 3 *logged* nights for a player, not the last 3 calendar days. When
// gaps exist between logged nights, we still average whatever 3 consecutive log
// rows are available, but we flag when the window those 3 rows span is "stale"
// (i.e. spans more than ROLLING_WINDOW_GAP_DAYS calendar days from oldest to
// newest of the 3), since that means the "rolling average" is being built from
// entries that don't actually represent the last few nights.

import { ROLLING_WINDOW_GAP_DAYS, HARD_GATE_HOURS, ISOLATED_DISRUPTION_HOURS, ISOLATED_DISRUPTION_ROLLING_FLOOR } from './constants.js'

const DAY_MS = 24 * 60 * 60 * 1000

function daysBetween(dateStrA, dateStrB) {
  const a = new Date(dateStrA)
  const b = new Date(dateStrB)
  return Math.abs(b.getTime() - a.getTime()) / DAY_MS
}

// Build a sorted, deduped list of {date, hours} for one player from raw nightly_sleep rows.
export function sortPlayerNights(rows) {
  return [...rows]
    .filter((r) => r.hours != null)
    .sort((a, b) => (a.sleep_date < b.sleep_date ? -1 : a.sleep_date > b.sleep_date ? 1 : 0))
    .map((r) => ({ date: r.sleep_date, hours: Number(r.hours) }))
}

// For a sorted list of {date, hours} nights, compute a rolling-3-night-average series.
// Each point corresponds to a logged night (the night the average is "as of"), using
// that night plus the 2 most recent prior logged nights (or fewer, if <3 available).
// Also computes: isolated-disruption flag, hard-gate flag, stale-window flag, and
// whether this point begins a new "segment" (i.e. follows a calendar gap large enough
// that a chart should visually break the line rather than connect across it).
export function computeRollingSeries(nights, {
  gapDays = ROLLING_WINDOW_GAP_DAYS,
  hardGateHours = HARD_GATE_HOURS,
  isolatedHours = ISOLATED_DISRUPTION_HOURS,
  isolatedRollingFloor = ISOLATED_DISRUPTION_ROLLING_FLOOR,
} = {}) {
  const out = []
  for (let i = 0; i < nights.length; i += 1) {
    const windowStart = Math.max(0, i - 2)
    const window = nights.slice(windowStart, i + 1)
    const rollingAvg = window.reduce((sum, n) => sum + n.hours, 0) / window.length
    const windowSpanDays = window.length > 1 ? daysBetween(window[0].date, window[window.length - 1].date) : 0
    const staleWindow = window.length < 3 || windowSpanDays > gapDays

    const night = nights[i]
    const isHardGate = night.hours < hardGateHours
    // Isolated disruption: this single night is below the isolated-disruption threshold
    // while the rolling average (computed from logged nights, not stale) is still >= the
    // "acceptable" floor — i.e. the average looks fine but this specific night did not.
    const isIsolatedDisruption = night.hours < isolatedHours && rollingAvg >= isolatedRollingFloor && !isHardGate

    // Gap-from-previous-night, used by the chart to decide whether to break the line.
    const prev = i > 0 ? nights[i - 1] : null
    const gapFromPrevDays = prev ? daysBetween(prev.date, night.date) : null
    const startsNewSegment = i === 0 || (gapFromPrevDays !== null && gapFromPrevDays > gapDays)

    out.push({
      date: night.date,
      hours: night.hours,
      rollingAvg: Math.round(rollingAvg * 100) / 100,
      windowSize: window.length,
      staleWindow,
      isHardGate,
      isIsolatedDisruption,
      gapFromPrevDays,
      startsNewSegment,
    })
  }
  return out
}

// Given all nightly_sleep rows (any players) and a target date, find each player's
// most recent rolling-3-night average as of (<=) that date. Returns a map of
// player -> { rollingAvg, asOfDate, staleWindow } or omits the player entirely if
// no rolling average is available at or before that date (per spec: exclude rather
// than guess).
export function rollingAveragesAsOf(allRowsByPlayer, targetDate) {
  const result = {}
  for (const [player, nights] of Object.entries(allRowsByPlayer)) {
    const series = computeRollingSeries(nights)
    // Find the latest point with date <= targetDate.
    let candidate = null
    for (const point of series) {
      if (point.date <= targetDate) {
        candidate = point
      } else {
        break
      }
    }
    if (candidate) {
      result[player] = {
        rollingAvg: candidate.rollingAvg,
        asOfDate: candidate.date,
        staleWindow: candidate.staleWindow,
        daysBeforeTarget: daysBetween(candidate.date, targetDate),
      }
    }
  }
  return result
}

// Group raw nightly_sleep rows by player -> sorted nights list.
export function groupByPlayer(rows) {
  const byPlayer = {}
  for (const r of rows) {
    if (!byPlayer[r.player]) byPlayer[r.player] = []
    byPlayer[r.player].push(r)
  }
  for (const player of Object.keys(byPlayer)) {
    byPlayer[player] = sortPlayerNights(byPlayer[player])
  }
  return byPlayer
}
