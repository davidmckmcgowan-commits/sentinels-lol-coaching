import { useMemo, useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'
import { prognosticPct, fmtPct, todayISO, addDaysISO, TRACK_START } from '../lib/prognostic.js'
import DmGraph from '../components/DmGraph.jsx'
import InfoTip from '../components/InfoTip.jsx'

// A League game can't legitimately end before 15:00 (no surrender vote, no
// realistic nexus kill sooner), so anything shorter is a remake/abort/void
// game. We only count completed games in win rates and records.
const MIN_REAL_GAME_S = 900
const READINESS_HELP = 'A 0–100 readiness index across all active goals — not a match-win prediction. For each goal it blends how much of the baseline→target gap is currently closed with whether the last scrim day moved toward or away from target, then averages across every goal. Read it as prep direction-of-travel: low early in the week, climbing as the numbers move toward target.'

// Plain-English, LoL-accurate explanation of what each metric actually is and
// where the number comes from — so a coach can explain it to the players.
const METRIC_HELP = {
  team_gold_diff_15: "Gold difference at 15:00 — our whole team's gold minus the enemy's at the 15-minute mark, averaged across the day's games. Pulled from the Riot match timeline. Positive means we head into the mid game with a real lead.",
  team_cs_diff_15: "Team CS (creep-score) difference vs the enemy at 15:00, averaged across the day's games. From the Riot timeline.",
  first_tower_rate: "Share of the day's games where we take the first tower. First tower is gold plus map control. From Riot objective data.",
  dragon_control_rate: "Share of games where we finish with more dragons than the enemy. Dragons stack permanent buffs, so out-dragoning them is a lasting lead. From Riot objective data.",
  first_dragon_rate: "Share of games where we out-take the enemy on dragons.",
  grub_majority_rate: "Share of games where we take at least 4 of the 6 Void Grubs. Grubs speed up our tower kills. From Riot objective data.",
  laners_cs_diff_15: "Average CS (creep-score) difference at 15:00 across our four laners — everyone except Huhi, the support — each measured against their direct lane opponent. Positive means our lanes are out-farming theirs. From the Riot timeline.",
  laners_damage_per_min: "Average champion damage per minute across our four laners over the full game — turning farm and kills into actual damage.",
  team_give_back_rate: "Of our kills, objectives and tower takes, the share where we hand a kill straight back within 90 seconds. LOWER is better — it measures giving leads away. Built from the timeline event stream.",
  team_snowball_rate: "Of our kills, objectives and tower takes, the share we follow up with ANOTHER positive play within 90 seconds. HIGHER is better — it measures pressing an advantage. From the timeline event stream.",
  player_cs_diff_15: "This player's CS (creep-score) lead over their direct lane opponent at 15:00, averaged across the day. From the Riot timeline.",
  player_gold_diff_15: "This player's gold lead over their lane opponent at 15:00, averaged across the day.",
  player_kp: "Kill participation — the share of the team's kills this player landed a kill or assist on. Measures how involved they are across the map.",
  player_cs_per_min: "Creep score per minute — farm rate over the full game.",
  player_damage_share: "Share of the team's total champion damage this player dealt.",
  player_damage_per_min: "Champion damage per minute over the full game.",
  player_vision_score: "Riot's vision score — wards placed, wards cleared, and time spent giving the team vision.",
}
const COL_HELP = {
  today: "The value from the most recent scrim day (the date shown), averaged over that day's completed games (15+ minutes).",
  yesterday: "The same number from the previous scrim day, with the change since. ▲ means it moved toward the target, ▼ means away from it.",
  week: "All of this prep week's scrims combined into one number, plus how far it sits above or below the baseline we started from.",
  gap: "How far today's number still has to move to reach this week's target.",
  baseline: "Where we started — our average for this metric over the last 5 games against the upcoming opponent.",
  target: "The goal for this prep week, set toward the level we hit in our wins.",
}

// ---------------------------------------------------------------------------
// Metric helpers — kept in step with GoalsTracker so both pages read the same.
// ---------------------------------------------------------------------------
const WINDOW_DAYS = 12
const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi']
const LANERS = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel']

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
const clamp01 = (x) => clamp(x, 0, 1)
const avg = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const rate = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : null }

function metricValue(key, games, prows) {
  switch (key) {
    case 'team_gold_diff_15': return avg(games, (g) => g.gold_diff_15)
    case 'team_cs_diff_15': return avg(games, (g) => g.cs_diff_15)
    case 'first_tower_rate': return rate(games, (g) => g.first_tower_sentinels)
    case 'first_dragon_rate':
    case 'dragon_control_rate': return rate(games, (g) => (g.sentinels_dragons != null && g.opponent_dragons != null ? g.sentinels_dragons > g.opponent_dragons : null))
    case 'grub_majority_rate': return rate(games, (g) => (g.sentinels_grubs != null ? g.sentinels_grubs >= 4 : null))
    case 'player_cs_diff_15': return avg(prows, (p) => p.cs_diff_15)
    case 'player_gold_diff_15': return avg(prows, (p) => p.gold_diff_15)
    case 'player_kp': return avg(prows, (p) => p.kill_participation)
    case 'player_cs_per_min': return avg(prows, (p) => p.cs_per_min)
    case 'player_damage_share': return avg(prows, (p) => p.champ_damage_share)
    case 'player_damage_per_min': return avg(prows, (p) => p.champ_damage_per_min)
    case 'player_vision_score': return avg(prows, (p) => p.vision_score)
    case 'laners_cs_diff_15': return avg(prows, (p) => p.cs_diff_15)
    case 'laners_damage_per_min': return avg(prows, (p) => p.champ_damage_per_min)
    case 'team_give_back_rate': {
      const pp = games.reduce((a, g) => a + (g.positive_plays || 0), 0)
      const gb = games.reduce((a, g) => a + (g.give_backs || 0), 0)
      return pp ? (gb / pp) * 100 : null
    }
    case 'team_snowball_rate': {
      const pp = games.reduce((a, g) => a + (g.positive_plays || 0), 0)
      const sn = games.reduce((a, g) => a + (g.snowballs || 0), 0)
      return pp ? (sn / pp) * 100 : null
    }
    default: return null
  }
}

