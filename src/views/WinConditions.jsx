import { useMemo, useState } from 'react'
import {
  BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'

const SESSION_FILTERS = [
  { key: 'all', label: 'All games' },
  { key: 'ESPORTS', label: 'Official' },
  { key: 'SCRIM', label: 'Scrim' },
]

const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Huhi', 'Rahel']

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : null }
function avg(nums) {
  const v = nums.filter((x) => typeof x === 'number' && !Number.isNaN(x))
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
function round(x, d = 1) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d }

// One row of the "win conditions" table: win rate when a condition holds vs not.
function condition(games, label, testFn, note) {
  const withCond = games.filter((g) => testFn(g) === true)
  const without = games.filter((g) => testFn(g) === false)
  const winYes = pct(withCond.filter((g) => g.sentinels_won).length, withCond.length)
  const winNo = pct(without.filter((g) => g.sentinels_won).length, without.length)
  const lift = winYes != null && winNo != null ? winYes - winNo : null
  return { label, note, nYes: withCond.length, nNo: without.length, winYes, winNo, lift }
}

export default function WinConditions() {
  const [sessionFilter, setSessionFilter] = useState('all')
  const [opponent, setOpponent] = useState('all')
  const [indivPlayer, setIndivPlayer] = useState('Impact')

  const { data: rawGames, loading, error } = useSupabaseQuery(
    () => fetchAllRows(() =>
      supabase.from('grid_games')
        .select('id, sentinels_won, gold_diff_15, cs_diff_15, first_blood_sentinels, first_tower_sentinels, sentinels_dragons, opponent_dragons, sentinels_heralds, opponent_heralds, sentinels_grubs, opponent_grubs, sentinels_barons, opponent_barons, sentinels_towers, opponent_towers, grid_series!inner(opponent_name, series_type)')
        .eq('riot_enriched', true)),
    []
  )

  const { data: rawPlayers } = useSupabaseQuery(
    () => fetchAllRows(() =>
      supabase.from('grid_player_games')
        .select('player, gold_diff_15, cs_diff_15, cs_per_min, champ_damage_share, kill_participation, vision_per_min, kills, deaths, assists, is_sentinels, grid_games!inner(sentinels_won, riot_enriched, grid_series!inner(opponent_name, series_type))')
        .eq('is_sentinels', true)),
    []
  )

  // Flatten + attach canonical opponent
  const games = useMemo(() => (rawGames || [])
    .filter((g) => g.grid_series && g.sentinels_won != null)
    .map((g) => ({ ...g, opponent: canonicalOpponentName(g.grid_series.opponent_name), type: g.grid_series.series_type })), [rawGames])

  const players = useMemo(() => (rawPlayers || [])
    .filter((p) => p.grid_games && p.grid_games.riot_enriched && p.grid_games.grid_series && p.gold_diff_15 != null)
    .map((p) => ({
      player: p.player, gold_diff_15: p.gold_diff_15, cs_diff_15: p.cs_diff_15,
      cs_per_min: p.cs_per_min, damage_share: p.champ_damage_share, kp: p.kill_participation, vision_per_min: p.vision_per_min,
      kda: p.deaths ? ((p.kills ?? 0) + (p.assists ?? 0)) / p.deaths : ((p.kills ?? 0) + (p.assists ?? 0)),
      won: p.grid_games.sentinels_won, opponent: canonicalOpponentName(p.grid_games.grid_series.opponent_name), type: p.grid_games.grid_series.series_type,
    })), [rawPlayers])

  const opponentOptions = useMemo(() => {
    const counts = new Map()
    for (const g of games) counts.set(g.opponent, (counts.get(g.opponent) || 0) + 1)
    return [...counts.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n)
  }, [games])

  const filtered = useMemo(() => games.filter((g) =>
    (sessionFilter === 'all' || g.type === sessionFilter) &&
    (opponent === 'all' || g.opponent === opponent)), [games, sessionFilter, opponent])

  const filteredPlayers = useMemo(() => players.filter((p) =>
    (sessionFilter === 'all' || p.type === sessionFilter) &&
    (opponent === 'all' || p.opponent === opponent)), [players, sessionFilter, opponent])

  const wins = filtered.filter((g) => g.sentinels_won)
  const losses = filtered.filter((g) => !g.sentinels_won)
  const winrate = pct(wins.length, filtered.length)

  // "When we win vs when we lose" profile
  const profile = useMemo(() => {
    const rows = [
      { label: 'Gold diff @15', win: round(avg(wins.map((g) => g.gold_diff_15)), 0), loss: round(avg(losses.map((g) => g.gold_diff_15)), 0), higherBetter: true, unit: '' },
      { label: 'CS diff @15', win: round(avg(wins.map((g) => g.cs_diff_15))), loss: round(avg(losses.map((g) => g.cs_diff_15))), higherBetter: true, unit: '' },
      { label: 'First blood %', win: pct(wins.filter((g) => g.first_blood_sentinels).length, wins.length), loss: pct(losses.filter((g) => g.first_blood_sentinels).length, losses.length), higherBetter: true, unit: '%' },
      { label: 'First tower %', win: pct(wins.filter((g) => g.first_tower_sentinels).length, wins.length), loss: pct(losses.filter((g) => g.first_tower_sentinels).length, losses.length), higherBetter: true, unit: '%' },
      { label: 'Dragons taken', win: round(avg(wins.map((g) => g.sentinels_dragons))), loss: round(avg(losses.map((g) => g.sentinels_dragons))), higherBetter: true, unit: '' },
      { label: 'Void grubs taken', win: round(avg(wins.map((g) => g.sentinels_grubs))), loss: round(avg(losses.map((g) => g.sentinels_grubs))), higherBetter: true, unit: '' },
      { label: 'Heralds taken', win: round(avg(wins.map((g) => g.sentinels_heralds))), loss: round(avg(losses.map((g) => g.sentinels_heralds))), higherBetter: true, unit: '' },
    ]
    return rows
  }, [wins, losses])

  // Win-condition factors ranked by lift
  const conditions = useMemo(() => {
    if (filtered.length === 0) return []
    return [
      condition(filtered, 'Get First Blood', (g) => g.first_blood_sentinels === true ? true : g.first_blood_sentinels === false ? false : null),
      condition(filtered, 'Get First Tower', (g) => g.first_tower_sentinels === true ? true : g.first_tower_sentinels === false ? false : null),
      condition(filtered, 'Ahead in gold @15', (g) => g.gold_diff_15 == null ? null : g.gold_diff_15 > 0),
      condition(filtered, 'Ahead in CS @15', (g) => g.cs_diff_15 == null ? null : g.cs_diff_15 > 0),
      condition(filtered, 'Take first Herald', (g) => g.sentinels_heralds == null ? null : g.sentinels_heralds > 0),
    ].filter((c) => c.lift != null).sort((a, b) => b.lift - a.lift)
  }, [filtered])

  // Win rate by number of dragons / void grubs taken
  const ladders = useMemo(() => {
    const build = (field, buckets) => buckets.map((b) => {
      const gs = filtered.filter((g) => g[field] != null && b.test(g[field]))
      return { label: b.label, games: gs.length, win: pct(gs.filter((g) => g.sentinels_won).length, gs.length) }
    })
    return {
      dragons: build('sentinels_dragons', [
        { label: '0', test: (n) => n === 0 }, { label: '1', test: (n) => n === 1 }, { label: '2', test: (n) => n === 2 },
        { label: '3', test: (n) => n === 3 }, { label: '4+', test: (n) => n >= 4 },
      ]),
      grubs: build('sentinels_grubs', [
        { label: '0', test: (n) => n === 0 }, { label: '1', test: (n) => n === 1 },
        { label: '2', test: (n) => n === 2 }, { label: '3+', test: (n) => n >= 3 },
      ]),
    }
  }, [filtered])

  // Whose lane lead most predicts a win
  const laneImpact = useMemo(() => ROSTER.map((name) => {
    const rows = filteredPlayers.filter((p) => p.player === name)
    const ahead = rows.filter((p) => p.gold_diff_15 > 0)
    const behind = rows.filter((p) => p.gold_diff_15 <= 0)
    const wAhead = pct(ahead.filter((p) => p.won).length, ahead.length)
    const wBehind = pct(behind.filter((p) => p.won).length, behind.length)
    return { name, wAhead, wBehind, nAhead: ahead.length, nBehind: behind.length, lift: wAhead != null && wBehind != null ? wAhead - wBehind : null }
  }).filter((r) => r.lift != null).sort((a, b) => b.lift - a.lift), [filteredPlayers])

  // Selected player's stat profile in team wins vs team losses
  const indivProfile = useMemo(() => {
    const rows = filteredPlayers.filter((p) => p.player === indivPlayer)
    const w = rows.filter((p) => p.won), l = rows.filter((p) => !p.won)
    const metric = (label, key, dp = 1, unit = '') => ({
      label, unit,
      win: round(avg(w.map((p) => p[key])), dp),
      loss: round(avg(l.map((p) => p[key])), dp),
    })
    return {
      nWin: w.length, nLoss: l.length,
      rows: [
        metric('CS per min', 'cs_per_min', 1),
        metric('KDA', 'kda', 1),
        metric('Kill participation', 'kp', 0, '%'),
        metric('Damage share', 'damage_share', 0, '%'),
        metric('Gold diff @15', 'gold_diff_15', 0),
        metric('CS diff @15', 'cs_diff_15', 1),
        metric('Vision / min', 'vision_per_min', 2),
      ],
    }
  }, [filteredPlayers, indivPlayer])

  // Per-opponent record (respects session filter, ignores opponent filter)
  const byOpponent = useMemo(() => {
    const sessionGames = games.filter((g) => sessionFilter === 'all' || g.type === sessionFilter)
    const map = new Map()
    for (const g of sessionGames) {
      if (!map.has(g.opponent)) map.set(g.opponent, { name: g.opponent, w: 0, l: 0 })
      const e = map.get(g.opponent)
      if (g.sentinels_won) e.w++; else e.l++
    }
    return [...map.values()].map((e) => ({ ...e, n: e.w + e.l, wr: pct(e.w, e.w + e.l) })).sort((a, b) => b.n - a.n)
  }, [games, sessionFilter])

  const scopeLabel = `${opponent === 'all' ? 'all opponents' : `vs ${opponent}`} · ${SESSION_FILTERS.find((s) => s.key === sessionFilter)?.label.toLowerCase()}`

  return (
    <div>
      <div className="panel">
        <h2>Win Conditions</h2>
        <p className="panel-caption">
          What our wins actually look like — built on the enriched Riot data (CS/gold @15, first blood, first
          tower, objectives) for every game we have a Riot file for. Pick a scope, then read three things: how
          our average game differs in wins vs losses, which conditions swing the win rate most, and whose lane
          lead most predicts a win. A caution on reading these: some factors (dragons, towers) are partly a
          <em> consequence</em> of already winning — the early ones (first blood, gold @15, first tower) are
          closer to true <em>causes</em> you can coach toward.
        </p>
        {loading && <div className="loading-state">Loading enriched game data…</div>}
        {error && <div className="toast error">Error: {error.message}</div>}
      </div>

      {!loading && !error && (
        <>
          <div className="panel">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>Games</div>
                <div className="player-tabs" style={{ margin: 0 }}>
                  {SESSION_FILTERS.map((s) => (
                    <button key={s.key} type="button" className={`player-tab ${sessionFilter === s.key ? 'active' : ''}`} onClick={() => setSessionFilter(s.key)}>{s.label}</button>
                  ))}
                </div>
              </div>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', maxWidth: 360 }}>
                Opponent
                <select value={opponent} onChange={(e) => setOpponent(e.target.value)}>
                  <option value="all">All opponents</option>
                  {opponentOptions.map((o) => (<option key={o.name} value={o.name}>{o.name} ({o.n} games)</option>))}
                </select>
              </label>
            </div>
            <div className="stat-grid" style={{ marginTop: 16 }}>
              <div className="stat-card">
                <div className="stat-label">Record — {scopeLabel}</div>
                <div className="stat-value">{wins.length}W – {losses.length}L</div>
                <div className="stat-sub">{winrate != null ? `${winrate}% win rate` : '—'} · {filtered.length} games with Riot data</div>
              </div>
            </div>
          </div>

          {filtered.length < 4 ? (
            <div className="panel"><div className="empty-state">Only {filtered.length} enriched games in this scope — pick a broader filter to see patterns.</div></div>
          ) : (
            <>
              <div className="panel">
                <h2>When we win vs when we lose</h2>
                <p className="panel-caption">The average game profile in wins vs losses, {scopeLabel}. The bigger the gap, the more that factor separates a win from a loss.</p>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Metric</th><th style={{ textAlign: 'right' }}>In wins ({wins.length})</th><th style={{ textAlign: 'right' }}>In losses ({losses.length})</th><th style={{ textAlign: 'right' }}>Gap</th></tr></thead>
                    <tbody>
                      {profile.map((r) => {
                        const gap = r.win != null && r.loss != null ? round(r.win - r.loss, r.unit === '%' ? 0 : 1) : null
                        return (
                          <tr key={r.label}>
                            <td>{r.label}</td>
                            <td style={{ textAlign: 'right', color: '#3aa76d', fontWeight: 600 }}>{r.win ?? '—'}{r.unit}</td>
                            <td style={{ textAlign: 'right', color: '#e0a940', fontWeight: 600 }}>{r.loss ?? '—'}{r.unit}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{gap != null ? `${gap > 0 ? '+' : ''}${gap}${r.unit}` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <h2>Win conditions — ranked by swing</h2>
                <p className="panel-caption">Win rate when a condition is met vs not, {scopeLabel}. &ldquo;Swing&rdquo; is the difference — the bigger it is, the more that condition matters for this scope.</p>
                <div className="chart-wrap">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={conditions} layout="vertical" margin={{ top: 6, right: 40, left: 120, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                      <XAxis type="number" domain={[-40, 60]} stroke="#9aa1ae" fontSize={11} unit="%" />
                      <YAxis type="category" dataKey="label" stroke="#9aa1ae" fontSize={11} width={115} />
                      <ReferenceLine x={0} stroke="#676f7d" />
                      <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                        formatter={(v, n, p) => [`${p.payload.winYes}% win with (n=${p.payload.nYes}) vs ${p.payload.winNo}% without (n=${p.payload.nNo})`, 'Swing']} />
                      <Bar dataKey="lift" radius={[0, 4, 4, 0]}>
                        {conditions.map((c, i) => (<Cell key={i} fill={c.lift >= 0 ? '#3aa76d' : '#e0524a'} />))}
                        <LabelList dataKey="lift" position="right" formatter={(v) => `${v > 0 ? '+' : ''}${v}%`} fill="#e6e8ec" fontSize={11} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="table-scroll" style={{ marginTop: 12 }}>
                  <table>
                    <thead><tr><th>Condition</th><th style={{ textAlign: 'right' }}>Win % when yes</th><th style={{ textAlign: 'right' }}>Win % when no</th><th style={{ textAlign: 'right' }}>Swing</th></tr></thead>
                    <tbody>
                      {conditions.map((c) => (
                        <tr key={c.label}>
                          <td>{c.label}</td>
                          <td style={{ textAlign: 'right' }}>{c.winYes ?? '—'}% <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({c.nYes})</span></td>
                          <td style={{ textAlign: 'right' }}>{c.winNo ?? '—'}% <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({c.nNo})</span></td>
                          <td style={{ textAlign: 'right', color: c.lift >= 0 ? '#3aa76d' : '#e0524a', fontWeight: 600 }}>{c.lift > 0 ? '+' : ''}{c.lift}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <h2>Win rate by objectives secured</h2>
                <p className="panel-caption">
                  Win rate at each number of dragons and void grubs taken, {scopeLabel}. Dragons tend to be a
                  clean ladder — every one secured lifts the win rate. Each bar shows its game count in
                  brackets; a high rate on a tiny sample is directional.
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24 }}>
                  {[{ title: 'By dragons taken', data: ladders.dragons, color: '#e0524a' }, { title: 'By void grubs taken', data: ladders.grubs, color: '#8a6fd4' }].map((chart) => (
                    <div key={chart.title} style={{ flex: '1 1 320px', minWidth: 280 }}>
                      <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 6 }}>{chart.title}</div>
                      <div className="chart-wrap" style={{ height: 240 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={chart.data} margin={{ top: 18, right: 12, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#2a2f3a" />
                            <XAxis dataKey="label" stroke="#9aa1ae" fontSize={12} />
                            <YAxis domain={[0, 100]} stroke="#9aa1ae" fontSize={12} unit="%" />
                            <ReferenceLine y={50} stroke="#676f7d" strokeDasharray="4 4" />
                            <Tooltip contentStyle={{ background: '#171a21', border: '1px solid #2a2f3a', fontSize: 12 }}
                              formatter={(v, n, p) => [`${v ?? '—'}% win (n=${p.payload.games})`, 'Win rate']} />
                            <Bar dataKey="win" radius={[4, 4, 0, 0]} fill={chart.color}>
                              <LabelList position="top" content={(props) => {
                                const { x, y, width, index } = props
                                const d = chart.data[index]
                                if (!d || d.win == null || x == null) return null
                                return <text x={x + width / 2} y={y - 5} fill="#e6e8ec" fontSize={11} textAnchor="middle">{d.win}% ({d.games})</text>
                              }} />
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="panel">
                <h2>Individual — wins vs losses</h2>
                <p className="panel-caption">
                  How each player&rsquo;s own game looks in team wins vs team losses, {scopeLabel}. A metric that
                  is much higher in wins than losses is one this player tends to drive the result with; one
                  that&rsquo;s similar in both means their level doesn&rsquo;t change much between wins and losses
                  (they&rsquo;re carried or held back by the rest). All from the enriched Riot data.
                </p>
                <div className="player-tabs" style={{ marginBottom: 14 }}>
                  {ROSTER.map((p) => (
                    <button key={p} type="button" className={`player-tab ${indivPlayer === p ? 'active' : ''}`} onClick={() => setIndivPlayer(p)}>{p}</button>
                  ))}
                </div>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Metric</th><th style={{ textAlign: 'right' }}>In wins ({indivProfile.nWin})</th><th style={{ textAlign: 'right' }}>In losses ({indivProfile.nLoss})</th><th style={{ textAlign: 'right' }}>Gap</th></tr></thead>
                    <tbody>
                      {indivProfile.rows.map((r) => {
                        const gap = r.win != null && r.loss != null ? round(r.win - r.loss, r.unit === '%' ? 0 : 1) : null
                        return (
                          <tr key={r.label}>
                            <td>{r.label}</td>
                            <td style={{ textAlign: 'right', color: '#3aa76d', fontWeight: 600 }}>{r.win ?? '—'}{r.unit}</td>
                            <td style={{ textAlign: 'right', color: '#e0a940', fontWeight: 600 }}>{r.loss ?? '—'}{r.unit}</td>
                            <td style={{ textAlign: 'right', color: 'var(--text-dim)' }}>{gap != null ? `${gap > 0 ? '+' : ''}${gap}${r.unit}` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <h2>Whose early lead predicts the win</h2>
                <p className="panel-caption">
                  These are <strong>two separate groups of games</strong>, not two halves of one — so the two
                  percentages are not meant to add to 100%. Left column: of the games where this player was
                  <em> ahead</em> in gold at 15 (game count in brackets), the share the team won. Right column:
                  the same for games where they were <em>behind</em>. The <strong>swing</strong> is the
                  difference — a big positive swing means when this player wins their lane early, the team tends
                  to win, so their early game is a real lever. Scope: {scopeLabel}.
                </p>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Player</th><th style={{ textAlign: 'right' }}>Win % when ahead @15</th><th style={{ textAlign: 'right' }}>Win % when behind @15</th><th style={{ textAlign: 'right' }}>Swing</th></tr></thead>
                    <tbody>
                      {laneImpact.map((r) => (
                        <tr key={r.name}>
                          <td>{r.name}</td>
                          <td style={{ textAlign: 'right' }}>{r.wAhead ?? '—'}% <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({r.nAhead} game{r.nAhead === 1 ? '' : 's'})</span></td>
                          <td style={{ textAlign: 'right' }}>{r.wBehind ?? '—'}% <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({r.nBehind} game{r.nBehind === 1 ? '' : 's'})</span></td>
                          <td style={{ textAlign: 'right', color: (r.lift ?? 0) >= 0 ? '#3aa76d' : '#e0524a', fontWeight: 600 }}>{r.lift > 0 ? '+' : ''}{r.lift}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="panel">
                <h2>By opponent</h2>
                <p className="panel-caption">Record vs each opponent ({SESSION_FILTERS.find((s) => s.key === sessionFilter)?.label.toLowerCase()}). Click a row to filter the whole page to that opponent.</p>
                <div className="table-scroll">
                  <table>
                    <thead><tr><th>Opponent</th><th style={{ textAlign: 'right' }}>Record</th><th style={{ textAlign: 'right' }}>Win %</th></tr></thead>
                    <tbody>
                      {byOpponent.map((o) => (
                        <tr key={o.name} onClick={() => setOpponent(o.name)} style={{ cursor: 'pointer' }} title={`Filter to ${o.name}`}>
                          <td>{o.name}</td>
                          <td style={{ textAlign: 'right' }}>{o.w}W – {o.l}L</td>
                          <td style={{ textAlign: 'right', color: (o.wr ?? 0) >= 50 ? '#3aa76d' : '#e0a940', fontWeight: 600 }}>{o.wr}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
