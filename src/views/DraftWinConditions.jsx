import { useMemo, useState } from 'react'
import draftGames from '../data/draftData.json'
import { canonicalOpponentName } from '../lib/constants.js'

// Draft-level win conditions, built from the coaches' hand-kept draft record
// (a separate Google Sheet, re-imported to draftData.json when it changes).
// Unlike the GRID stats this is the DRAFT layer: side, first picks, champion
// pools, enemy tendencies, bans — the decisions made before the game.

const ROLE_ORDER = ['Top', 'Jungle', 'Mid', 'Bottom', 'Support']
const ROLE_PLAYER = { Top: 'Impact', Jungle: 'HamBak', Mid: 'DARKWINGS', Bottom: 'Rahel', Support: 'Huhi' }

const pct = (w, n) => (n ? Math.round((100 * w) / n) : null)
const wrColor = (wr) => (wr == null ? 'var(--text-faint)' : wr >= 55 ? '#3fb950' : wr <= 45 ? '#e5534b' : '#e0a940')

// annotate canonical opponent name once
const GAMES = draftGames.map((g) => ({ ...g, team: canonicalOpponentName(g.opp) || g.opp }))

const card = { border: '1px solid var(--border, #2b2b33)', borderRadius: 10, background: 'var(--panel-2, #17171d)', padding: 14 }
const LBL = { fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.04em' }
const th = { textAlign: 'left', padding: '5px 8px', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '.03em' }
const td = { padding: '5px 8px', fontSize: 13, borderTop: '1px solid var(--border, #23232b)' }

function WrRow({ label, w, n, minN = 1 }) {
  const wr = pct(w, n)
  const thin = n < minN + 2
  return (
    <tr>
      <td style={{ ...td }}>{label}</td>
      <td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>{n}</td>
      <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: wrColor(wr), opacity: thin ? 0.6 : 1 }}>{wr == null ? '—' : `${wr}%`}</td>
    </tr>
  )
}

function MiniTable({ head, rows }) {
  if (!rows.length) return <div style={{ fontSize: 12, color: 'var(--text-faint)', padding: '6px 8px' }}>No data.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead><tr><th style={th}>{head}</th><th style={{ ...th, textAlign: 'right' }}>Gms</th><th style={{ ...th, textAlign: 'right' }}>Win%</th></tr></thead>
      <tbody>{rows}</tbody>
    </table>
  )
}