const fmt = (v, unit) => {
  if (v == null) return '—'
  if (unit === '%') return `${Math.round(v)}%`
  if (unit === 'gold') return (v >= 0 ? '+' : '') + Math.round(v)
  if (unit === 'CS') return (v >= 0 ? '+' : '') + v.toFixed(1)
  if (unit === 'CS/min') return v.toFixed(1)
  return Math.round(v * 10) / 10
}
const fmtDelta = (d, unit) => {
  if (d == null) return null
  const s = d > 0 ? '+' : ''
  if (unit === '%') return `${s}${Math.round(d)}%`
  if (unit === 'gold') return `${s}${Math.round(d)}`
  if (unit === 'CS' || unit === 'CS/min') return `${s}${d.toFixed(1)}`
  return `${s}${Math.round(d * 10) / 10}`
}

// Blended probability: 70% how much of baseline->target is closed, 15% floor,
// 15% recent day-over-day trend direction. A directional read, not a forecast.
function goalProbability(baseline, current, target, latest, prev, higher) {
  if (baseline == null || current == null || target == null || target === baseline) return null
  const progress = clamp01((current - baseline) / (target - baseline))
  let trendScore = 0.5
  if (latest != null && prev != null) {
    const toward = higher ? latest - prev : prev - latest
    trendScore = clamp(0.5 + (toward / Math.abs(target - baseline)) * 2, 0, 1)
  }
  const p = 0.15 + 0.7 * progress + 0.15 * trendScore
  return Math.round(clamp(p, 0.02, 0.98) * 100)
}

const probColor = (p) => (p == null ? '#8a91a0' : p >= 66 ? '#3aa76d' : p >= 40 ? '#e0a940' : '#e0524a')

