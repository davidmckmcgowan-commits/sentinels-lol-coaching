import { Fragment, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'
import DailySync from './DailySync.jsx'

// Champion icons come from Riot's Data Dragon CDN. We fetch the champion list
// once and build two lookups: championId -> image key (for bans) and
// display-name -> image key (for picks).
const DDRAGON = 'https://ddragon.leagueoflegends.com'
const ROLE_ORDER = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']
const SESSION_COLORS = { Green: '#3fb950', Orange: '#d29922', Red: '#e5534b', Official: '#c9a227' }
const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')

function useChampions() {
  const [maps, setMaps] = useState({ ver: null, idToKey: {}, nameToKey: {} })
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const vers = await fetch(`${DDRAGON}/api/versions.json`).then((r) => r.json())
        const ver = vers[0]
        const champ = await fetch(`${DDRAGON}/cdn/${ver}/data/en_US/champion.json`).then((r) => r.json())
        const idToKey = {}
        const nameToKey = {}
        for (const c of Object.values(champ.data)) {
          idToKey[parseInt(c.key, 10)] = c.id
          nameToKey[norm(c.name)] = c.id
          nameToKey[norm(c.id)] = c.id
        }
        if (alive) setMaps({ ver, idToKey, nameToKey })
      } catch {
        /* icons just won't render; not fatal */
      }
    })()
    return () => { alive = false }
  }, [])
  return maps
}

function ChampIcon({ champKey, ver, title, size = 26 }) {
  if (!champKey || !ver) {
    return <span title={title} style={{ display: 'inline-block', width: size, height: size, borderRadius: 4, background: '#2a2a33', marginRight: 2 }} />
  }
  return (
    <img
      src={`${DDRAGON}/cdn/${ver}/img/champion/${champKey}.png`}
      alt={title || champKey}
      title={title || champKey}
      width={size}
      height={size}
      loading="lazy"
      style={{ borderRadius: 4, marginRight: 2, verticalAlign: 'middle', background: '#2a2a33' }}
    />
  )
}

// ---------------------------------------------------------------------------
// Per-game stat cards — same layout as the season dashboard, but for one game.
// All values come from GRID (grid_games row + that game's player rows).
// ---------------------------------------------------------------------------
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0)
const sg = (v, d = 0) => (v == null ? '—' : (v > 0 ? '+' : '') + Number(v).toFixed(d))
const yn = (b) => (b === true ? { t: 'Yes', c: '#3aa76d' } : b === false ? { t: 'No', c: '#e0524a' } : { t: '—', c: 'var(--text-faint)' })

const CARD_DEFS = [
  { key: 'early', title: 'Early Game' },
  { key: 'economy', title: 'Economy' },
  { key: 'objectives', title: 'Objectives' },
  { key: 'teamAgg', title: 'Aggression (Team)' },
  { key: 'players', title: 'Players' },
]

