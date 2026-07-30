// DM Performance Visualization Graph — prognostic edition.
// y-axis = prognostic %, where 100% is our historical PAR vs the selected team.
// Over 100 (green zone) is improvement by definition; under 100 (red) is below
// our own history. C = best-fit trend of our % over time (solid to today,
// dashed projection to game day). D = each individual game's %.
import { daysBetween, rangeDates, wdOf, lsqFit, quantile, clampN } from '../lib/prognostic.js'

const C_PAR = '#c9a227'    // the 100% par line — the bar to beat
const C_TREND = '#4c8bf5'  // C — trend (best-fit direction)
const C_GAME = '#2dd4bf'   // D — each individual game
const C_TODAY = '#e5534b'
const C_UP = '#3fb950'
const C_DOWN = '#e5534b'

export default function DmGraph({ start, end, today, dayData, gameData, showProjection = false, parLabel, compact = false }) {
  if (!start || !end) return <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>No date window.</span>
  const dd = (dayData || []).filter((d) => d.pct != null)
  const gd = (gameData || []).filter((g) => g.pct != null)
  if (dd.length < 1 && gd.length < 1) {
    return <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>No scrims in this window yet — the graph fills in as you sync.</span>
  }

  // Start the axis at the first day that actually has data, not the window
  // start — no dead space on the left. It compresses naturally as days fill in.
  const dataDates = [...dd.map((d) => d.date), ...gd.map((g) => g.date)]
  const effStart = dataDates.length ? dataDates.reduce((a, b) => (a < b ? a : b)) : start
  const totalDays = Math.max(1, daysBetween(effStart, end))
  const todayNum = Math.max(0, Math.min(totalDays, daysBetween(effStart, today)))
  const W = 1000, H = compact ? 96 : 150

  // Scale the axis to the DAY averages, not to single games — one blowout scrim
  // (gold@15 swings by thousands) shouldn't stretch the whole scale. Individual
  // games beyond the band pin to the edge and get ringed as off-scale.
  const basis = dd.length ? dd.map((d) => d.pct) : gd.map((g) => g.pct)
  let lo = quantile(basis, 0.05) ?? 0
  let hi = quantile(basis, 0.95) ?? 200
  lo = Math.min(lo, 100); hi = Math.max(hi, 100)
  if (hi - lo < 40) { lo -= 20; hi += 20 }
  const bpad = (hi - lo) * 0.15
  lo -= bpad; hi += bpad
  const isOff = (v) => v < lo || v > hi
  const y = (v) => H - ((clampN(v, lo, hi) - lo) / (hi - lo)) * H
  const pctTop = (v) => (1 - (clampN(v, lo, hi) - lo) / (hi - lo)) * 100

  // Reserve up to 0.6 of a day-width on the right so the last day's games (which
  // sit at the far edge) spread inward instead of spilling off the chart.
  const dayWidth = W / (totalDays + 0.6)
  const px = (dn) => dn * dayWidth
  const pxDate = (d) => px(daysBetween(effStart, d))
  const pctLeft = (dn) => (px(dn) / W) * 100

  // C — best-fit trend through the day %s
  const fit = lsqFit(dd.map((d) => ({ x: daysBetween(effStart, d.date), y: d.pct })))
  const x0 = dd.length ? Math.min(...dd.map((d) => daysBetween(effStart, d.date))) : 0
  const trendY = (dn) => fit ? fit.intercept + fit.slope * dn : null
  const solidPath = fit ? `M${px(x0).toFixed(1)},${y(trendY(x0)).toFixed(1)} L${px(todayNum).toFixed(1)},${y(trendY(todayNum)).toFixed(1)}` : null
  const projPath = fit && showProjection && todayNum < totalDays ? `M${px(todayNum).toFixed(1)},${y(trendY(todayNum)).toFixed(1)} L${px(totalDays).toFixed(1)},${y(trendY(totalDays)).toFixed(1)}` : null

  // D — each game, nudged within its day so a day reads left→right
  const gPts = gd.map((g) => {
    const base = pxDate(g.date)
    const frac = g.dayCount > 1 ? g.idxInDay / (g.dayCount - 1) : 0.5
    return { x: base + frac * dayWidth * 0.6, pct: g.pct }
  })
  const gamePath = gPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${y(p.pct).toFixed(1)}`).join(' ')

  const yTop = y(hi), y100 = y(100), yBot = y(lo)
  const yticks = [lo, (lo + 100) / 2, 100, (100 + hi) / 2, hi]
  const dateList = rangeDates(effStart, end)
  const showEvery = dateList.length > 12 ? Math.ceil(dateList.length / 12) : 1

  const leg = { display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-faint)' }
  const bar = (style) => <span style={{ display: 'inline-block', width: 16, verticalAlign: 'middle', ...style }} />

  return (
    <div>
      {!compact && (
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11, marginBottom: 8, alignItems: 'center' }}>
          <span style={leg}>{bar({ borderTop: `2px solid ${C_PAR}` })} 100% prognostic{parLabel ? ` (${parLabel})` : ''}</span>
          <span style={leg}>{bar({ borderTop: `3px solid ${C_TREND}` })} Trend</span>
          {showProjection && <span style={leg}>{bar({ borderTop: `2px dashed ${C_TREND}`, opacity: 0.8 })} projection</span>}
          <span style={leg}>{bar({ borderTop: `2px solid ${C_GAME}` })} Each game</span>
          <span style={{ color: C_UP }}>▲ over 100 = improving</span>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {/* y-axis — fixed to the chart height H so the ticks line up with the lines */}
        <div style={{ position: 'relative', width: 42, height: H, flex: '0 0 auto' }}>
          {yticks.map((v, i) => (
            <span key={i} style={{ position: 'absolute', right: 5, top: `${pctTop(v)}%`, transform: 'translateY(-50%)', fontSize: 10, color: Math.round(v) === 100 ? C_PAR : 'var(--text-faint)', fontWeight: Math.round(v) === 100 ? 700 : 400 }}>{Math.round(v)}%</span>
          ))}
        </div>
        <div style={{ position: 'relative', flex: 1 }}>
          <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', overflow: 'visible' }}>
            {/* improvement / below-par zones */}
            <rect x="0" y={yTop} width={W} height={Math.max(0, y100 - yTop)} fill={C_UP} opacity="0.06" />
            <rect x="0" y={y100} width={W} height={Math.max(0, yBot - y100)} fill={C_DOWN} opacity="0.06" />
            {/* today marker */}
            <line x1={px(todayNum)} y1="0" x2={px(todayNum)} y2={H} stroke={C_TODAY} strokeWidth="1" strokeDasharray="3 4" opacity="0.55" vectorEffect="non-scaling-stroke" />
            {/* 100% par line */}
            <line x1="0" y1={y100} x2={W} y2={y100} stroke={C_PAR} strokeWidth="2" vectorEffect="non-scaling-stroke" />
            {/* D — each game */}
            <path d={gamePath} fill="none" stroke={C_GAME} strokeWidth="1.5" opacity="0.55" vectorEffect="non-scaling-stroke" />
            {gPts.map((p, i) => <circle key={`g${i}`} cx={p.x} cy={y(p.pct)} r={2} fill={C_GAME} opacity="0.8" stroke={isOff(p.pct) ? '#e5e7eb' : 'none'} strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
            {/* day markers */}
            {dd.map((d, i) => <circle key={`d${i}`} cx={pxDate(d.date) + dayWidth * 0.3} cy={y(d.pct)} r={2.5} fill={C_TREND} opacity="0.5" stroke={isOff(d.pct) ? '#e5e7eb' : 'none'} strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
            {/* C — trend + projection */}
            {solidPath && <path d={solidPath} fill="none" stroke={C_TREND} strokeWidth="2.5" vectorEffect="non-scaling-stroke" />}
            {projPath && <path d={projPath} fill="none" stroke={C_TREND} strokeWidth="2.5" strokeDasharray="7 5" opacity="0.85" vectorEffect="non-scaling-stroke" />}
          </svg>
          <span style={{ position: 'absolute', top: -2, left: `calc(${pctLeft(todayNum)}% - 2px)`, transform: 'translateX(-50%)', fontSize: 9, color: C_TODAY, whiteSpace: 'nowrap' }}>today</span>
          <div style={{ position: 'relative', height: 24, marginTop: 2 }}>
            {dateList.map((d, i) => {
              if (i % showEvery !== 0 && d !== end) return null
              const isEnd = d === end && showProjection
              return (
                <span key={d} style={{ position: 'absolute', left: `${pctLeft(daysBetween(effStart, d))}%`, transform: 'translateX(-50%)', fontSize: 9, textAlign: 'center', color: isEnd ? C_PAR : 'var(--text-faint)', whiteSpace: 'nowrap', lineHeight: 1.1 }}>
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