// ---------------------------------------------------------------------------
// Per-goal computation over the recent scrim window
// ---------------------------------------------------------------------------
function computeGoal(goal, lib, seriesById, games, prows, cycleOpp) {
  const meta = lib[goal.metric_key] || {}
  const unit = meta.unit
  const higher = meta.higher_is_better !== false
  const isLaners = (goal.metric_key || '').startsWith('laners_')
  const playersFor = (idSet) => isLaners
    ? prows.filter((p) => p.player !== 'Huhi' && idSet.has(p.game_id))
    : goal.scope === 'player' ? prows.filter((p) => p.player === goal.player && idSet.has(p.game_id)) : []

  const enriched = games.filter((g) => { const s = seriesById[g.grid_series_id]; return s && !g.excluded && s.series_type === 'SCRIM' && g.riot_enriched && g.game_duration_s >= MIN_REAL_GAME_S })
  const dates = [...new Set(enriched.map((g) => seriesById[g.grid_series_id].series_date))].sort().slice(-WINDOW_DAYS)

  const points = dates.map((date) => {
    const dg = enriched.filter((g) => seriesById[g.grid_series_id].series_date === date)
    const ids = new Set(dg.map((g) => g.id))
    return { date, value: metricValue(goal.metric_key, dg, playersFor(ids)) }
  })
  const withVals = points.filter((p) => p.value != null)
  const latest = withVals.length ? withVals[withVals.length - 1].value : null
  const prev = withVals.length > 1 ? withVals[withVals.length - 2].value : null
  const latestDate = withVals.length ? withVals[withVals.length - 1].date : null
  const prevDate = withVals.length > 1 ? withVals[withVals.length - 2].date : null
  const delta = latest != null && prev != null ? latest - prev : null

  const winGames = enriched.filter((g) => dates.includes(seriesById[g.grid_series_id].series_date))
  const winIds = new Set(winGames.map((g) => g.id))
  const wtd = metricValue(goal.metric_key, winGames, playersFor(winIds))

  const baseline = goal.baseline_value != null ? Number(goal.baseline_value) : null
  const target = goal.target_value != null ? Number(goal.target_value) : null
  const onTrack = wtd != null && target != null && (higher ? wtd >= target : wtd <= target)
  const improving = latest != null && prev != null ? (higher ? latest > prev : latest < prev) : null
  // did today close the gap vs yesterday? up / down / flat / null (no comparison yet)
  let dayState = null
  if (latest != null && prev != null) {
    dayState = Math.abs(latest - prev) < 1e-9 ? 'flat' : (higher ? latest > prev : latest < prev) ? 'up' : 'down'
  }
  // running week reading: is the week-to-date (all prep-week scrims combined)
  // better than where we started (the baseline)? up / down / flat / null
  let weekState = null
  const weekDelta = wtd != null && baseline != null ? (higher ? wtd - baseline : baseline - wtd) : null
  if (wtd != null && baseline != null) {
    weekState = Math.abs(wtd - baseline) < 1e-9 ? 'flat' : weekDelta > 0 ? 'up' : 'down'
  }
  // distance still to go to target from the latest day (negative = already met)
  const remaining = target != null && latest != null ? (higher ? target - latest : latest - target) : null
  const met = remaining != null && remaining <= 0
  const prob = goalProbability(baseline, wtd, target, latest, prev, higher)

  // --- Prognostic DM graph vs the upcoming opponent, over the prep week ------
  // PAR = our historical average on this metric vs the next official opponent.
  const parGames = cycleOpp ? games.filter((g) => { const s = seriesById[g.grid_series_id]; return s && !g.excluded && g.riot_enriched && g.game_duration_s >= MIN_REAL_GAME_S && s.series_date < TRACK_START && canonicalOpponentName(s.opponent_name || '') === cycleOpp }) : []
  const par = parGames.length ? metricValue(goal.metric_key, parGames, playersFor(new Set(parGames.map((g) => g.id)))) : null
  const today = todayISO()
  // Graph window = the continuous tracked period since TRACK_START, matching the
  // Team Goals tab. The prep week alone is empty until that week's scrims land,
  // while the card's own stats use the last N scrim days that exist — so a
  // calendar-week graph went blank while the numbers above it were populated.
  const pStart = TRACK_START
  const pEnd = goal.trend_end_date || goal.cycle_official_date || null
  let dm = null
  if (par != null && pStart && pEnd) {
    const capEnd = today < pEnd ? today : pEnd
    const inWin = games.map((g) => { const s = seriesById[g.grid_series_id]; if (!s || g.excluded || s.series_type !== 'SCRIM' || !g.riot_enriched || g.game_duration_s < MIN_REAL_GAME_S) return null; if (s.series_date < pStart || s.series_date > capEnd) return null; return { g, date: s.series_date } }).filter(Boolean)
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : (a.g.game_number ?? 0) - (b.g.game_number ?? 0))
    const byDay = {}
    for (const it of inWin) (byDay[it.date] ??= []).push(it.g)
    const dpct = (p) => `${fmtPct(p)} (${p >= 100 ? '+' : ''}${Math.round(p - 100)}% vs 100)`
    const dayData = Object.keys(byDay).sort().map((date) => {
      const dg = byDay[date]
      const raw = metricValue(goal.metric_key, dg, playersFor(new Set(dg.map((g) => g.id))))
      const pct = prognosticPct(raw, par, higher)
      return { date, pct, tip: pct == null ? null : `${date.slice(5)} · day avg ${dpct(pct)} · ${fmt(raw, unit)}` }
    })
    const gameData = inWin.map((it) => {
      const dg = byDay[it.date]
      const raw = metricValue(goal.metric_key, [it.g], playersFor(new Set([it.g.id])))
      const pct = prognosticPct(raw, par, higher)
      return { date: it.date, idxInDay: dg.indexOf(it.g), dayCount: dg.length, pct, tip: pct == null ? null : `${it.date.slice(5)} · ${dpct(pct)} · ${fmt(raw, unit)}` }
    })
    const latestPct = [...dayData].reverse().find((d) => d.pct != null)?.pct ?? null
    dm = { start: pStart, end: pEnd, today, dayData, gameData, par, parLabel: `${fmt(par, unit)} vs ${cycleOpp}`, baselineTip: `100% line = ${fmt(par, unit)} vs ${cycleOpp} — every completed game before July (${parGames.length} games)`, latestPct }
  }

  return { meta, unit, higher, points, latest, prev, latestDate, prevDate, delta, wtd, baseline, target, onTrack, improving, dayState, weekState, weekDelta, remaining, met, prob, par, dm }
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------
function Sparkline({ points, target, higher }) {
  const vals = points.map((p) => p.value).filter((x) => x != null)
  if (vals.length < 2) return null
  const all = target != null ? [...vals, target] : vals
  const min = Math.min(...all), max = Math.max(...all)
  const span = max - min || 1
  const W = 130, H = 30
  const step = W / (points.length - 1)
  const y = (v) => H - ((v - min) / span) * (H - 6) - 3
  const path = points.map((p, i) => (p.value == null ? null : `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p.value).toFixed(1)}`)).filter(Boolean).join(' ')
  return (
    <svg width={W} height={H} style={{ overflow: 'visible' }}>
      {target != null && <line x1="0" y1={y(target)} x2={W} y2={y(target)} stroke="#c9a227" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />}
      <path d={path} fill="none" stroke="#4c8bf5" strokeWidth="2" />
      {points.map((p, i) => p.value != null && (
        <circle key={i} cx={i * step} cy={y(p.value)} r={i === points.length - 1 ? 3.2 : 1.8} fill="#4c8bf5" />
      ))}
    </svg>
  )
}