function buildCards(g, players) {
  const sp = players.filter((p) => p.is_sentinels)
  const op = players.filter((p) => !p.is_sentinels)
  const min = g.game_duration_s ? g.game_duration_s / 60 : null
  const perMin = (v) => (min ? v / min : null)
  const sGold = sum(sp, (p) => p.gold_earned), oGold = sum(op, (p) => p.gold_earned)
  const sCs = sum(sp, (p) => p.cs)
  const sDmg = sum(sp, (p) => p.champ_damage)
  const sKills = g.sentinels_kills, sDeaths = g.opponent_kills
  const sAssists = sum(sp, (p) => p.assists)
  const sXp15 = sum(sp, (p) => p.xp_at_15), oXp15 = sum(op, (p) => p.xp_at_15)
  const num = (v, d = 1) => (v == null ? '—' : Number(v).toFixed(d))
  return {
    early: [
      { label: 'CS diff @15', value: sg(g.cs_diff_15, 1) },
      { label: 'Gold diff @15', value: sg(g.gold_diff_15, 0) },
      { label: 'XP diff @15', value: sXp15 && oXp15 ? sg(sXp15 - oXp15, 0) : '—' },
      { label: 'Ahead in CS @15', bool: g.cs_diff_15 == null ? null : g.cs_diff_15 > 0 },
      { label: 'First Blood', bool: g.first_blood_sentinels },
    ],
    economy: [
      { label: 'Gold / min', value: min ? Math.round(perMin(sGold)) : '—' },
      { label: 'Gold diff / min', value: min && op.length ? sg(perMin(sGold - oGold), 0) : '—' },
      { label: 'Gold diff @15', value: sg(g.gold_diff_15, 0) },
      { label: 'CS / min', value: min ? num(perMin(sCs), 1) : '—' },
      { label: 'CS diff @15', value: sg(g.cs_diff_15, 1) },
      { label: 'First Tower', bool: g.first_tower_sentinels },
      { label: 'Tower diff', value: sg((g.sentinels_towers ?? 0) - (g.opponent_towers ?? 0), 0) },
    ],
    objectives: [
      { label: 'Dragons', value: `${g.sentinels_dragons ?? '—'}${g.opponent_dragons != null ? ` (opp ${g.opponent_dragons})` : ''}` },
      { label: 'Voidgrubs', value: `${g.sentinels_grubs ?? '—'}${g.opponent_grubs != null ? ` (opp ${g.opponent_grubs})` : ''}` },
      { label: 'Herald', value: `${g.sentinels_heralds ?? '—'}${g.opponent_heralds != null ? ` (opp ${g.opponent_heralds})` : ''}` },
      { label: 'Baron / Nashor', value: `${g.sentinels_barons ?? '—'}${g.opponent_barons != null ? ` (opp ${g.opponent_barons})` : ''}` },
      { label: 'Towers', value: `${g.sentinels_towers ?? '—'}${g.opponent_towers != null ? ` (opp ${g.opponent_towers})` : ''}` },
    ],
    teamAgg: [
      { label: 'Damage / min', value: min ? Math.round(perMin(sDmg)) : '—' },
      { label: 'First Blood', bool: g.first_blood_sentinels },
      { label: 'Kills', value: sKills ?? '—' },
      { label: 'Deaths', value: sDeaths ?? '—' },
      { label: 'KDA', value: sDeaths ? num(((sKills || 0) + sAssists) / sDeaths, 1) : num((sKills || 0) + sAssists, 1) },
      { label: 'Assists / Kill', value: sKills ? num(sAssists / sKills, 1) : '—' },
    ],
  }
}

