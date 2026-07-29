import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'

// A League game can't end before 15:00 — shorter rows are remakes/aborts and
// are excluded so their junk stats don't skew the readings.
const MIN_REAL_GAME_S = 900

// DM Performance Visualization Graph colours
const C_START = '#8a91a0'   // A — where we started (grey dashed)
const C_TARGET = '#c9a227'  // B — the target (gold dashed)
const C_TREND = '#4c8bf5'   // C — the trend (best-fit direction, blue)
const C_GAME = '#2dd4bf'    // D — each individual game (teal)
const C_TODAY = '#e5534b'

const avg = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
const rate = (arr, f) => { const v = arr.map(f).filter((x) => x != null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : null }

// ---- date helpers (calendar days, TZ-safe via UTC noon) --------------------
const parseISO = (s) => new Date(s + 'T12:00:00Z')
const isoOf = (d) => d.toISOString().slice(0, 10)
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000)
const addDaysISO = (s, n) => { const d = parseISO(s); d.setUTCDate(d.getUTCDate() + n); return isoOf(d) }
const todayISO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })
const rangeDates = (start, end) => { const out = []; const n = daysBetween(start, end); for (let i = 0; i <= n; i++) out.push(addDaysISO(start, i)); return out }
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const wdOf = (s) => WD[parseISO(s).getUTCDay()]

// least-squares slope through {x, y} points
function lsqSlope(pts) {
  const n = pts.length
  if (n < 2) return null
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  for (const p of pts) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y }
  const d = n * sxx - sx * sx
  if (d === 0) return null
  return (n * sxy - sx * sy) / d
}