// horizontal track: baseline ---- current ---- target
function StandBar({ baseline, current, target, higher, onTrack }) {
  if (baseline == null || target == null) return null
  const lo = Math.min(baseline, target), hi = Math.max(baseline, target)
  const pad = (hi - lo) * 0.15 || 1
  const min = lo - pad, max = hi + pad
  const pos = (v) => `${clamp(((v - min) / (max - min)) * 100, 0, 100)}%`
  const fillColor = onTrack ? '#3aa76d' : '#e0a940'
  const curPct = current != null ? clamp(((current - min) / (max - min)) * 100, 0, 100) : null
  const basePct = clamp(((baseline - min) / (max - min)) * 100, 0, 100)
  const tgtPct = clamp(((target - min) / (max - min)) * 100, 0, 100)
  return (
    <div style={{ position: 'relative', height: 26, margin: '10px 0 4px' }}>
      <div style={{ position: 'absolute', top: 11, left: 0, right: 0, height: 4, borderRadius: 3, background: '#2a2f3a' }} />
      {curPct != null && (
        <div style={{ position: 'absolute', top: 11, left: `${Math.min(basePct, curPct)}%`, width: `${Math.abs(curPct - basePct)}%`, height: 4, borderRadius: 3, background: fillColor }} />
      )}
      {/* baseline tick */}
      <div style={{ position: 'absolute', top: 6, left: pos(baseline), width: 2, height: 14, background: '#676f7d', transform: 'translateX(-1px)' }} title="baseline" />
      {/* target tick */}
      <div style={{ position: 'absolute', top: 4, left: pos(target), width: 2, height: 18, background: '#c9a227', transform: 'translateX(-1px)' }} title="target" />
      {/* current marker */}
      {curPct != null && (
        <div style={{ position: 'absolute', top: 7, left: `${curPct}%`, width: 12, height: 12, borderRadius: '50%', background: fillColor, border: '2px solid #10131a', transform: 'translateX(-6px)' }} title="current" />
      )}
    </div>
  )
}

function ProbChip({ prob }) {
  if (prob == null) return <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>—</span>
  const c = probColor(prob)
  return (
    <span
      title="Readiness: how far this goal is toward target, nudged by the last scrim day's direction. Not a prediction."
      style={{ fontSize: 12, fontWeight: 700, padding: '3px 9px', borderRadius: 20, background: `${c}22`, color: c, whiteSpace: 'nowrap', cursor: 'help' }}
    >
      {prob}% ready
    </span>
  )
}

const DAY_VERDICT = {
  up: { t: 'Improved today', col: '#3aa76d', a: '▲' },
  down: { t: 'Slipped today', col: '#e0524a', a: '▼' },
  flat: { t: 'Held flat', col: '#e0a940', a: '—' },
  none: { t: 'No new day yet', col: '#8a91a0', a: '·' },
}
const WEEK_VERDICT = {
  up: { t: 'Up this week', col: '#3aa76d', a: '▲' },
  down: { t: 'Below baseline', col: '#e0524a', a: '▼' },
  flat: { t: 'At baseline', col: '#e0a940', a: '—' },
  none: { t: 'week —', col: '#8a91a0', a: '·' },
}

function VerdictPill({ state, map, prefix, title }) {
  const v = map[state || 'none']
  return (
    <span title={title} style={{ fontSize: 11.5, fontWeight: 800, padding: '4px 10px', borderRadius: 20, background: `${v.col}22`, color: v.col, whiteSpace: 'nowrap', cursor: title ? 'help' : 'default' }}>
      {prefix ? <span style={{ opacity: 0.6, fontWeight: 700, marginRight: 4 }}>{prefix}</span> : null}{v.a} {v.t}
    </span>
  )
}

// count how many goals improved today and how many are up this week
function rollup(list) {
  const withDay = list.filter((x) => x.c.dayState)
  const withWeek = list.filter((x) => x.c.weekState)
  return {
    up: withDay.filter((x) => x.c.dayState === 'up').length,
    down: withDay.filter((x) => x.c.dayState === 'down').length,
    flat: withDay.filter((x) => x.c.dayState === 'flat').length,
    total: withDay.length,
    wUp: withWeek.filter((x) => x.c.weekState === 'up').length,
    wTotal: withWeek.length,
  }
}

// "X of Y improved today · X of Y up this week" — the accountability read
function ReportCard({ r, size = 'lg' }) {
  if (!r.total && !r.wTotal) return <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>no data to compare yet</span>
  const big = size === 'lg' ? 15 : 12.5
  const small = size === 'lg' ? 12 : 11
  const dayGood = r.up >= Math.ceil(r.total / 2)
  const weekGood = r.wUp >= Math.ceil(r.wTotal / 2)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {r.total > 0 && (
        <span style={{ fontWeight: 800, color: dayGood ? '#3aa76d' : '#e0a940', fontSize: big }}>
          {r.up}/{r.total} improved today
          {r.down > 0 && <span style={{ color: '#e0524a', fontWeight: 700, fontSize: small }}> ▼{r.down}</span>}
        </span>
      )}
      {r.wTotal > 0 && (
        <span style={{ fontWeight: 700, color: weekGood ? '#3aa76d' : '#e0a940', fontSize: small }}>
          · {r.wUp}/{r.wTotal} up this week
        </span>
      )}
    </span>
  )
}

