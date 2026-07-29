import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'

// A League game can't legitimately end before 15:00 — only real completed games.
const MIN_REAL_S = 900

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0)
const pctOf = (n, d) => (d ? (n / d) * 100 : null)

function fmt(v, kind) {
  if (v == null) return '—'
  if (kind === 'pct') return `${Math.round(v)}%`
  if (kind === 'sg0') return (v > 0 ? '+' : '') + Math.round(v)
  if (kind === 'sg1') return (v > 0 ? '+' : '') + v.toFixed(1)
  if (kind === '1') return Number(v).toFixed(1)
  if (kind === '0') return Math.round(v)
  return v
}

const CARD_ORDER = [
  ['General', 'general'],
  ['Early Game', 'early'],
  ['Economy', 'economy'],
  ['Objectives', 'objectives'],
  ['Aggression', 'aggression'],
]

function Card({ title, rows, oppName }) {
  return (
    <div style={{ border: '1px solid #223', borderRadius: 8, overflow: 'hidden', background: '#10131a', flex: '1 1 320px', minWidth: 300 }}>
      <div style={{ background: '#2aa9c9', color: '#06222b', fontWeight: 800, fontSize: 13, padding: '6px 12px', letterSpacing: '.03em' }}>{title.toUpperCase()}</div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 0, padding: '4px 12px', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.03em' }}>
        <span style={{ width: 70, textAlign: 'right', color: '#3fb950' }}>Sentinels</span>
        <span style={{ width: 90, textAlign: 'right' }}>{oppName}</span>
      </div>
      <div style={{ padding: '2px 0 6px' }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', padding: '5px 12px', fontSize: 13 }}>
            <span style={{ flex: 1, color: 'var(--text-faint)' }}>{r.label}</span>
            <span style={{ width: 70, textAlign: 'right', fontWeight: 700 }}>{r.us}</span>
            <span style={{ width: 90, textAlign: 'right', fontWeight: 700, color: 'var(--text-faint)' }}>{r.them}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function OpponentStats() {
  const { data: series } = useSupabaseQuery(() => supabase.from('grid_series').select('grid_series_id, opponent_name, series_type'), [])
  const { data: games, loading: gLoading } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, sentinels_won, riot_enriched, game_duration_s, gold_diff_15, cs_diff_15, ' +
      'first_blood_sentinels, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_heralds, opponent_heralds, ' +
      'sentinels_grubs, opponent_grubs, sentinels_barons, opponent_barons, sentinels_towers, opponent_towers, sentinels_kills, opponent_kills'
    )), []
  )
  const { data: prows } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games').select('game_id, is_sentinels, champ_damage, cs, gold_earned, assists, xp_at_15')), []
  )

  const seriesById = useMemo(() => Object.fromEntries((series || []).map((s) => [s.grid_series_id, s])), [series])
  const playersByGame = useMemo(() => {
    const m = {}
    for (const p of prows || []) (m[p.game_id] ??= []).push(p)
    return m
  }, [prows])

  const opps = useMemo(() => {
    const c = new Map()
    for (const g of games || []) {
      const s = seriesById[g.grid_series_id]
      if (!s || !g.riot_enriched || g.game_duration_s < MIN_REAL_S) continue
      const name = canonicalOpponentName(s.opponent_name || '')
      if (!name) continue
      c.set(name, (c.get(name) || 0) + 1)
    }
    return [...c.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
  }, [games, seriesById])

  const [oppSel, setOppSel] = useState('')
  const selected = oppSel || (opps[0]?.name ?? null)

  const agg = useMemo(() => {
    if (!selected) return null
    const gs = (games || []).filter((g) => {
      const s = seriesById[g.grid_series_id]
      return s && g.riot_enriched && g.game_duration_s >= MIN_REAL_S && canonicalOpponentName(s.opponent_name || '') === selected
    })
    if (!gs.length) return null

    const usGpm = [], usCpm = [], usDpm = [], thGpm = [], thCpm = [], thDpm = []
    const usK = [], usD = [], usA = [], thK = [], thD = [], thA = [], xpDiff = []
    let usW = 0, usL = 0
    for (const g of gs) {
      const pl = playersByGame[g.id] || []
      const sp = pl.filter((p) => p.is_sentinels), op = pl.filter((p) => !p.is_sentinels)
      const min = g.game_duration_s / 60
      if (min > 0) {
        usGpm.push(sum(sp, (p) => p.gold_earned) / min); usCpm.push(sum(sp, (p) => p.cs) / min); usDpm.push(sum(sp, (p) => p.champ_damage) / min)
        if (op.length) { thGpm.push(sum(op, (p) => p.gold_earned) / min); thCpm.push(sum(op, (p) => p.cs) / min); thDpm.push(sum(op, (p) => p.champ_damage) / min) }
      }
      if (g.sentinels_won === true) usW++; else if (g.sentinels_won === false) usL++
      if (g.sentinels_kills != null) { usK.push(g.sentinels_kills); thD.push(g.sentinels_kills) }
      if (g.opponent_kills != null) { usD.push(g.opponent_kills); thK.push(g.opponent_kills) }
      usA.push(sum(sp, (p) => p.assists)); thA.push(sum(op, (p) => p.assists))
      const sx = sum(sp, (p) => p.xp_at_15), ox = sum(op, (p) => p.xp_at_15)
      if (sx && ox) xpDiff.push(sx - ox)
    }
    const rate = (f) => { const v = gs.map(f).filter((x) => x != null); return v.length ? (v.filter(Boolean).length / v.length) * 100 : null }
    const avgG = (f) => mean(gs.map(f).filter((x) => x != null))
    const usKDA = mean(usD) ? (mean(usK) + mean(usA)) / mean(usD) : null
    const thKDA = mean(thD) ? (mean(thK) + mean(thA)) / mean(thD) : null
    const csD = avgG((g) => g.cs_diff_15), goldD = avgG((g) => g.gold_diff_15), xpD = mean(xpDiff)

    return {
      n: gs.length,
      general: [
        { label: 'Record', us: `${usW}-${usL}`, them: `${usL}-${usW}` },
        { label: 'Win rate', us: fmt(pctOf(usW, usW + usL), 'pct'), them: fmt(pctOf(usL, usW + usL), 'pct') },
        { label: 'KDA', us: fmt(usKDA, '1'), them: fmt(thKDA, '1') },
        { label: 'CS / min', us: fmt(mean(usCpm), '1'), them: fmt(mean(thCpm), '1') },
        { label: 'Gold / min', us: fmt(mean(usGpm), '0'), them: fmt(mean(thGpm), '0') },
      ],
      early: [
        { label: 'CS diff @15', us: fmt(csD, 'sg1'), them: fmt(csD != null ? -csD : null, 'sg1') },
        { label: 'Gold diff @15', us: fmt(goldD, 'sg0'), them: fmt(goldD != null ? -goldD : null, 'sg0') },
        { label: 'XP diff @15', us: fmt(xpD, 'sg0'), them: fmt(xpD != null ? -xpD : null, 'sg0') },
        { label: 'Ahead in CS @15', us: fmt(rate((g) => (g.cs_diff_15 == null ? null : g.cs_diff_15 > 0)), 'pct'), them: fmt(rate((g) => (g.cs_diff_15 == null ? null : g.cs_diff_15 < 0)), 'pct') },
        { label: 'First Blood', us: fmt(rate((g) => g.first_blood_sentinels), 'pct'), them: fmt(rate((g) => (g.first_blood_sentinels == null ? null : !g.first_blood_sentinels)), 'pct') },
      ],
      economy: [
        { label: 'Gold / min', us: fmt(mean(usGpm), '0'), them: fmt(mean(thGpm), '0') },
        { label: 'CS / min', us: fmt(mean(usCpm), '1'), them: fmt(mean(thCpm), '1') },
        { label: 'First Tower', us: fmt(rate((g) => g.first_tower_sentinels), 'pct'), them: fmt(rate((g) => (g.first_tower_sentinels == null ? null : !g.first_tower_sentinels)), 'pct') },
        { label: 'Towers / game', us: fmt(avgG((g) => g.sentinels_towers), '1'), them: fmt(avgG((g) => g.opponent_towers), '1') },
      ],
      objectives: [
        { label: 'Dragons / game', us: fmt(avgG((g) => g.sentinels_dragons), '1'), them: fmt(avgG((g) => g.opponent_dragons), '1') },
        { label: 'Voidgrubs / game', us: fmt(avgG((g) => g.sentinels_grubs), '1'), them: fmt(avgG((g) => g.opponent_grubs), '1') },
        { label: 'Herald / game', us: fmt(avgG((g) => g.sentinels_heralds), '1'), them: fmt(avgG((g) => g.opponent_heralds), '1') },
        { label: 'Baron / game', us: fmt(avgG((g) => g.sentinels_barons), '1'), them: fmt(avgG((g) => g.opponent_barons), '1') },
      ],
      aggression: [
        { label: 'Damage / min', us: fmt(mean(usDpm), '0'), them: fmt(mean(thDpm), '0') },
        { label: 'Kills / game', us: fmt(mean(usK), '1'), them: fmt(mean(thK), '1') },
        { label: 'Deaths / game', us: fmt(mean(usD), '1'), them: fmt(mean(thD), '1') },
        { label: 'KDA', us: fmt(usKDA, '1'), them: fmt(thKDA, '1') },
      ],
    }
  }, [selected, games, seriesById, playersByGame])

  return (
    <div className="panel">
      <h2>Opponent Stats</h2>
      <p className="panel-caption" style={{ marginTop: 0 }}>
        Pick a team — every card shows Sentinels vs that opponent, side by side, averaged over the completed games we have on record against them.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--text-faint)' }}>Opponent</label>
        <select
          value={selected || ''}
          onChange={(e) => setOppSel(e.target.value)}
          className="search-input"
          style={{ minWidth: 240, fontSize: 14, padding: '8px 10px' }}
        >
          {opps.map((o) => <option key={o.name} value={o.name}>{o.name} ({o.n} games)</option>)}
        </select>
        {agg && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>{agg.n} completed games vs {selected}</span>}
      </div>

      {gLoading && <div className="loading-state">Loading…</div>}
      {!gLoading && !agg && <div className="empty-state">No completed games on record against this opponent yet.</div>}

      {agg && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 6 }}>
          {CARD_ORDER.map(([title, key]) => <Card key={key} title={title} rows={agg[key]} oppName={selected} />)}
        </div>
      )}
    </div>
  )
}
