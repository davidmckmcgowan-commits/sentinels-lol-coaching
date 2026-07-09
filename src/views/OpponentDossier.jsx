import { useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'

function WinLoss({ wins, losses }) {
  if (wins == null && losses == null) return <span className="section-note">Record not tracked separately</span>
  const w = wins ?? 0
  const l = losses ?? 0
  return (
    <span className="wl-pill">
      <span className="wl-win">{w}W</span>-<span className="wl-loss">{l}L</span>
    </span>
  )
}

export default function OpponentDossier() {
  const [search, setSearch] = useState('')
  const [selectedCode, setSelectedCode] = useState(null)

  const { data: opponents, error: oppError, loading: oppLoading } = useSupabaseQuery(
    () => supabase.from('opponents').select('*').order('tier', { ascending: false }),
    []
  )

  const { data: sessionsForOpponent, error: sessError, loading: sessLoading } = useSupabaseQuery(
    () => {
      if (!selectedCode) {
        // no-op query shape to keep hook happy when nothing selected
        return supabase.from('opponent_sessions').select('*').eq('opponent_code', '__none__')
      }
      return supabase
        .from('opponent_sessions')
        .select('*')
        .eq('opponent_code', selectedCode)
        .order('session_date', { ascending: true })
    },
    [selectedCode]
  )

  const filteredOpponents = useMemo(() => {
    if (!opponents) return []
    const q = search.trim().toLowerCase()
    if (!q) return opponents
    return opponents.filter(
      (o) => o.team_name?.toLowerCase().includes(q) || o.code?.toLowerCase().includes(q)
    )
  }, [opponents, search])

  const grouped = useMemo(() => {
    if (!sessionsForOpponent) return []
    const map = new Map()
    for (const row of sessionsForOpponent) {
      const key = row.session_date || 'Unknown date'
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(row)
    }
    return Array.from(map.entries())
  }, [sessionsForOpponent])

  const selectedOpponent = opponents?.find((o) => o.code === selectedCode)

  return (
    <div>
      {!selectedCode && (
        <div className="panel">
          <h2>Opponent Dossier</h2>
          <p className="panel-caption">
            Click into an opponent to see key notes, bans, and the full per-game intel log.
          </p>
          <div className="filter-row">
            <div className="filter-field">
              <label>Search opponents</label>
              <input
                type="text"
                className="search-input"
                placeholder="Team name or code…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>

          {oppLoading && <div className="loading-state">Loading opponents…</div>}
          {oppError && <div className="toast error">Error loading opponents: {oppError.message}</div>}

          {!oppLoading && !oppError && (
            <div className="opponent-grid">
              {filteredOpponents.map((o) => (
                <div
                  key={o.code}
                  className="opponent-card"
                  onClick={() => setSelectedCode(o.code)}
                >
                  <div className="opp-name">
                    {o.team_name} <span className={`tier-chip tier-${o.tier}`} style={{ marginLeft: 6 }}>{o.tier}</span>
                  </div>
                  <div className="opp-record">
                    <WinLoss wins={o.overall_wins} losses={o.overall_losses} />
                  </div>
                </div>
              ))}
              {filteredOpponents.length === 0 && (
                <div className="empty-state">No opponents match "{search}".</div>
              )}
            </div>
          )}
        </div>
      )}

      {selectedCode && selectedOpponent && (
        <div className="panel">
          <button type="button" className="back-link" onClick={() => setSelectedCode(null)}>
            ← Back to all opponents
          </button>
          <h2>
            {selectedOpponent.team_name}{' '}
            <span className={`tier-chip tier-${selectedOpponent.tier}`} style={{ marginLeft: 6 }}>
              {selectedOpponent.tier}
            </span>
          </h2>
          <p className="panel-caption">
            Overall record: <WinLoss wins={selectedOpponent.overall_wins} losses={selectedOpponent.overall_losses} />
          </p>

          {selectedOpponent.key_notes && (
            <div className="notes-block">
              <b style={{ color: 'var(--text)' }}>Key notes:</b> {selectedOpponent.key_notes}
            </div>
          )}
          {selectedOpponent.bans && (
            <div className="notes-block">
              <b style={{ color: 'var(--text)' }}>Bans:</b> {selectedOpponent.bans}
            </div>
          )}

          <h3 style={{ marginTop: 20 }}>Per-Game Intel Log</h3>
          {sessLoading && <div className="loading-state">Loading session log…</div>}
          {sessError && <div className="toast error">Error loading sessions: {sessError.message}</div>}

          {!sessLoading && !sessError && grouped.length === 0 && (
            <div className="empty-state">No per-game intel logged for this opponent yet.</div>
          )}

          {!sessLoading && !sessError && grouped.map(([date, games]) => (
            <div className="session-group" key={date}>
              <div className="session-group-header">{date}</div>
              {games.map((g) => (
                <div className="game-row" key={g.id}>
                  <div className="game-label">{g.game_label}</div>
                  <div>
                    <div className="col-label">Why they won</div>
                    {g.why_they_won || '—'}
                  </div>
                  <div>
                    <div className="col-label">Why we won</div>
                    {g.why_we_won || '—'}
                  </div>
                  <div>
                    <div className="col-label">Takeaway</div>
                    {g.takeaway || '—'}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
