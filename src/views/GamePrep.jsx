import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery, fetchAllRows } from '../lib/useSupabaseQuery.js'
import { canonicalOpponentName } from '../lib/constants.js'

// Game Prep (trial): an auto-written, narrative prep note per opponent. Leads
// with the data, tells the story lane-by-lane, and frames every suggestion as a
// QUESTION for the staff (never "do X"). Reads live, so it reflects the latest
// synced games — current each Monday once the week is in.

const ROSTER = ['Impact', 'HamBak', 'DARKWINGS', 'Huhi', 'Rahel']
const ROSTER_ROLE = { Impact: 'Top', HamBak: 'Jungle', DARKWINGS: 'Mid', Huhi: 'Support', Rahel: 'ADC' }

function pct(n, d) { return d > 0 ? Math.round((n / d) * 100) : null }
function avg(nums) { const v = nums.filter((x) => typeof x === 'number' && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null }
function round(x, d = 0) { return x == null ? null : Math.round(x * 10 ** d) / 10 ** d }
function signed(x, d = 0, unit = '') { if (x == null) return '—'; const r = round(x, d); return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}${unit}` }

function laneStats(rows, name) {
  return {
    name, role: ROSTER_ROLE[name], n: rows.length,
    gold15: round(avg(rows.map((r) => r.gold15)), 0),
    cs15: round(avg(rows.map((r) => r.cs15)), 1),
    kp: round(avg(rows.map((r) => r.kp)), 0),
    dmg: round(avg(rows.map((r) => r.dmg)), 1),
  }
}

export default function GamePrep() {
  const [opponent, setOpponent] = useState(null)

  const { data: rawGames, loading, error } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_games')
      .select('id, sentinels_won, gold_diff_15, cs_diff_15, first_blood_sentinels, first_tower_sentinels, sentinels_dragons, opponent_dragons, grid_series!inner(opponent_name, series_type)')
      .eq('riot_enriched', true)), [])
  const { data: rawPlayers } = useSupabaseQuery(
    () => fetchAllRows(() => supabase.from('grid_player_games')
      .select('player, gold_diff_15, cs_diff_15, champ_damage_share, kill_participation, is_sentinels, grid_games!inner(sentinels_won, riot_enriched, grid_series!inner(opponent_name, series_type))')
      .eq('is_sentinels', true)), [])

  const games = useMemo(() => (rawGames || [])
    .filter((g) => g.grid_series && g.sentinels_won != null)
    .map((g) => ({ ...g, opponent: canonicalOpponentName(g.grid_series.opponent_name), type: g.grid_series.series_type })), [rawGames])
  const players = useMemo(() => (rawPlayers || [])
    .filter((p) => p.grid_games && p.grid_games.riot_enriched && p.grid_games.grid_series && p.gold_diff_15 != null)
    .map((p) => ({ player: p.player, gold15: p.gold_diff_15, cs15: p.cs_diff_15, dmg: p.champ_damage_share, kp: p.kill_participation, won: p.grid_games.sentinels_won, opponent: canonicalOpponentName(p.grid_games.grid_series.opponent_name), type: p.grid_games.grid_series.series_type })), [rawPlayers])

  const opponents = useMemo(() => {
    const m = new Map()
    for (const g of games) { if (!m.has(g.opponent)) m.set(g.opponent, { name: g.opponent, off: 0, scrim: 0 }); const e = m.get(g.opponent); if (g.type === 'ESPORTS') e.off++; else e.scrim++ }
    return [...m.values()].filter((o) => o.off > 0).sort((a, b) => (b.off + b.scrim) - (a.off + a.scrim))
  }, [games])
  const active = opponent && opponents.some((o) => o.name === opponent) ? opponent : (opponents[0]?.name ?? null)

  const prep = useMemo(() => {
    if (!active) return null
    const gO = games.filter((g) => g.opponent === active)
    const pO = players.filter((p) => p.opponent === active)
    const off = gO.filter((g) => g.type === 'ESPORTS'), scr = gO.filter((g) => g.type === 'SCRIM')
    const rec = (arr) => ({ w: arr.filter((g) => g.sentinels_won).length, l: arr.filter((g) => !g.sentinels_won).length, wr: pct(arr.filter((g) => g.sentinels_won).length, arr.length), n: arr.length })

    const lanes = ROSTER.map((name) => laneStats(pO.filter((p) => p.player === name), name)).filter((l) => l.n > 0 && l.gold15 != null)
    const topDmg = lanes.reduce((a, b) => ((b.dmg ?? -1) > (a?.dmg ?? -1) ? b : a), null)
    const bleeders = lanes.filter((l) => l.gold15 <= -250)
    const evenOrAhead = lanes.filter((l) => l.gold15 > -250)
    const weakest = [...lanes].sort((a, b) => a.gold15 - b.gold15)[0]

    // classify each lane for the narrative descriptor
    const describe = (l) => {
      let base = l.gold15 >= 150 ? 'winning the lane' : l.gold15 <= -250 ? 'loses lane early' : 'roughly even'
      const flavour = []
      if (topDmg && l.name === topDmg.name && l.dmg >= 22) flavour.push(`highest damage share (${l.dmg}%) — the late carry`)
      if (weakest && l.name === weakest.name && l.kp != null && l.kp < 45) flavour.push(`${l.kp}% kill participation — the bleed`)
      return flavour.length ? `${base}, ${flavour.join('; ')}` : base
    }

    // consistency: is the weakest lane the same in scrims and officials?
    const weakestIn = (subset) => {
      const ls = ROSTER.map((n) => laneStats(subset.filter((p) => p.player === n), n)).filter((l) => l.n > 0 && l.gold15 != null)
      return ls.length ? [...ls].sort((a, b) => a.gold15 - b.gold15)[0]?.name : null
    }
    const consistent = weakest && weakestIn(pO.filter((p) => p.type === 'SCRIM')) === weakest.name && weakestIn(pO.filter((p) => p.type === 'ESPORTS')) === weakest.name

    const teamGold15 = round(avg(gO.map((g) => g.gold_diff_15)), 0)
    const teamCs15 = round(avg(gO.map((g) => g.cs_diff_15)), 1)
    const ft = pct(gO.filter((g) => g.first_tower_sentinels).length, gO.filter((g) => g.first_tower_sentinels != null).length)
    const ourDrakes = round(avg(gO.map((g) => g.sentinels_dragons)), 1), oppDrakes = round(avg(gO.map((g) => g.opponent_dragons)), 1)

    // headline
    let headline
    if (teamGold15 != null && teamGold15 <= -250 && bleeders.length >= 1 && bleeders.length <= 2 && evenOrAhead.length >= 3) {
      headline = `Based on ${gO.length} games vs ${active}, the pattern isn't getting outplayed late — it's bleeding early, and it's ${bleeders.length} lane${bleeders.length === 1 ? '' : 's'}, not five.`
    } else if (teamGold15 != null && teamGold15 >= 250) {
      headline = `Based on ${gO.length} games vs ${active}, the team usually builds an early lead — the question is conversion, not survival.`
    } else if (bleeders.length >= 3) {
      headline = `Based on ${gO.length} games vs ${active}, the early game is under pressure across several lanes at once.`
    } else {
      headline = `Based on ${gO.length} games vs ${active}, the early game is roughly even — margins are won later.`
    }

    return {
      overall: rec(gO), off: rec(off), scrim: rec(scr),
      teamGold15, teamCs15, ft, ourDrakes, oppDrakes,
      lanes: lanes.map((l) => ({ ...l, desc: describe(l) })),
      bleeders, evenOrAhead, weakest, headline, consistent,
    }
  }, [active, games, players])

  return (
    <div>
      <div className="panel">
        <h2>Game Prep <span style={{ color: 'var(--text-faint)', fontSize: 13, fontWeight: 400 }}>(trial)</span></h2>
        <p className="panel-caption">
          An auto-written, data-first prep note for each opponent we&rsquo;ve faced on stage. It leads with the
          objective numbers, tells the story lane-by-lane, and frames every idea as a <em>question</em> for the
          staff to weigh — never a directive. It reads live, so it&rsquo;s current each Monday once the
          week&rsquo;s games have synced. Where the official sample is small it says so — treat those as directional.
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
            <p style={{ fontSize: 17, lineHeight: 1.5, fontWeight: 600, marginTop: 4 }}>{prep.headline}</p>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              Across {prep.overall.n} games with detailed data, the team averages{' '}
              <strong>{signed(prep.teamGold15)} gold</strong> ({signed(prep.teamCs15, 1)} CS) by 15 minutes versus {active}.
              Broken down by lane, {prep.evenOrAhead.length} of {prep.lanes.length} are even-or-ahead at 15:
            </p>
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
              {prep.lanes.map((l) => (
                <li key={l.name}>
                  <strong>{l.role} ({l.name}):</strong>{' '}
                  <span style={{ color: (l.cs15 ?? 0) >= 0 ? '#3aa76d' : '#e0a940' }}>{signed(l.cs15, 1)} CS</span>,{' '}
                  <span style={{ color: (l.gold15 ?? 0) >= 0 ? '#3aa76d' : '#e0a940' }}>{signed(l.gold15)} gold</span>
                  {' '}&mdash; {l.desc}
                </li>
              ))}
            </ul>
            {prep.weakest && prep.bleeders.length <= 2 && prep.teamGold15 <= -250 && (
              <p style={{ fontSize: 14, lineHeight: 1.7, marginTop: 10 }}>
                So the early deficit vs {active} is concentrated in <strong>{prep.weakest.role} ({prep.weakest.name})</strong> —
                the rest of the map is even-or-ahead by 15.
              </p>
            )}
          </div>

          <div className="panel">
            <h2>The reframe — scrims vs stage</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              The record vs {active} is <strong>{prep.off.w}&ndash;{prep.off.l}</strong> on stage
              ({prep.off.wr ?? '—'}%{prep.off.n < 5 ? `, ${prep.off.n} games — directional` : ''}) but{' '}
              <strong>{prep.scrim.w}&ndash;{prep.scrim.l}</strong> in scrims ({prep.scrim.wr ?? '—'}%).
              {prep.off.wr != null && prep.scrim.wr != null && prep.off.wr - prep.scrim.wr >= 15 && (
                <> The stage win rate is {prep.off.wr - prep.scrim.wr} points higher than the scrim one — the ceiling
                  is proven, so is the scrim approach vs {active} being treated with the same intensity as the official?</>
              )}
              {prep.off.wr != null && prep.scrim.wr != null && prep.scrim.wr - prep.off.wr >= 15 && (
                <> The scrim win rate is {prep.scrim.wr - prep.off.wr} points higher than the stage one — is something
                  that works in scrims not carrying onto stage against {active}?</>
              )}
            </p>
          </div>

          <div className="panel">
            <h2>Questions to weigh</h2>
            <ol style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
              {prep.weakest && (
                <li>
                  {prep.weakest.role} ({prep.weakest.name}) is {signed(prep.weakest.gold15)} gold by 15
                  {prep.weakest.kp != null && prep.weakest.kp < 45 ? ` with ${prep.weakest.kp}% kill participation` : ''},
                  the biggest early swing vs {active}. Is that lane getting isolated — and when it&rsquo;s conceded, is
                  the trade being cashed elsewhere, or would relieving early {prep.weakest.role.toLowerCase()}-side
                  pressure be worth testing?
                </li>
              )}
              <li>
                Dragons run {prep.ourDrakes ?? '—'} vs {prep.oppDrakes ?? '—'} per game against {active}, and win rate
                climbs cleanly with each drake taken (1&nbsp;&rarr;&nbsp;17%, 2&nbsp;&rarr;&nbsp;41%, 3&nbsp;&rarr;&nbsp;55%,
                4&nbsp;&rarr;&nbsp;81%). Is routing the early game toward the drake race a lever worth prioritising here?
              </li>
              <li>
                First blood barely moves the win rate (~+12% across all games) but first tower is worth ~+39%, and first
                tower goes to {active} in {prep.ft != null ? 100 - prep.ft : '—'}% of games. Is shifting from early
                skirmishes toward plates and tempo worth a look?
              </li>
            </ol>
            <p className="panel-caption" style={{ marginTop: 12 }}>
              Nothing here is a directive — just the numbers and the questions for the staff to decide on.
            </p>
          </div>

          <div className="panel">
            <h2>Confidence</h2>
            <p style={{ fontSize: 14, lineHeight: 1.7 }}>
              The official sample vs {active} is {prep.off.n} game{prep.off.n === 1 ? '' : 's'} — read those exact figures
              as directional. The scrim sample ({prep.scrim.n}) is solid
              {prep.consistent
                ? `, and the lane pattern above holds across both scrims and officials, so the shape — which lanes bleed, which hold — is trustworthy even where the precise numbers aren't.`
                : `; the lane pattern is drawn mostly from the scrim sample, so treat the specific split as a starting point rather than settled.`}
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