const ROLE_SORT = ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']
function StatCard({ title, rows }) {
  return (
    <div style={{ border: '1px solid #223', borderRadius: 8, overflow: 'hidden', background: '#10131a', minWidth: 260, flex: '1 1 300px' }}>
      <div style={{ background: '#2aa9c9', color: '#06222b', fontWeight: 800, fontSize: 13, padding: '6px 12px', letterSpacing: '.03em' }}>{title.toUpperCase()}</div>
      <div style={{ padding: '4px 0' }}>
        {rows.map((r, i) => {
          const b = r.bool !== undefined ? yn(r.bool) : null
          const negVal = typeof r.value === 'string' && r.value.startsWith('-')
          return (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 12px', fontSize: 13 }}>
              <span style={{ color: 'var(--text-faint)' }}>{r.label}</span>
              {b
                ? <span style={{ fontWeight: 700, color: b.c }}>{b.t}</span>
                : <span style={{ fontWeight: 700, color: negVal ? '#e0524a' : (typeof r.value === 'string' && r.value.startsWith('+')) ? '#3aa76d' : 'var(--text)' }}>{r.value}</span>}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PlayersCard({ players }) {
  const sp = players.filter((p) => p.is_sentinels)
    .sort((a, b) => ROLE_SORT.indexOf(a.team_position) - ROLE_SORT.indexOf(b.team_position))
  const th = { textAlign: 'right', padding: '4px 8px', fontSize: 10, color: 'var(--text-faint)', textTransform: 'uppercase' }
  const td = { textAlign: 'right', padding: '4px 8px', fontSize: 12 }
  return (
    <div style={{ border: '1px solid #223', borderRadius: 8, overflow: 'hidden', background: '#10131a', flex: '1 1 100%', minWidth: 320 }}>
      <div style={{ background: '#2aa9c9', color: '#06222b', fontWeight: 800, fontSize: 13, padding: '6px 12px' }}>PLAYERS</div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>
            <th style={{ ...th, textAlign: 'left' }}>Player</th>
            <th style={th}>K/D/A</th><th style={th}>Dmg/min</th><th style={th}>Dmg%</th>
            <th style={th}>CS/min</th><th style={th}>KP%</th><th style={th}>Penta</th>
          </tr></thead>
          <tbody>
            {sp.map((p) => (
              <tr key={p.player} style={{ borderTop: '1px solid #1c2230' }}>
                <td style={{ ...td, textAlign: 'left', fontWeight: 600 }}>{p.player}</td>
                <td style={td}>{p.kills ?? 0}/{p.deaths ?? 0}/{p.assists ?? 0}</td>
                <td style={td}>{p.champ_damage_per_min != null ? Math.round(p.champ_damage_per_min) : '—'}</td>
                <td style={td}>{p.champ_damage_share != null ? `${Math.round(p.champ_damage_share)}%` : '—'}</td>
                <td style={td}>{p.cs_per_min != null ? p.cs_per_min.toFixed(1) : '—'}</td>
                <td style={td}>{p.kill_participation != null ? `${Math.round(p.kill_participation)}%` : '—'}</td>
                <td style={td}>{p.penta_kills || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function GameDetails({ g, players, sel }) {
  if (!g.riot_enriched) return <div style={{ padding: 10, color: 'var(--text-faint)', fontSize: 12 }}>No enriched data for this game yet.</div>
  const cards = buildCards(g, players || [])
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, padding: '12px 4px' }}>
      {sel.has('early') && <StatCard title="Early Game" rows={cards.early} />}
      {sel.has('economy') && <StatCard title="Economy" rows={cards.economy} />}
      {sel.has('objectives') && <StatCard title="Objectives" rows={cards.objectives} />}
      {sel.has('teamAgg') && <StatCard title="Aggression (Team)" rows={cards.teamAgg} />}
      {sel.has('players') && <PlayersCard players={players || []} />}
    </div>
  )
}

export default function MatchHistory() {
  const champs = useChampions()
  const [visibleCount, setVisibleCount] = useState(50)
  const [picksByGame, setPicksByGame] = useState({})
  const [openGames, setOpenGames] = useState({}) // gameId -> Set of selected card keys
  const toggleOpen = (id) => setOpenGames((prev) => {
    const next = { ...prev }
    if (next[id]) delete next[id]
    else next[id] = new Set(CARD_DEFS.map((c) => c.key)) // all cards on by default
    return next
  })
  const toggleCard = (id, key) => setOpenGames((prev) => {
    const cur = new Set(prev[id] || [])
    if (cur.has(key)) cur.delete(key); else cur.add(key)
    return { ...prev, [id]: cur }
  })

  const { data: series, loading: sLoading } = useSupabaseQuery(
    () => supabase.from('grid_series').select('grid_series_id, series_date, opponent_name, series_type'),
    []
  )
  const { data: games, loading: gLoading, refetch: refetchGames } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, game_number, sentinels_won, manual_won, excluded, patch, sentinels_side, sentinels_bans, opponent_bans, riot_enriched, ' +
      'game_duration_s, gold_diff_15, cs_diff_15, first_blood_sentinels, first_tower_sentinels, ' +
      'sentinels_dragons, opponent_dragons, sentinels_heralds, opponent_heralds, sentinels_grubs, opponent_grubs, ' +
      'sentinels_barons, opponent_barons, sentinels_towers, opponent_towers, ' +
      'sentinels_gold_at_15, opponent_gold_at_15, sentinels_cs_at_15, opponent_cs_at_15, ' +
      'sentinels_kills, opponent_kills, positive_plays, give_backs, snowballs'
    )),
    []
  )
  const { data: sessions } = useSupabaseQuery(
    () => supabase.from('sessions').select('session_date, opponent, session_type'),
    []
  )
  const { data: opponents } = useSupabaseQuery(
    () => supabase.from('opponents').select('code, team_name'),
    []
  )

  // code -> canonical name (to match a session's opponent code to a game's opponent)
  const codeToCanon = useMemo(() => {
    const m = {}
    for (const o of opponents || []) if (o.code) m[o.code] = canonicalOpponentName(o.team_name || o.code)
    return m
  }, [opponents])

  // date|canonicalOpponent -> session_type
  const sessionColorMap = useMemo(() => {
    const m = {}
    for (const s of sessions || []) {
      if (!s.session_date || !s.session_type) continue
      const canon = codeToCanon[s.opponent] || canonicalOpponentName(s.opponent || '')
      m[`${s.session_date}|${canon}`] = s.session_type
      m[`${s.session_date}|*`] = m[`${s.session_date}|*`] || s.session_type // date-only fallback
    }
    return m
  }, [sessions, codeToCanon])

  const seriesById = useMemo(() => {
    const m = {}
    for (const s of series || []) m[s.grid_series_id] = s
    return m
  }, [series])

  // one merged row per game, newest first
  const rows = useMemo(() => {
    if (!games || !series) return []
    const out = []
    for (const g of games) {
      const s = seriesById[g.grid_series_id]
      if (!s || g.excluded) continue
      const canon = canonicalOpponentName(s.opponent_name || '')
      const official = s.series_type === 'ESPORTS'
      const stype = official ? 'Official' : (sessionColorMap[`${s.series_date}|${canon}`] || null)
      out.push({
        gameId: g.id,
        date: s.series_date,
        gameNumber: g.game_number,
        tournament: s.series_type === 'ESPORTS' ? 'Official' : 'Scrim',
        sessionType: stype,
        color: stype ? SESSION_COLORS[stype] : null,
        patch: g.patch,
        won: g.manual_won ?? g.sentinels_won,
        manualWon: g.manual_won,
        side: g.sentinels_side,
        opponent: canon,
        ourBans: g.sentinels_bans || [],
        oppBans: g.opponent_bans || [],
        enriched: g.riot_enriched,
        raw: g,
      })
    }
    out.sort((a, b) => {
      if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '')
      return (b.gameNumber ?? 0) - (a.gameNumber ?? 0)
    })
    return out
  }, [games, series, seriesById, sessionColorMap])

  const visible = rows.slice(0, visibleCount)

  // fetch picks/players for the visible games only
  useEffect(() => {
    const ids = visible.map((r) => r.gameId).filter((id) => !(id in picksByGame))
    if (!ids.length) return
    let alive = true
    ;(async () => {
      const { data } = await supabase
        .from('grid_player_games')
        .select('game_id, player, champion, is_sentinels, team_position, kills, deaths, assists, ' +
          'champ_damage, champ_damage_per_min, champ_damage_share, cs, cs_per_min, cs_at_15, gold_at_15, xp_at_15, ' +
          'gold_earned, kill_participation, penta_kills, quadra_kills, vision_score')
        .in('game_id', ids.slice(0, 200))
      if (!alive || !data) return
      const add = {}
      for (const p of data) {
        (add[p.game_id] ??= []).push(p)
      }
      setPicksByGame((prev) => ({ ...prev, ...add }))
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount, rows])

  const orderPicks = (list, sentinels) =>
    (list || [])
      .filter((p) => p.is_sentinels === sentinels)
      .sort((a, b) => ROLE_ORDER.indexOf(a.team_position) - ROLE_ORDER.indexOf(b.team_position))

  async function setResult(gameId, val) {
    await supabase.from('grid_games').update({ manual_won: val }).eq('id', gameId)
    refetchGames()
  }
  async function deleteGame(gameId) {
    if (!window.confirm('Delete this game? It will be hidden from every page and skipped by future syncs.')) return
    await supabase.from('grid_games').update({ excluded: true }).eq('id', gameId)
    refetchGames()
  }

  const loading = sLoading || gLoading
  const th = { padding: '8px 10px', textAlign: 'left', fontSize: 11, letterSpacing: '.04em', color: 'var(--text-faint)', textTransform: 'uppercase', whiteSpace: 'nowrap' }
  const td = { padding: '7px 10px', fontSize: 13, verticalAlign: 'middle', whiteSpace: 'nowrap' }

  return (
    <>
    <DailySync />
    <div className="panel" style={{ overflowX: 'auto' }}>
      <h2>Match History</h2>
      <p className="panel-caption">
        Every game newest-first — scrims and officials. Tournament colour is your session
        classification (Green / Orange / Red), Officials in gold. Bans and picks pulled from the draft.
        Click a game to open it — you can set the <b>result</b> by hand (for games where the enemy left and GRID never called a winner) or <b>delete</b> a game there.
      </p>

      {loading && <div className="loading-state">Loading match history…</div>}

      {!loading && rows.length === 0 && <div className="empty-state">No games in the database yet.</div>}

      {!loading && rows.length > 0 && (
        <>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1100 }}>
            <thead>
              <tr>
                <th style={th}>Date</th>
                <th style={th}>Tournament</th>
                <th style={th}>Patch</th>
                <th style={th}>W/L</th>
                <th style={th}>Side</th>
                <th style={th}>Vs</th>
                <th style={th}>Bans</th>
                <th style={th}>Bans Vs</th>
                <th style={th}>Picks</th>
                <th style={th}>Picks Vs</th>
                <th style={th}>Players</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const ours = orderPicks(picksByGame[r.gameId], true)
                const theirs = orderPicks(picksByGame[r.gameId], false)
                const open = openGames[r.gameId]
                return (
                  <Fragment key={r.gameId}>
                  <tr onClick={() => toggleOpen(r.gameId)} title="Click for per-game stats" style={{ borderTop: '1px solid var(--border, #2b2b33)', cursor: 'pointer', background: open ? '#141821' : undefined }}>
                    <td style={td}><span style={{ color: 'var(--text-faint)', marginRight: 6 }}>{open ? '▾' : '▸'}</span>{r.date}</td>
                    <td style={td}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                        <span style={{ width: 9, height: 9, borderRadius: '50%', background: r.color || '#555', display: 'inline-block' }} />
                        {r.sessionType || r.tournament}
                      </span>
                    </td>
                    <td style={{ ...td, color: 'var(--text-faint)' }}>{r.patch || '—'}</td>
                    <td style={{ ...td, fontWeight: 600, color: r.won === true ? '#3fb950' : r.won === false ? '#e5534b' : 'var(--text-faint)' }}>
                      {r.won === true ? 'Win' : r.won === false ? 'Loss' : '—'}
                    </td>
                    <td style={{ ...td, color: r.side === 'Blue' ? '#4c8bf5' : r.side === 'Red' ? '#e5534b' : 'var(--text-faint)' }}>
                      {r.side || '—'}
                    </td>
                    <td style={td}>{r.opponent}</td>
                    <td style={td}>
                      {r.ourBans.length ? r.ourBans.map((id, i) => (
                        <ChampIcon key={i} champKey={champs.idToKey[id]} ver={champs.ver} title={champs.idToKey[id]} size={22} />
                      )) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    <td style={td}>
                      {r.oppBans.length ? r.oppBans.map((id, i) => (
                        <ChampIcon key={i} champKey={champs.idToKey[id]} ver={champs.ver} title={champs.idToKey[id]} size={22} />
                      )) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    <td style={td}>
                      {ours.length ? ours.map((p, i) => (
                        <ChampIcon key={i} champKey={champs.nameToKey[norm(p.champion)]} ver={champs.ver} title={`${p.player}: ${p.champion}`} />
                      )) : <span style={{ color: 'var(--text-faint)' }}>{r.enriched ? '—' : '…'}</span>}
                    </td>
                    <td style={td}>
                      {theirs.length ? theirs.map((p, i) => (
                        <ChampIcon key={i} champKey={champs.nameToKey[norm(p.champion)]} ver={champs.ver} title={p.champion} />
                      )) : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    <td style={{ ...td, color: 'var(--text-faint)', fontSize: 12 }}>
                      {ours.map((p) => p.player).join(', ')}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={11} style={{ padding: '2px 10px 14px', background: '#141821' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 2px', borderBottom: '1px solid var(--border, #2b2b33)' }}>
                          <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>Result:</span>
                          {[['Win', true], ['Loss', false], ['Clear', null]].map(([lbl, val]) => {
                            const isActive = val === null ? r.manualWon == null : r.manualWon === val
                            return (
                              <button key={lbl} type="button" onClick={(e) => { e.stopPropagation(); setResult(r.gameId, val) }}
                                style={{ padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 700,
                                  border: '1px solid var(--border, #2b2b33)',
                                  background: isActive ? (val === true ? '#12351f' : val === false ? '#3a1d1d' : '#26262e') : 'transparent',
                                  color: val === true ? '#3fb950' : val === false ? '#e5534b' : 'var(--text-faint)' }}>
                                {lbl}
                              </button>
                            )
                          })}
                          {r.manualWon != null && <span style={{ fontSize: 11, color: '#c9a227' }}>manual result</span>}
                          {!r.enriched && <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>· no GRID end-game (enemy left?) — set the result by hand</span>}
                          <button type="button" onClick={(e) => { e.stopPropagation(); deleteGame(r.gameId) }}
                            style={{ marginLeft: 'auto', padding: '4px 12px', borderRadius: 6, fontSize: 12, cursor: 'pointer', fontWeight: 700, border: '1px solid #5a2b2b', background: 'transparent', color: '#e5534b' }}>
                            Delete game
                          </button>
                        </div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, padding: '6px 2px' }}>
                          {CARD_DEFS.map((c) => (
                            <label key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text)', cursor: 'pointer' }}>
                              <input type="checkbox" checked={open.has(c.key)} onChange={() => toggleCard(r.gameId, c.key)} />
                              {c.title}
                            </label>
                          ))}
                        </div>
                        <GameDetails g={r.raw} players={picksByGame[r.gameId]} sel={open} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>

          {visibleCount < rows.length && (
            <div style={{ marginTop: 14, textAlign: 'center' }}>
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + 50)}
                style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid var(--border, #333)', background: 'transparent', color: 'var(--text)', cursor: 'pointer', fontSize: 13 }}
              >
                Show more ({rows.length - visibleCount} left)
              </button>
            </div>
          )}
        </>
      )}
    </div>
    </>
  )
}
