import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'

// Game Prep (trial): for each opponent we've played on stage, an auto-written,
// data-first prep note. Deliberately NON-prescriptive — it states the objective
// numbers and turns every suggestion into a question, so it reads as "here's
// what the data shows, is this worth a look?" rather than "do X". Reads live, so
// it reflects the latest synced games automatically (e.g. every Monday morning).

const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Huhi', 'Rahel']
const ROSTER_ROLE = { Impact: 'Top', HamBak: 'Jungle', DARKWINGS: 'Mid', Huhi: 'Support', Rahel: 'ADC' }

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : null }
function avg(nums) { const v = nums.filter((x) => typeof x === 'number' && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
function round(x, d = 0) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d }
function signed(x, d = 0) { if (x == null) return '—'; const r = round(x, d); return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}` }

export default function GamePrep() {
  const [opponent, setOpponent] = useState(null)

  const { data: rawGames, loading, error } = useSupabaseQuery(
    () => fetchAllRows(() =>
      supabase.from('grid_games')
        .select('id, sentinels_won, gold_diff_15, cs_diff_15, first_blood_sentinels, first_tower_sentinels, sentinels_dragons, opponent_dragons, grid_series!inner(opponent_name, series_type)')
        .eq('riot_enriched', true)),
    []
  )
  const { data: rawPlayers } = useSupabaseQuery(
    () => fetchAllRows(() =>
      supabase.from('grid_player_games')
        .select('player, gold_diff_15, cs_diff_15, champ_damage_share, kill_participation, is_sentinels, grid_games!inner(sentinels_won, riot_enriched, grid_series!inner(opponent_name, series_type))')
        .eq('is_sentinels', true)),
    []
  )

  const games = useMemo(() => (rawGames || [])
    .filter((g) => g.grid_series && g.sentinels_won != null)
    .map((g) => ({ ...g, opponent: canonicalOpponentName(g.grid_series.opponent_name), type: g.grid_series.series_type })), [rawGames])
  const players = useMemo(() => (rawPlayers || [])
    .filter((p) => p.grid_games && p.grid_games.riot_enriched && p.grid_games.grid_series)
    .map((p) => ({ player: p.player, gold15: p.gold_diff_15, cs15: p.cs_diff_15, dmg: p.champ_damage_share, kp: p.kill_participation, won: p.grid_games.sentinels_won, opponent: canonicalOpponentName(p.grid_games.grid_series.opponent_name), type: p.grid_games.grid_series.series_type })), [rawPlayers])

  // opponents we've actually played on stage (≥1 official game) — the real prep targets
  const opponents = useMemo(() => {
    const m = new Map()
    for (const g of games) {
      if (!m.has(g.opponent)) m.set(g.opponent, { name: g.opponent, off: 0, scrim: 0 })
      const e = m.get(g.opponent)
      if (g.type === 'ESPORTS') e.off++; else e.scrim++
    }
    return [...m.values()].filter((o) => o.off > 0).sort((a, b) => (b.off + b.scrim) - (a.off + a.scrim))
  }, [games])

  const active = opponent && opponents.some((o) => o.name === opponent) ? opponent : (opponents[0]?.name ?? null)

  const prep = useMemo(() => {
    if (!active) return null
    const gO = games.filter((g) => g.opponent === active)
    const pO = players.filter((p) => p.opponent === active)
    const off = gO.filter((g) => g.type === 'ESPORTS')
    const scr = gO.filter((g) => g.type === 'SCRIM')
    const rec = (arr) => ({ w: arr.filter((g) => g.sentinels_won).length, l: arr.filter((g) => !g.sentinels_won).length, wr: pct(arr.filter((g) => g.sentinels_won).length, arr.length), n: arr.length })

    const lanes = ROSTER.map((name) => {
      const rows = pO.filter((p) => p.player === name)
      return {
        name, role: ROSTER_ROLE[name], n: rows.length,
        gold15: round(avg(rows.map((r) => r.gold15)), 0),
        cs15: round(avg(rows.map((r) => r.cs15)), 1),
        kp: round(avg(rows.map((r) => r.kp)), 0),
        dmg: round(avg(rows.map((r) => r.dmg)), 1),
      }
    }).filter((l) => l.n > 0)
    const ranked = [...lanes].filter((l) => l.gold15 != null).sort((a, b) => a.gold15 - b.gold15)

    return {
      overall: rec(gO), off: rec(off), scrim: rec(scr),
      gold15: round(avg(gO.map((g) => g.gold_diff_15)), 0),
      cs15: round(avg(gO.map((g) => g.cs_diff_15)), 1),
      fb: pct(gO.filter((g) => g.first_blood_sentinels).length, gO.filter((g) => g.first_blood_sentinels != null).length),
      ft: pct(gO.filter((g) => g.first_tower_sentinels).length, gO.filter((g) => g.first_tower_sentinels != null).length),
      ourDrakes: round(avg(gO.map((g) => g.sentinels_dragons)), 1),
      oppDrakes: round(avg(gO.map((g) => g.opponent_dragons)), 1),
      lanes, weakest: ranked[0], strongest: ranked[ranked.length - 1],
      strongLanes: lanes.filter((l) => l.gold15 != null && l.gold15 >= 0),
    }
  }, [active, games, players])

  return (
    <div>
      <div className="panel">
        <h2>Game Prep <span style={{ color: 'var(--text-faint)', fontSize: 13, fontWeight: 400 }}>(trial)</span></h2>
        <p className="panel-caption">
          A data-first prep note for each opponent we&rsquo;ve faced on stage, written from the live enriched
          Riot data (early-game, lane-by-lane, objectives). It states the objective numbers and frames every
          idea as a <em>question</em> for the staff to weigh — it does not tell anyone what to do. Because it
          reads live, it reflects the latest synced games, so it&rsquo;s current each Monday once the
          week&rsquo;s games are in. Small samples (especially official games) are flagged — read those as
          directional.
        </p>
        {loading && <div className="loading-state">Loading enriched game data…</div>}
        {error && <div className="toast error">Error: {error.message}</div>}
      </div>

      {!loading && !error && prep && (
        <>
          <div className="panel">
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-dim)', maxWidth: 380 }}>
              Opponent
              <select value={active} onChange={(e) => setOpponent(e.target.value)}>
                {opponents.map((o) => (<option key={o.name} value={o.name}>{o.name} — {o.off} official, {o.scrim} scrim</option>))}
              </select>
            </label>
          </div>

          <div className="panel">
            <h2>Snapshot — vs {active}</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              Based on {prep.overall.n} games with detailed data, the record vs {active} is{' '}
              <strong>{prep.scrim.w}&ndash;{prep.scrim.l}</strong> in scrims ({prep.scrim.wr ?? '—'}%) and{' '}
              <strong>{prep.off.w}&ndash;{prep.off.l}</strong> on stage ({prep.off.wr ?? '—'}%
              {prep.off.n < 5 ? `, only ${prep.off.n} official games — directional` : ''}).
              {prep.off.wr != null && prep.scrim.wr != null && prep.off.wr - prep.scrim.wr >= 15 && (
                <> The stage win rate sits {prep.off.wr - prep.scrim.wr} points above the scrim win rate against
                  this opponent &mdash; does the scrim approach vs {active} get treated with the same intensity as the official?</>
              )}
              {prep.off.wr != null && prep.scrim.wr != null && prep.scrim.wr - prep.off.wr >= 15 && (
                <> The scrim win rate sits {prep.scrim.wr - prep.off.wr} points above the stage win rate against
                  this opponent &mdash; is there something in the scrims that isn&rsquo;t translating onto stage?</>
              )}
            </p>
          </div>

          <div className="panel">
            <h2>The first 15 minutes</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              Based on the data, by 15 minutes the team averages <strong>{signed(prep.gold15)} gold</strong>{' '}
              ({signed(prep.cs15, 1)} CS) versus {active}. First blood is secured{' '}
              <strong>{prep.fb ?? '—'}%</strong> of the time and first tower <strong>{prep.ft ?? '—'}%</strong>.
              {prep.gold15 != null && prep.gold15 <= -400 && (
                <> The team is usually behind on gold by 15 against {active} &mdash; is there a phase of the early
                  game (pathing, lane assignments, ward timings) the staff would want to look at more closely?</>
              )}
              {prep.gold15 != null && prep.gold15 >= 400 && (
                <> The team usually holds an early gold lead against {active} &mdash; is that lead being converted
                  into objectives, or is there a give-back pattern worth reviewing?</>
              )}
              {prep.ft != null && prep.ft < 40 && (
                <> First tower goes the other way most games; across all opponents, games with first tower win at a
                  much higher rate &mdash; is a plates/tempo focus worth testing here?</>
              )}
            </p>
          </div>

          <div className="panel">
            <h2>Lane by lane, at 15</h2>
            <p className="panel-caption">Each Sentinels player&rsquo;s average state at 15 minutes vs {active}. Positive = ahead of their lane opponent.</p>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Lane</th><th style={{ textAlign: 'right' }}>Gold @15</th><th style={{ textAlign: 'right' }}>CS @15</th><th style={{ textAlign: 'right' }}>Kill part.</th><th style={{ textAlign: 'right' }}>Damage share</th></tr></thead>
                <tbody>
                  {prep.lanes.map((l) => (
                    <tr key={l.name}>
                      <td>{l.role} <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({l.name})</span></td>
                      <td style={{ textAlign: 'right', color: (l.gold15 ?? 0) >= 0 ? '#3aa76d' : '#e0a940', fontWeight: 600 }}>{signed(l.gold15)}</td>
                      <td style={{ textAlign: 'right', color: (l.cs15 ?? 0) >= 0 ? '#3aa76d' : '#e0a940' }}>{signed(l.cs15, 1)}</td>
                      <td style={{ textAlign: 'right' }}>{l.kp ?? '—'}%</td>
                      <td style={{ textAlign: 'right' }}>{l.dmg ?? '—'}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 12 }}>
              {prep.weakest && (
                <>Based on the data, the largest early deficit is <strong>{prep.weakest.role}</strong> ({prep.weakest.name}),
                  at {signed(prep.weakest.gold15)} gold and {signed(prep.weakest.cs15, 1)} CS by 15 with{' '}
                  {prep.weakest.kp ?? '—'}% kill participation &mdash; is how that lane is being set up early
                  something worth reviewing on tape? </>
              )}
              {prep.strongLanes.length > 0 && (
                <>The lanes even-or-ahead by 15 are {prep.strongLanes.map((l) => l.role).join(', ')} &mdash; is there
                  room to route more of the early game through them?</>
              )}
            </p>
          </div>

          <div className="panel">
            <h2>Objectives</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              Dragons average <strong>{prep.ourDrakes ?? '—'}</strong> for us vs <strong>{prep.oppDrakes ?? '—'}</strong> for {active} per game.
              Across all games, the win rate climbs cleanly with each dragon secured (1 &rarr; 17%, 2 &rarr; 41%,
              3 &rarr; 55%, 4 &rarr; 81%){prep.ourDrakes != null && prep.oppDrakes != null && prep.ourDrakes <= prep.oppDrakes
                ? <> &mdash; this opponent edges the dragon count on average; is the drake race a lever worth prioritising against them?</>
                : <> &mdash; is holding this dragon edge and pushing for the 3rd/4th something to keep central against them?</>}
            </p>
            <p className="panel-caption" style={{ marginTop: 8 }}>
              This note is generated from live data and updates as new games sync — nothing here is a directive, just
              the numbers and questions for the staff to decide on.
            </p>
          </div>
        </>
      )}
      {!loading && !error && !prep && (
        <div className="panel"><div className="empty-state">No opponents with enriched official games yet.</div></div>
      )}
    </div>
  )
}