const LBL_HELP = { fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em', cursor: 'help' }

function GoalRow({ goal, c, compact, opponent }) {
  const stateColor = (s) => s === 'up' ? '#3aa76d' : s === 'down' ? '#e0524a' : s === 'flat' ? '#e0a940' : 'var(--text-faint)'
  const dc = stateColor(c.dayState)
  const wc = stateColor(c.weekState)
  const gapMag = (v, unit) => unit === '%' ? `${Math.round(v)}%` : unit === 'gold' ? `${Math.round(v)}` : (unit === 'CS' || unit === 'CS/min') ? v.toFixed(1) : `${Math.round(v * 10) / 10}`
  const gapText = c.remaining == null ? '—' : c.met ? 'target met ✓' : `${gapMag(c.remaining, c.unit)} to go`
  // the master explainer for this goal — what the number is, where it comes
  // from, how the baseline/target were set, and how the two verdicts are read
  const opp = opponent || 'the opponent'
  const baseTxt = c.baseline != null ? ` Baseline (${fmt(c.baseline, c.unit)}) is our average over the last 5 games vs ${opp} — the starting point.` : ''
  const tgtTxt = c.target != null ? ` Target (${fmt(c.target, c.unit)}) is this week's goal, set ${c.higher ? 'above' : 'below'} the baseline toward the level we hit in our wins.` : ''
  const help = `${METRIC_HELP[goal.metric_key] || c.meta.description || c.meta.label || goal.metric_key}${baseTxt}${tgtTxt} “Improved today” compares the latest scrim day to the day before; “Up this week” compares all this week's scrims combined against the baseline.`
  return (
    <div style={{ padding: '12px 0', borderTop: '1px solid var(--border, #2b2b33)' }}>
      {/* headline: the accountability call — day-by-day and running week */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontWeight: 600, fontSize: compact ? 13 : 14 }}>
          {c.meta.label || goal.metric_key}
          <InfoTip text={help} />
          <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{goal.intent}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <VerdictPill state={c.dayState} map={DAY_VERDICT} title="Did the number improve on the latest scrim day versus the day before?" />
          <VerdictPill state={c.weekState} map={WEEK_VERDICT} title="Is the combined week-to-date number above the baseline we started the week from?" />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginTop: 6 }}>
        <div>
          <div style={LBL_HELP} title={COL_HELP.today}>Today{c.latestDate ? ` · ${c.latestDate.slice(5)}` : ''}</div>
          <div style={{ fontSize: 24, fontWeight: 800, lineHeight: 1.1, color: dc }}>{fmt(c.latest, c.unit)}</div>
        </div>
        <div>
          <div style={LBL_HELP} title={COL_HELP.yesterday}>vs yesterday{c.prevDate ? ` · ${c.prevDate.slice(5)}` : ''}</div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>
            <span style={{ color: 'var(--text-faint)' }}>{fmt(c.prev, c.unit)}</span>
            {c.delta != null && <span style={{ color: dc, marginLeft: 8 }}>{c.dayState === 'up' ? '▲' : c.dayState === 'down' ? '▼' : ''}{fmtDelta(c.delta, c.unit)}</span>}
          </div>
        </div>
        <div>
          <div style={LBL_HELP} title={COL_HELP.week}>Week so far</div>
          <div style={{ fontSize: 16, fontWeight: 800, color: wc }}>
            {fmt(c.wtd, c.unit)}
            {c.weekDelta != null && <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 6 }}>{c.weekState === 'up' ? '▲' : c.weekState === 'down' ? '▼' : '—'}{gapMag(Math.abs(c.weekDelta), c.unit)} vs base</span>}
          </div>
        </div>
        <div>
          <div style={LBL_HELP} title={COL_HELP.gap}>Gap to target</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: c.met ? '#3aa76d' : '#c9a227' }}>{gapText}</div>
        </div>
        {c.dm && c.dm.latestPct != null && (
          <div style={{ marginLeft: 'auto', textAlign: 'right' }}>
            <div style={LBL_HELP} title={`Prognostic — our latest scrim day as a % of our frozen before-July baseline vs ${opponent || 'the opponent'}. 100% = at that baseline; over 100% = improvement by definition.`}>vs {opponent || 'opp'} 100%</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: c.dm.latestPct >= 100 ? '#3aa76d' : '#e0524a' }}>{fmtPct(c.dm.latestPct)}</div>
          </div>
        )}
      </div>

      {c.dm
        ? <div style={{ marginTop: 8 }}><DmGraph start={c.dm.start} end={c.dm.end} today={c.dm.today} dayData={c.dm.dayData} gameData={c.dm.gameData} showProjection parLabel={c.dm.parLabel} baselineTip={c.dm.baselineTip} compact={compact} /></div>
        : (
          <>
            <StandBar baseline={c.baseline} current={c.latest} target={c.target} higher={c.higher} onTrack={c.met} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--text-faint)' }}>
              <span style={{ cursor: 'help' }} title={COL_HELP.baseline}>baseline {fmt(c.baseline, c.unit)}</span>
              <span style={{ cursor: 'help' }} title={COL_HELP.target}>target {fmt(c.target, c.unit)}</span>
            </div>
          </>
        )}
    </div>
  )
}