// value of a metric over a set of team-game rows and/or player rows
function metricValue(key, games, prows) {
  switch (key) {
    case 'team_gold_diff_15': return avg(games, (g) => g.gold_diff_15)
    case 'team_cs_diff_15': return avg(games, (g) => g.cs_diff_15)
    case 'first_tower_rate': return rate(games, (g) => g.first_tower_sentinels)
    case 'first_dragon_rate': return rate(games, (g) => (g.sentinels_dragons != null && g.opponent_dragons != null ? g.sentinels_dragons > g.opponent_dragons : null))
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
const axisFmt = (v, unit) => {
  if (v == null) return ''
  if (unit === '%') return `${Math.round(v)}%`
  if (unit === 'gold') return Math.round(v)
  return Math.round(v * 10) / 10
}
const fmtDelta = (d, unit) => {
  if (d == null) return '—'
  const s = d > 0 ? '+' : ''
  if (unit === '%') return `${s}${Math.round(d)}%`
  if (unit === 'gold') return `${s}${Math.round(d)}`
  if (unit === 'CS' || unit === 'CS/min') return `${s}${d.toFixed(1)}`
  return `${s}${Math.round(d * 10) / 10}`
}
const LBL = { fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em' }

// =====================================================================
// DM Performance Visualization Graph
//   A = start (avg on the start date)   B = target
//   C = trend (best-fit direction, solid to today, dashed projection to end)
//   D = each individual game
//   x-axis = the dates from start to end · y-axis = the metric's numbers
// =====================================================================
function DmGraph({ model, unit }) {
  const { start, end, today, totalDays, startVal, target, slope, dayData, gameData } = model
  const allVals = [
    ...gameData.map((g) => g.value),
    ...dayData.map((d) => d.value),
    startVal, target,
    slope != null && startVal != null ? startVal + slope * totalDays : null,
  ].filter((x) => x != null)
  if (allVals.length < 1) {
    return <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>No scrims in this window yet — the graph fills in as you sync each day.</span>
  }
  const min = Math.min(...allVals), max = Math.max(...allVals)
  const pad = (max - min) * 0.16 || Math.abs(max) * 0.16 || 1
  const lo = min - pad, hi = max + pad

  const W = 1000, H = 150
  const px = (dayNum) => (dayNum / totalDays) * W
  const pxDate = (d) => px(daysBetween(start, d))
  const y = (v) => H - ((v - lo) / (hi - lo)) * H
  const pctTop = (v) => (1 - (v - lo) / (hi - lo)) * 100
  const pctLeft = (dayNum) => (dayNum / totalDays) * 100

  const dayWidth = W / totalDays
  const todayDayNum = Math.max(0, Math.min(totalDays, daysBetween(start, today)))

  // C — trend line anchored at the start value, using the least-squares slope.
  const trend = (dn) => startVal + slope * dn
  const trendSolid = slope != null && startVal != null
    ? `M${px(0).toFixed(1)},${y(trend(0)).toFixed(1)} L${px(todayDayNum).toFixed(1)},${y(trend(todayDayNum)).toFixed(1)}` : null
  const trendProj = slope != null && startVal != null && todayDayNum < totalDays
    ? `M${px(todayDayNum).toFixed(1)},${y(trend(todayDayNum)).toFixed(1)} L${px(totalDays).toFixed(1)},${y(trend(totalDays)).toFixed(1)}` : null

  // D — each game (nudged within its day so a day's sequence reads left→right)
  const gPts = gameData.map((g) => {
    const base = pxDate(g.date)
    const frac = g.dayCount > 1 ? (g.idxInDay / (g.dayCount - 1)) : 0.5
    return { x: base + frac * dayWidth * 0.6, value: g.value }
  }).filter((p) => p.value != null)
  const gamePath = gPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')

  // day-average markers
  const dPts = dayData.map((d) => ({ x: pxDate(d.date) + dayWidth * 0.3, value: d.value })).filter((p) => p.value != null)

  const yticks = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4)
  const dateList = rangeDates(start, end)
  const showEvery = dateList.length > 12 ? Math.ceil(dateList.length / 12) : 1

  const leg = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-faint)' }
  const bar = (style) => <span style={{ display: 'inline-block', width: 16, verticalAlign: 'middle', ...style }} />

  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, marginBottom: 8 }}>
        {startVal != null && <span style={leg}>{bar({ borderTop: `2px dashed ${C_START}` })} <b style={{ color: 'var(--text-faint)' }}>A</b> Start {fmt(startVal, unit)}</span>}
        {target != null && <span style={leg}>{bar({ borderTop: `2px dashed ${C_TARGET}` })} <b style={{ color: 'var(--text-faint)' }}>B</b> Target {fmt(target, unit)}</span>}
        <span style={leg}>{bar({ borderTop: `3px solid ${C_TREND}` })} <b style={{ color: 'var(--text-faint)' }}>C</b> Trend</span>
        <span style={leg}>{bar({ borderTop: `2px dashed ${C_TREND}`, opacity: 0.8 })} projection to game day</span>
        <span style={leg}>{bar({ borderTop: `2px solid ${C_GAME}` })} <b style={{ color: 'var(--text-faint)' }}>D</b> Each game</span>
      </div>

      <div style={{ display: 'flex' }}>
        {/* y-axis — the metric's numbers */}
        <div style={{ position: 'relative', width: 46, minHeight: H }}>
          {yticks.map((v, i) => (
            <span key={i} style={{ position: 'absolute', right: 6, top: `calc(${pctTop(v)}% - 7px)`, fontSize: 10, color: 'var(--text-faint)' }}>{axisFmt(v, unit)}</span>
          ))}
        </div>

        {/* plot area */}
        <div style={{ position: 'relative', flex: 1 }}>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
            {yticks.map((v, i) => <line key={i} x1="0" y1={y(v)} x2={W} y2={y(v)} stroke="var(--border, #2b2b33)" strokeWidth="1" opacity="0.5" vectorEffect="non-scaling-stroke" />)}
            {/* today marker */}
            <line x1={px(todayDayNum)} y1="0" x2={px(todayDayNum)} y2={H} stroke={C_TODAY} strokeWidth="1" strokeDasharray="3 4" opacity="0.6" vectorEffect="non-scaling-stroke" />
            {/* A — start */}
            {startVal != null && <line x1="0" y1={y(startVal)} x2={W} y2={y(startVal)} stroke={C_START} strokeWidth="1.5" strokeDasharray="2 7" opacity="0.85" vectorEffect="non-scaling-stroke" />}
            {/* B — target */}
            {target != null && <line x1="0" y1={y(target)} x2={W} y2={y(target)} stroke={C_TARGET} strokeWidth="2" strokeDasharray="9 5" opacity="0.95" vectorEffect="non-scaling-stroke" />}
            {/* D — each game */}
            <path d={gamePath} fill="none" stroke={C_GAME} strokeWidth="1.5" opacity="0.55" vectorEffect="non-scaling-stroke" />
            {gPts.map((p, i) => <circle key={`g${i}`} cx={p.x} cy={y(p.value)} r={2} fill={C_GAME} opacity="0.8" vectorEffect="non-scaling-stroke" />)}
            {/* day-average markers */}
            {dPts.map((p, i) => <circle key={`d${i}`} cx={p.x} cy={y(p.value)} r={2.5} fill={C_TREND} opacity="0.5" vectorEffect="non-scaling-stroke" />)}
            {/* C — trend + projection */}
            {trendSolid && <path d={trendSolid} fill="none" stroke={C_TREND} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
            {trendProj && <path d={trendProj} fill="none" stroke={C_TREND} strokeWidth="2.5" strokeDasharray="7 5" opacity="0.85" vectorEffect="non-scaling-stroke" />}
          </svg>

          {/* today label */}
          <span style={{ position: 'absolute', top: -2, left: `calc(${pctLeft(todayDayNum)}% - 2px)`, transform: 'translateX(-50%)', fontSize: 9, color: C_TODAY, whiteSpace: 'nowrap' }}>today</span>

          {/* x-axis — the dates */}
          <div style={{ position: 'relative', height: 26, marginTop: 2 }}>
            {dateList.map((d, i) => {
              if (i % showEvery !== 0 && d !== end) return null
              const isEnd = d === end
              return (
                <span key={d} style={{ position: 'absolute', left: `${pctLeft(daysBetween(start, d))}%`, transform: 'translateX(-50%)', fontSize: 9, textAlign: 'center', color: isEnd ? C_TARGET : 'var(--text-faint)', whiteSpace: 'nowrap', lineHeight: 1.15 }}>
                  {wdOf(d)}<br />{d.slice(5)}{isEnd ? ' ★' : ''}
                </span>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function DateField({ label, value, onChange }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ ...LBL, fontSize: 10 }}>{label}</span>
      <input type="date" value={value || ''} onChange={(e) => onChange(e.target.value)}
        style={{ background: 'var(--panel, #10131a)', color: 'var(--text)', border: '1px solid var(--border, #2b2b33)', borderRadius: 6, padding: '5px 7px', fontSize: 12, colorScheme: 'dark' }} />
    </label>
  )
}

function GoalCard({ goal, lib, series, games, prows, opponent, onSaveDates }) {
  const meta = lib[goal.metric_key] || {}
  const unit = meta.unit
  const higher = meta.higher_is_better !== false
  const isLaners = (goal.metric_key || '').startsWith('laners_')
  const playersForDay = (ids) => isLaners
    ? prows.filter((p) => p.player !== 'Huhi' && ids.has(p.game_id))
    : goal.scope === 'player' ? prows.filter((p) => p.player === goal.player && ids.has(p.game_id)) : []

  const start = goal.trend_start_date
  const end = goal.trend_end_date
  const today = todayISO()

  const model = useMemo(() => {
    if (!start || !end) return null
    const totalDays = Math.max(1, daysBetween(start, end))
    const capEnd = today < end ? today : end

    // completed scrim games inside [start, capEnd], with their date
    const inWin = games.map((g) => {
      const s = series[g.grid_series_id]
      if (!s || s.series_type !== 'SCRIM' || !g.riot_enriched || g.game_duration_s < MIN_REAL_GAME_S) return null
      const d = s.series_date
      if (d < start || d > capEnd) return null
      return { g, date: d }
    }).filter(Boolean)
      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date)
        : a.g.grid_series_id !== b.g.grid_series_id ? String(a.g.grid_series_id).localeCompare(String(b.g.grid_series_id))
          : (a.g.game_number ?? 0) - (b.g.game_number ?? 0))

    // group by day
    const byDay = {}
    for (const it of inWin) (byDay[it.date] ??= []).push(it.g)
    const dayData = Object.keys(byDay).sort().map((date) => {
      const dg = byDay[date]
      return { date, value: metricValue(goal.metric_key, dg, playersForDay(new Set(dg.map((g) => g.id)))) }
    }).filter((d) => d.value != null)

    // each game, with its position within the day
    const gameData = inWin.map((it) => {
      const dg = byDay[it.date]
      const idxInDay = dg.indexOf(it.g)
      return { date: it.date, idxInDay, dayCount: dg.length, value: metricValue(goal.metric_key, [it.g], playersForDay(new Set([it.g.id]))) }
    })

    // A = average on the start date, else the earliest day with data
    const startPoint = dayData.find((d) => d.date === start) || dayData[0] || null
    const startVal = startPoint ? startPoint.value : null

    // C = least-squares slope through the day averages (x = days since start)
    const slope = lsqSlope(dayData.map((d) => ({ x: daysBetween(start, d.date), y: d.value })))

    return { start, end, today, totalDays, startVal, target: Number(goal.target_value), slope, dayData, gameData }
  }, [start, end, today, games, series, prows, goal])

  const target = Number(goal.target_value)
  const startVal = model?.startVal
  const slope = model?.slope
  const totalDays = model?.totalDays ?? 1
  const dayData = model?.dayData ?? []

  const latest = dayData.length ? dayData[dayData.length - 1].value : null
  const dayNum = Math.min(totalDays, Math.max(0, daysBetween(start, today > end ? end : today))) + 1
  const projEnd = slope != null && startVal != null ? startVal + slope * totalDays : null

  // classify effectiveness
  const verdict = useMemo(() => {
    if (startVal == null) return { key: 'building', color: C_START, text: 'Waiting on the first day of scrims to set the start point.' }
    if (slope == null || dayData.length < 2) return { key: 'building', color: C_START, text: 'Need another scrim day to read the trend.' }
    const reqSlope = (target - startVal) / totalDays
    const ratio = reqSlope !== 0 ? slope / reqSlope : (Math.abs(slope) < 1e-9 ? 1 : -1)
    const endLbl = `${wdOf(end)} (${end.slice(5)})${opponent ? ` vs ${opponent}` : ''}`
    if (ratio >= 1) return { key: 'onpace', color: '#3fb950', text: `On pace — projecting ${fmt(projEnd, unit)} by ${endLbl}.` }
    if (ratio >= 0.1) return { key: 'short', color: '#d8a531', text: `Improving, but short — at this rate ${fmt(projEnd, unit)} by ${endLbl}, under the ${fmt(target, unit)} target.` }
    if (ratio > -0.1) return { key: 'flat', color: C_START, text: `Flat — no real movement across ${dayData.length} scrim day${dayData.length === 1 ? '' : 's'}. Reps aren't moving the number.` }
    return { key: 'wrong', color: '#e5534b', text: `Going the wrong way — projecting ${fmt(projEnd, unit)} by ${endLbl}, away from the ${fmt(target, unit)} target.` }
  }, [startVal, slope, dayData, target, totalDays, end, opponent, projEnd, unit])

  const vsStart = latest != null && startVal != null ? latest - startVal : null
  const goodDir = vsStart == null ? null : higher ? vsStart >= 0 : vsStart <= 0

  return (
    <div style={{ border: '1px solid var(--border, #2b2b33)', borderRadius: 10, padding: 14, background: 'var(--panel-2, #17171d)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>
            {goal.scope === 'player' && <span style={{ color: '#c9a227', marginRight: 6 }}>{goal.player}</span>}
            {meta.label || goal.metric_key}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', margin: '3px 0 2px' }}>{goal.intent}</div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>Measures: {meta.description || meta.label || goal.metric_key}</div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <DateField label="Start" value={start} onChange={(v) => onSaveDates(goal.id, { trend_start_date: v })} />
          <DateField label="End" value={end} onChange={(v) => onSaveDates(goal.id, { trend_end_date: v })} />
          <button type="button" onClick={() => onSaveDates(goal.id, { trend_start_date: today })}
            title="Re-anchor the start to today — a fresh push"
            style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border, #2b2b33)', background: 'transparent', color: 'var(--text-faint)', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            Reset to today
          </button>
        </div>
      </div>

      {/* verdict — the headline effectiveness read */}
      <div style={{ margin: '12px 0 10px', padding: '8px 12px', borderRadius: 8, background: 'var(--panel, #10131a)', borderLeft: `3px solid ${verdict.color}` }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: verdict.color, textTransform: 'uppercase', letterSpacing: '.03em', marginRight: 8 }}>
          Day {dayNum} of {totalDays}
        </span>
        <span style={{ fontSize: 13, color: 'var(--text)' }}>{verdict.text}</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>
          <div style={LBL}>Start{start ? ` · ${start.slice(5)}` : ''}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C_START }}>{fmt(startVal, unit)}</div>
        </div>
        <div>
          <div style={LBL}>Now (day {dayNum})</div>
          <div style={{ fontSize: 26, fontWeight: 700, lineHeight: 1.1 }}>{fmt(latest, unit)}</div>
        </div>
        <div>
          <div style={LBL}>vs start</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: goodDir == null ? 'var(--text-faint)' : goodDir ? '#3fb950' : '#e5534b' }}>
            {vsStart == null ? '—' : `${goodDir ? '▲' : '▼'} ${fmtDelta(vsStart, unit)}`}
          </div>
        </div>
        <div>
          <div style={LBL}>Proj. by end</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: verdict.color }}>{fmt(projEnd, unit)}</div>
        </div>
        <div>
          <div style={LBL}>Target</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: C_TARGET }}>{fmt(target, unit)}</div>
        </div>
      </div>

      {model ? <DmGraph model={model} unit={unit} />
        : <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>Set a start and end date to draw the graph.</div>}

      {isLaners && (
        <WeakestLink goal={goal} series={series} games={games} prows={prows} start={start} end={end} today={today} unit={unit} />
      )}
    </div>
  )
}

