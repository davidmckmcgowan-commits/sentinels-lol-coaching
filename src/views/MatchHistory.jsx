import { useEffect, useMemo, useState } from 'react'
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

export default function MatchHistory() {
  const champs = useChampions()
  const [visibleCount, setVisibleCount] = useState(50)
  const [picksByGame, setPicksByGame] = useState({})

  const { data: series, loading: sLoading } = useSupabaseQuery(
    () => supabase.from('grid_series').select('grid_series_id, series_date, opponent_name, series_type'),
    []
  )
  const { data: games, loading: gLoading } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games').select(
      'id, grid_series_id, game_number, sentinels_won, patch, sentinels_side, sentinels_bans, opponent_bans, riot_enriched'
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
      if (!s) continue
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
        won: g.sentinels_won,
        side: g.sentinels_side,
        opponent: canon,
        ourBans: g.sentinels_bans || [],
        oppBans: g.opponent_bans || [],
        enriched: g.riot_enriched,
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
        .select('game_id, player, champion, is_sentinels, team_position')
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
                return (
                  <tr key={r.gameId} style={{ borderTop: '1px solid var(--border, #2b2b33)' }}>
                    <td style={td}>{r.date}</td>
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