// editable, auto-saving note
function NoteBox({ value, onSave, placeholder }) {
  const [text, setText] = useState(value || '')
  const [saved, setSaved] = useState(false)
  useEffect(() => { setText(value || '') }, [value])
  const dirty = (text || '') !== (value || '')
  return (
    <div style={{ marginTop: 8 }}>
      <textarea
        value={text}
        placeholder={placeholder}
        onChange={(e) => { setText(e.target.value); setSaved(false) }}
        onBlur={() => { if (dirty) { onSave(text); setSaved(true) } }}
        rows={2}
        style={{ width: '100%', resize: 'vertical', background: 'var(--panel-2, #14161c)', color: 'var(--text)', border: '1px solid var(--border, #2b2b33)', borderRadius: 8, padding: '8px 10px', fontSize: 13, fontFamily: 'inherit' }}
      />
      <div style={{ height: 14, fontSize: 11, color: dirty ? '#e0a940' : saved ? '#3aa76d' : 'var(--text-faint)' }}>
        {dirty ? 'unsaved — click away to save' : saved ? 'saved ✓' : ''}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Win-condition analysis vs the upcoming opponent (top swing factors)
// ---------------------------------------------------------------------------
function conditionLift(games, testFn) {
  const yes = games.filter((g) => testFn(g) === true)
  const no = games.filter((g) => testFn(g) === false)
  const wY = yes.length ? (yes.filter((g) => g.sentinels_won).length / yes.length) * 100 : null
  const wN = no.length ? (no.filter((g) => g.sentinels_won).length / no.length) * 100 : null
  return wY != null && wN != null ? wY - wN : null
}
const WIN_CONDS = [
  { label: 'First Blood', test: (g) => g.first_blood_sentinels === true ? true : g.first_blood_sentinels === false ? false : null },
  { label: 'First Tower', test: (g) => g.first_tower_sentinels === true ? true : g.first_tower_sentinels === false ? false : null },
  { label: 'Gold lead @15', test: (g) => g.gold_diff_15 == null ? null : g.gold_diff_15 > 0 },
  { label: 'CS lead @15', test: (g) => g.cs_diff_15 == null ? null : g.cs_diff_15 > 0 },
  { label: 'First Herald', test: (g) => g.sentinels_heralds == null ? null : g.sentinels_heralds > 0 },
  { label: 'Grub majority (4+)', test: (g) => g.sentinels_grubs == null ? null : g.sentinels_grubs >= 4 },
]

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export default function DailyBriefing() {
  const { data: goals, loading: goalsLoading, refetch: refetchGoals } = useSupabaseQuery(() => supabase.from('prep_goals').select('*').eq('active', true), [])
  const { data: library, refetch: refetchLib } = useSupabaseQuery(() => supabase.from('goal_library').select('*'), [])
  const { data: seriesRows, refetch: refetchSeries } = useSupabaseQuery(() => supabase.from('grid_series').select('grid_series_id, series_date, series_type, opponent_name'), [])
  const { data: gameRows, refetch: refetchGames } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, game_number, sentinels_won, manual_won, excluded, riot_enriched, game_duration_s, gold_diff_15, cs_diff_15, first_blood_sentinels, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_heralds, sentinels_grubs, positive_plays, give_backs, snowballs'
    )), []
  )
  const { data: playerRows, refetch: refetchPlayers } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select(
      'game_id, player, cs_diff_15, gold_diff_15, cs_per_min, kill_participation, champ_damage_share, champ_damage_per_min, vision_score'
    ).eq('is_sentinels', true)), []
  )
  const { data: contentRows, refetch: refetchContent } = useSupabaseQuery(() => supabase.from('briefing_content').select('key, value'), [])

  // "Updated at" stamp + manual refresh. The page also refetches automatically
  // every time you open the tab, so running Daily Sync then coming here shows
  // the day's fresh data; Refresh is for when it's left open across a sync.
  const [updatedAt, setUpdatedAt] = useState(null)
  useEffect(() => { if (gameRows) setUpdatedAt(new Date()) }, [gameRows])
  const refreshAll = useCallback(() => {
    refetchGoals(); refetchLib(); refetchSeries(); refetchGames(); refetchPlayers(); refetchContent()
  }, [refetchGoals, refetchLib, refetchSeries, refetchGames, refetchPlayers, refetchContent])

  const lib = useMemo(() => Object.fromEntries((library || []).map((l) => [l.metric_key, l])), [library])
  const seriesById = useMemo(() => Object.fromEntries((seriesRows || []).map((s) => [s.grid_series_id, s])), [seriesRows])
  const content = useMemo(() => Object.fromEntries((contentRows || []).map((r) => [r.key, r.value])), [contentRows])

  const saveContent = useCallback(async (key, value) => {
    await supabase.from('briefing_content').upsert({ key, value, updated_at: new Date().toISOString() })
    refetchContent()
  }, [refetchContent])

  const games = gameRows || []
  const prows = playerRows || []

  const cycleOpp = (goals && goals[0]?.cycle_opponent) || null
  const cycleDate = (goals && goals[0]?.cycle_official_date) || null
  const daysUntil = useMemo(() => {
    if (!cycleDate) return null
    const now = new Date(); now.setHours(0, 0, 0, 0)
    const d = new Date(`${cycleDate}T00:00:00`)
    return Math.round((d - now) / 86400000)
  }, [cycleDate])

  // Head-to-head vs the upcoming opponent — completed games only (remakes excluded)
  const vsOpp = useMemo(() => {
    const scrim = { w: 0, l: 0 }, official = { w: 0, l: 0 }
    for (const g of games) {
      const s = seriesById[g.grid_series_id]
      if (!s || g.excluded) continue
      const won = g.manual_won ?? g.sentinels_won
      if (won == null) continue
      if (!cycleOpp || canonicalOpponentName(s.opponent_name || '') !== cycleOpp) continue
      if (!((g.riot_enriched && g.game_duration_s >= MIN_REAL_GAME_S) || g.manual_won != null)) continue
      const b = s.series_type === 'ESPORTS' ? official : s.series_type === 'SCRIM' ? scrim : null
      if (!b) continue
      if (won) b.w++; else b.l++
    }
    const wr = (b) => { const n = b.w + b.l; return n ? Math.round((b.w / n) * 100) : null }
    return {
      scrim, official, scrimWR: wr(scrim), officialWR: wr(official),
      totW: scrim.w + official.w, totL: scrim.l + official.l,
      totN: scrim.w + scrim.l + official.w + official.l,
    }
  }, [games, seriesById, cycleOpp])

  // computed goals
  const teamComputed = useMemo(() => (goals || []).filter((g) => g.scope === 'team')
    .map((g) => ({ goal: g, c: computeGoal(g, lib, seriesById, games, prows, cycleOpp) })), [goals, lib, seriesById, games, prows, cycleOpp])
  const playerComputed = useMemo(() => (goals || []).filter((g) => g.scope === 'player')
    .map((g) => ({ goal: g, c: computeGoal(g, lib, seriesById, games, prows, cycleOpp) }))
    .sort((a, b) => ROSTER.indexOf(a.goal.player) - ROSTER.indexOf(b.goal.player)), [goals, lib, seriesById, games, prows, cycleOpp])

  const allProbs = [...teamComputed, ...playerComputed].map((x) => x.c.prob).filter((p) => p != null)
  const teamProb = allProbs.length ? Math.round(allProbs.reduce((a, b) => a + b, 0) / allProbs.length) : null

  const playerGroups = useMemo(() => {
    const m = {}
    for (const pc of playerComputed) (m[pc.goal.player] ??= []).push(pc)
    return ROSTER.filter((p) => m[p]).map((p) => ({ player: p, goals: m[p] }))
  }, [playerComputed])

  // win conditions vs opponent (data-derived top 3, with coach override)
  const derivedConds = useMemo(() => {
    if (!cycleOpp) return []
    const oppGames = games.filter((g) => { const s = seriesById[g.grid_series_id]; return s && !g.excluded && g.riot_enriched && g.sentinels_won != null && g.game_duration_s >= MIN_REAL_GAME_S && canonicalOpponentName(s.opponent_name || '') === cycleOpp })
    const pool = oppGames.length >= 6 ? oppGames : games.filter((g) => !g.excluded && g.riot_enriched && g.sentinels_won != null && g.game_duration_s >= MIN_REAL_GAME_S)
    const scored = WIN_CONDS.map((wc) => ({ label: wc.label, lift: conditionLift(pool, wc.test) })).filter((x) => x.lift != null)
    scored.sort((a, b) => b.lift - a.lift)
    return { top: scored.slice(0, 3), fromOpp: oppGames.length >= 6, n: pool.length }
  }, [games, seriesById, cycleOpp])

  const [editWC, setEditWC] = useState(false)
  const winConditionText = (slot) => {
    const ov = content[`wc:${cycleOpp}:${slot}`]
    if (ov != null && ov !== '') return ov
    return derivedConds.top?.[slot]?.label || null
  }

  const loading = goalsLoading || !gameRows || !playerRows || !seriesRows
  const kpi = (label, value, sub, color, info) => (
    <div style={{ background: 'var(--panel-2, #14161c)', border: '1px solid var(--border, #2b2b33)', borderRadius: 12, padding: '14px 18px', minWidth: 140 }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}{info ? <InfoTip text={info} /> : null}</div>
      <div style={{ fontSize: 30, fontWeight: 800, lineHeight: 1.1, color: color || 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  )

  return (
    <div>
      {/* ---------------- HERO ---------------- */}
      <div className="panel" style={{ background: 'linear-gradient(135deg, #1a1130 0%, #10131a 60%)' }}>
        {loading ? (
          <div className="loading-state">Loading briefing…</div>
        ) : !cycleOpp ? (
          <div className="empty-state">No prep cycle set yet — add this week&apos;s goals and the briefing fills in.</div>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
              <div style={{ fontSize: 12, letterSpacing: '.14em', color: '#c9a227', textTransform: 'uppercase', fontWeight: 700 }}>Daily Briefing</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {updatedAt && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>updated {updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
                <button type="button" onClick={refreshAll} style={{ fontSize: 12, color: 'var(--text)', background: 'transparent', border: '1px solid var(--border,#2b2b33)', borderRadius: 8, padding: '4px 12px', cursor: 'pointer' }}>
                  ↻ Refresh
                </button>
              </div>
            </div>
            <div style={{ fontSize: 30, fontWeight: 800, margin: '4px 0 2px' }}>
              {daysUntil != null && daysUntil >= 0
                ? <>In <span style={{ color: '#e01e37' }}>{daysUntil}</span> {daysUntil === 1 ? 'day' : 'days'} we play <span style={{ color: '#fff' }}>{cycleOpp}</span></>
                : <>Next official: <span style={{ color: '#fff' }}>{cycleOpp}</span></>}
            </div>
            {cycleDate && <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>Official — {cycleDate}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>Updates from the day&apos;s scrims each time you run Daily Sync.</div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
              {kpi(`Record vs ${cycleOpp}`, vsOpp.totN ? `${vsOpp.totW}–${vsOpp.totL}` : '—', `${vsOpp.totN} completed games`, undefined, `Completed games only — remakes and games under ${Math.round(MIN_REAL_GAME_S / 60)} min are excluded, so this matches your real head-to-head.`)}
              {kpi(`Scrims vs ${cycleOpp}`, vsOpp.scrimWR != null ? `${vsOpp.scrimWR}%` : '—', `${vsOpp.scrim.w}–${vsOpp.scrim.l} in scrims`)}
              {kpi(`Officials vs ${cycleOpp}`, vsOpp.official.w + vsOpp.official.l ? `${vsOpp.official.w}–${vsOpp.official.l}` : '—', `${vsOpp.official.w + vsOpp.official.l} official games`)}
              {kpi('Goal readiness', teamProb != null ? `${teamProb}%` : '—', 'avg progress to this week’s targets', probColor(teamProb), READINESS_HELP)}
            </div>

            {/* win conditions */}
            <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid #2b2b3a' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 12, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Win conditions</span>
                <button type="button" onClick={() => setEditWC((v) => !v)} style={{ fontSize: 11, color: '#8a91a0', background: 'transparent', border: '1px solid var(--border,#2b2b33)', borderRadius: 6, padding: '2px 8px', cursor: 'pointer' }}>
                  {editWC ? 'done' : 'edit'}
                </button>
                {derivedConds.top && !derivedConds.fromOpp && <span style={{ fontSize: 10, color: 'var(--text-faint)' }}>(from all opponents — thin sample vs {cycleOpp})</span>}
              </div>
              {!editWC ? (
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
                  {[0, 1, 2].map((slot) => {
                    const t = winConditionText(slot)
                    return t ? (
                      <span key={slot} style={{ fontSize: 15, fontWeight: 700, padding: '6px 14px', borderRadius: 10, background: '#ffffff0d', border: '1px solid #3a3a4a' }}>
                        <span style={{ color: '#c9a227', marginRight: 6 }}>{slot + 1}</span>{t}
                      </span>
                    ) : null
                  })}
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8, marginTop: 8, maxWidth: 460 }}>
                  {[0, 1, 2].map((slot) => (
                    <div key={slot} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: '#c9a227', fontWeight: 700 }}>{slot + 1}</span>
                      <input
                        defaultValue={content[`wc:${cycleOpp}:${slot}`] || ''}
                        placeholder={derivedConds.top?.[slot]?.label || 'win condition'}
                        onBlur={(e) => saveContent(`wc:${cycleOpp}:${slot}`, e.target.value)}
                        style={{ flex: 1, background: 'var(--panel-2, #14161c)', color: 'var(--text)', border: '1px solid var(--border,#2b2b33)', borderRadius: 8, padding: '7px 10px', fontSize: 13 }}
                      />
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>Leave blank to use the data-derived condition. Data picks: {(derivedConds.top || []).map((c) => `${c.label} (${c.lift > 0 ? '+' : ''}${Math.round(c.lift)}%)`).join(' · ') || '—'}</div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {!loading && cycleOpp && (
        <>
          {/* ---------------- TEAM ---------------- */}
          <div className="panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <h2 style={{ marginBottom: 2 }}>Where we stand — as a team</h2>
              <ReportCard r={rollup(teamComputed)} />
            </div>
            <p className="panel-caption" style={{ marginTop: 0 }}>
              Two reads per goal: <b>did it improve today</b> (latest scrim day vs the day before) and <b>is it up this week</b> (all prep-week
              scrims combined vs the baseline we started from). The graph is the prognostic view — every scrim since 1 July as a % of our frozen before-July baseline vs {cycleOpp}: the <b style={{ color: '#c9a227' }}>100% line</b> is that baseline, and anything <b style={{ color: '#3aa76d' }}>over 100%</b> means we&apos;re heading in better than we&apos;ve historically played them. The pills give the daily and running verdicts.
            </p>
            {teamComputed.length === 0 ? <div className="empty-state">No team goals active.</div> : (
              <div>{teamComputed.map(({ goal, c }) => <GoalRow key={goal.id} goal={goal} c={c} opponent={cycleOpp} />)}</div>
            )}
            <NoteBox value={content['note:__team__']} onSave={(v) => saveContent('note:__team__', v)} placeholder="Coach note to the team for today — focus, reminder, message for the room…" />
          </div>

          {/* ---------------- INDIVIDUAL ---------------- */}
          <div className="panel">
            <h2 style={{ marginBottom: 2 }}>Individual accountability</h2>
            <p className="panel-caption" style={{ marginTop: 0 }}>
              Every player owns their number. Same read as above, per person — plus a spot for a direct reminder from the coach that carries over day to day.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(360px, 1fr))', gap: 14 }}>
              {playerGroups.map(({ player, goals: pg }) => {
                const probs = pg.map((x) => x.c.prob).filter((p) => p != null)
                const pProb = probs.length ? Math.round(probs.reduce((a, b) => a + b, 0) / probs.length) : null
                return (
                  <div key={player} style={{ border: '1px solid var(--border, #2b2b33)', borderRadius: 12, padding: '14px 16px', background: 'var(--panel-2, #14161c)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#c9a227' }}>{player}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <ReportCard r={rollup(pg)} size="sm" />
                        <ProbChip prob={pProb} />
                      </div>
                    </div>
                    {pg.map(({ goal, c }) => <GoalRow key={goal.id} goal={goal} c={c} compact opponent={cycleOpp} />)}
                    <NoteBox value={content[`note:${player}`]} onSave={(v) => saveContent(`note:${player}`, v)} placeholder={`Reminder for ${player}…`} />
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