function WeakestLink({ goal, series, games, prows, start, end, today, unit }) {
  const weakest = useMemo(() => {
    if (!start || !end) return null
    const capEnd = today < end ? today : end
    const ids = new Set()
    for (const g of games) {
      const s = series[g.grid_series_id]
      if (s && s.series_type === 'SCRIM' && g.riot_enriched && g.game_duration_s >= MIN_REAL_GAME_S && s.series_date >= start && s.series_date <= capEnd) ids.add(g.id)
    }
    const per = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel']
      .map((pl) => ({ player: pl, value: metricValue(goal.metric_key, [], prows.filter((p) => p.player === pl && ids.has(p.game_id))) }))
      .filter((x) => x.value != null)
    if (!per.length) return null
    return per.reduce((a, b) => (b.value < a.value ? b : a))
  }, [goal, series, games, prows, start, end, today])
  if (!weakest) return null
  return (
    <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-faint)' }}>
      Weakest link: <span style={{ color: '#e5534b', fontWeight: 700 }}>{weakest.player}</span> at {fmt(weakest.value, unit)}
    </div>
  )
}

export default function GoalsTracker() {
  const { data: goals, loading: goalsLoading, refetch: refetchGoals } = useSupabaseQuery(
    () => supabase.from('prep_goals').select('*').eq('active', true), []
  )
  const { data: library } = useSupabaseQuery(() => supabase.from('goal_library').select('*'), [])
  const { data: seriesRows } = useSupabaseQuery(
    () => supabase.from('grid_series').select('grid_series_id, series_date, series_type').gte('series_date', '2026-06-01'), []
  )
  const { data: gameRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, game_number, riot_enriched, game_duration_s, gold_diff_15, cs_diff_15, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_grubs, positive_plays, give_backs, snowballs'
    )), []
  )
  const { data: playerRows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select(
      'game_id, player, cs_diff_15, gold_diff_15, cs_per_min, kill_participation, champ_damage_share, champ_damage_per_min, vision_score'
    ).eq('is_sentinels', true)), []
  )

  const lib = useMemo(() => Object.fromEntries((library || []).map((l) => [l.metric_key, l])), [library])
  const seriesById = useMemo(() => Object.fromEntries((seriesRows || []).map((s) => [s.grid_series_id, s])), [seriesRows])

  const winGameIds = useMemo(() => {
    const ids = new Set()
    for (const g of gameRows || []) if (seriesById[g.grid_series_id]) ids.add(g.id)
    return ids
  }, [gameRows, seriesById])
  const winPlayerRows = useMemo(() => (playerRows || []).filter((p) => winGameIds.has(p.game_id)), [playerRows, winGameIds])
  const winGames = useMemo(() => (gameRows || []).filter((g) => seriesById[g.grid_series_id]), [gameRows, seriesById])

  const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Rahel', 'Huhi']
  const teamGoals = (goals || []).filter((g) => g.scope === 'team')
  const loading = goalsLoading || !gameRows || !playerRows || !seriesRows
  const cycleOpp = (goals && goals[0]?.cycle_opponent) || null
  const cycleDate = (goals && goals[0]?.cycle_official_date) || null

  async function saveDates(id, patch) {
    await supabase.from('prep_goals').update(patch).eq('id', id)
    refetchGoals()
  }

  const [newScope, setNewScope] = useState('team')
  const [newPlayer, setNewPlayer] = useState('Impact')
  const [newText, setNewText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const { data: suggestions, refetch: refetchSug } = useSupabaseQuery(
    () => supabase.from('goal_suggestions').select('*').eq('status', 'proposed').order('created_at', { ascending: false }), []
  )
  async function submitGoal() {
    if (!newText.trim()) return
    setSubmitting(true)
    try {
      await supabase.from('goal_suggestions').insert({ scope: newScope, player: newScope === 'player' ? newPlayer : null, text: newText.trim() })
      setNewText('')
    } finally {
      setSubmitting(false)
      refetchSug()
    }
  }

  return (
    <div className="panel">
      <h2>Team Goals</h2>
      <p className="panel-caption">
        Team-wide SMART targets for the prep week{cycleOpp ? <> — building toward <b style={{ color: 'var(--text)' }}>{cycleOpp}</b>{cycleDate ? ` (${cycleDate})` : ''}</> : ''}.
        Each goal runs on the <b style={{ color: 'var(--text)' }}>DM Performance Visualization Graph</b> between its own start and end dates: <b style={{ color: '#8a91a0' }}>A</b> = where we started (average on the start date), <b style={{ color: '#c9a227' }}>B</b> = the target, <b style={{ color: '#4c8bf5' }}>C</b> = the trend (solid to today, dashed projection to game day), <b style={{ color: '#2dd4bf' }}>D</b> = every individual game. Dates run along the bottom, the metric&apos;s numbers up the side. The verdict tells you if the reps are actually moving the number. Edit a goal&apos;s dates to carry it across weeks or reset it for a fresh push.
      </p>

      {loading && <div className="loading-state">Loading goals…</div>}

      {!loading && teamGoals.length === 0 && (
        <div className="empty-state">No active team goals set. Send me the goals for this week and I&apos;ll load them.</div>
      )}

      {!loading && teamGoals.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14 }}>
          {teamGoals.map((g) => (
            <GoalCard key={g.id} goal={g} lib={lib} series={seriesById} games={winGames} prows={winPlayerRows} opponent={cycleOpp} onSaveDates={saveDates} />
          ))}
        </div>
      )}

      <div style={{ marginTop: 26, borderTop: '1px solid var(--border, #2b2b33)', paddingTop: 18 }}>
        <h3 style={{ marginTop: 0 }}>Propose a goal</h3>
        <p className="panel-caption" style={{ marginTop: 0 }}>
          Coaches: drop a rough goal here in plain language. It lands in the list below, and we shape it into a
          measurable SMART goal in chat before it starts being tracked.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div className="filter-field">
            <label>For</label>
            <select className="search-input" value={newScope} onChange={(e) => setNewScope(e.target.value)}>
              <option value="team">Team</option>
              <option value="player">Player</option>
            </select>
          </div>
          {newScope === 'player' && (
            <div className="filter-field">
              <label>Player</label>
              <select className="search-input" value={newPlayer} onChange={(e) => setNewPlayer(e.target.value)}>
                {ROSTER.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          )}
          <div className="filter-field" style={{ flex: 1, minWidth: 240 }}>
            <label>Goal</label>
            <input
              className="search-input"
              placeholder="e.g. better vision control bot side"
              value={newText}
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitGoal() }}
            />
          </div>
          <button
            type="button"
            disabled={submitting || !newText.trim()}
            onClick={submitGoal}
            style={{ padding: '10px 18px', borderRadius: 8, border: 'none', background: submitting || !newText.trim() ? '#555' : '#e01e37', color: '#fff', fontWeight: 600, cursor: submitting ? 'default' : 'pointer' }}
          >
            {submitting ? 'Adding…' : 'Add goal'}
          </button>
        </div>

        {suggestions && suggestions.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <div style={LBL}>Pending — to shape into SMART goals in chat</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {suggestions.map((s) => (
                <div key={s.id} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '8px 12px', borderRadius: 8, background: 'var(--panel-2, #17171d)', border: '1px solid var(--border, #2b2b33)' }}>
                  <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 20, background: '#2a2a33', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                    {s.scope === 'player' ? s.player : 'Team'}
                  </span>
                  <span style={{ fontSize: 13 }}>{s.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