export default function DraftWinConditions() {
  const teamOptions = useMemo(() => {
    const c = new Map()
    for (const g of GAMES) c.set(g.team, (c.get(g.team) || 0) + 1)
    return [...c.entries()].map(([name, n]) => ({ name, n })).filter((o) => o.n >= 5).sort((a, b) => b.n - a.n)
  }, [])
  const [team, setTeam] = useState('ALL')
  const [minN, setMinN] = useState(2)

  const agg = useMemo(() => {
    const gs = team === 'ALL' ? GAMES : GAMES.filter((g) => g.team === team)
    const n = gs.length
    const wins = gs.filter((g) => g.result === 1).length
    const split = (key, vals) => vals.map((v) => { const s = gs.filter((g) => g[key] === v); return { v, n: s.length, w: s.filter((g) => g.result === 1).length } })
    const side = split('side', ['Blue', 'Red'])
    const typ = split('type', ['Scrim', 'Match'])
    const fpm = {}
    for (const g of gs) { (fpm[g.fpChamp] ??= { n: 0, w: 0 }); fpm[g.fpChamp].n++; if (g.result === 1) fpm[g.fpChamp].w++ }
    const firstPicks = Object.entries(fpm).map(([c, v]) => ({ c, ...v })).sort((a, b) => b.n - a.n)
    const ours = {}, theirs = {}
    for (const g of gs) for (const p of g.picks) {
      if (p.c) { (ours[p.r] ??= {}); (ours[p.r][p.c] ??= { n: 0, w: 0 }); ours[p.r][p.c].n++; if (g.result === 1) ours[p.r][p.c].w++ }
      if (p.e) { (theirs[p.r] ??= {}); (theirs[p.r][p.e] ??= { n: 0, w: 0 }); theirs[p.r][p.e].n++; if (g.result === 1) theirs[p.r][p.e].w++ }
    }
    const pool = (m) => ROLE_ORDER.map((role) => ({ role, champs: Object.entries(m[role] || {}).map(([c, v]) => ({ c, ...v })).sort((a, b) => b.n - a.n) }))
    const banCount = (arrKey) => { const m = {}; for (const g of gs) for (const b of g[arrKey]) m[b] = (m[b] || 0) + 1; return Object.entries(m).map(([c, ct]) => ({ c, ct })).sort((a, b) => b.ct - a.ct).slice(0, 12) }
    return { n, wins, side, typ, firstPicks, ours: pool(ours), theirs: pool(theirs), bans: banCount('bans'), ebans: banCount('ebans') }
  }, [team])

  const teamLabel = team === 'ALL' ? 'all teams' : team
  const overallWr = pct(agg.wins, agg.n)

  return (
    <div className="panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ marginBottom: 0 }}>Draft — Win Conditions</h2>
        <div>
          <div style={{ ...LBL, marginBottom: 4 }}>Opponent</div>
          <select value={team} onChange={(e) => setTeam(e.target.value)} className="search-input" style={{ minWidth: 220, fontSize: 14, padding: '8px 10px' }}>
            <option value="ALL">All teams</option>
            {teamOptions.map((o) => <option key={o.name} value={o.name}>{o.name} ({o.n})</option>)}
          </select>
        </div>
      </div>
      <p className="panel-caption">
        The <b style={{ color: 'var(--text)' }}>draft layer</b> from the coaches&apos; record — the decisions made before the game (side, first picks, champions, bans), against {teamLabel}.
        Green ≥ 55% win, red ≤ 45%. Small samples are dimmed — treat those as directional, not gospel. Manually kept, so it refreshes when the sheet is re-imported.
      </p>

      {/* headline */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 14 }}>
        <div style={{ ...card, minWidth: 150 }}>
          <div style={LBL}>Record vs {teamLabel}</div>
          <div style={{ fontSize: 26, fontWeight: 800 }}>{agg.wins}–{agg.n - agg.wins}</div>
          <div style={{ fontSize: 12, color: wrColor(overallWr), fontWeight: 700 }}>{overallWr}% over {agg.n} games</div>
        </div>
        {agg.side.map((s) => (
          <div key={s.v} style={{ ...card, minWidth: 120 }}>
            <div style={LBL}>{s.v} side</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: wrColor(pct(s.w, s.n)) }}>{pct(s.w, s.n) ?? '—'}%</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.w}–{s.n - s.w}</div>
          </div>
        ))}
        {agg.typ.map((t) => (
          <div key={t.v} style={{ ...card, minWidth: 120 }}>
            <div style={LBL}>{t.v === 'Match' ? 'Officials' : 'Scrims'}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: wrColor(pct(t.w, t.n)) }}>{pct(t.w, t.n) ?? '—'}%</div>
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t.w}–{t.n - t.w}</div>
          </div>
        ))}
      </div>

      {/* first picks + bans */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12, marginBottom: 14 }}>
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>Our first picks</div>
          <MiniTable head="Champion" rows={agg.firstPicks.slice(0, 10).map((f) => <WrRow key={f.c} label={f.c} w={f.w} n={f.n} minN={minN} />)} />
        </div>
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>We ban most</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>{agg.bans.map((b) => <tr key={b.c}><td style={td}>{b.c}</td><td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>{b.ct}×</td></tr>)}</tbody>
          </table>
        </div>
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>They ban most</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>{agg.ebans.map((b) => <tr key={b.c}><td style={td}>{b.c}</td><td style={{ ...td, textAlign: 'right', color: 'var(--text-faint)' }}>{b.ct}×</td></tr>)}</tbody>
          </table>
        </div>
      </div>

      {/* our champion pools by role */}
      <div style={{ fontWeight: 700, fontSize: 14, margin: '4px 0 8px' }}>Our champion pools — win rate by role</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
        {agg.ours.map(({ role, champs }) => (
          <div key={role} style={card}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{role} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {ROLE_PLAYER[role]}</span></div>
            <MiniTable head="Champion" rows={champs.slice(0, 6).map((c) => <WrRow key={c.c} label={c.c} w={c.w} n={c.n} minN={minN} />)} />
          </div>
        ))}
      </div>

      {/* enemy tendencies by role */}
      <div style={{ fontWeight: 700, fontSize: 14, margin: '4px 0 8px' }}>What {teamLabel} play — and how we do into it</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {agg.theirs.map(({ role, champs }) => (
          <div key={role} style={card}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{role}</div>
            <MiniTable head="Enemy champ" rows={champs.slice(0, 6).map((c) => <WrRow key={c.c} label={c.c} w={c.w} n={c.n} minN={minN} />)} />
          </div>
        ))}
      </div>
    </div>
  )
}
