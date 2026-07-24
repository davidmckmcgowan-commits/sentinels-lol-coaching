import { useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { useSupabaseQuery } from '../lib/useSupabaseQuery.js'

// Browser-local "today" as YYYY-MM-DD (so the default date is the coach's day,
// not UTC — which at NA evening would roll to tomorrow).
function todayLocal() {
  const d = new Date()
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 10)
}

const BROWSER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Los_Angeles'

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch {
    return ts
  }
}

export default function DailySync() {
  const [date, setDate] = useState(todayLocal())
  const [force, setForce] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [errMsg, setErrMsg] = useState(null)

  const { data: runs, loading: runsLoading, refetch } = useSupabaseQuery(
    () => supabase.from('sync_runs').select('*').order('started_at', { ascending: false }).limit(12),
    []
  )

  async function runSync() {
    setRunning(true)
    setResult(null)
    setErrMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('daily-sync', {
        body: { date, tz: BROWSER_TZ, triggeredBy: 'app-button', force },
      })
      if (error) {
        // Surface the server-recorded reason from the run log if we can.
        let detail = error.message
        try {
          const ctx = await error.context?.json?.()
          if (ctx?.error) detail = ctx.error
        } catch { /* ignore */ }
        setErrMsg(detail || 'Sync failed')
      } else if (data && data.ok === false) {
        setErrMsg(data.error || 'Sync failed')
      } else {
        setResult(data)
      }
    } catch (e) {
      setErrMsg(e?.message || 'Sync failed')
    } finally {
      setRunning(false)
      refetch()
    }
  }

  const btnStyle = {
    padding: '11px 20px',
    borderRadius: 8,
    border: 'none',
    fontWeight: 600,
    fontSize: 14,
    cursor: running ? 'not-allowed' : 'pointer',
    background: running ? '#5b5b5b' : '#e01e37',
    color: '#fff',
    opacity: running ? 0.7 : 1,
  }

  return (
    <div>
      <div className="panel">
        <h2>Daily Sync</h2>
        <p className="panel-caption">
          Pull a single practice day&apos;s games straight from GRID — pull, import, enrich (CS, @15,
          damage, vision, objectives) and correct positions, all in one step. Runs on the server; the
          GRID key never leaves it. Re-running a date is safe.
        </p>

        <div className="filter-row" style={{ alignItems: 'flex-end', gap: 16 }}>
          <div className="filter-field">
            <label>Practice date</label>
            <input
              type="date"
              className="search-input"
              value={date}
              max={todayLocal()}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="filter-field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Re-enrich if already synced
            </label>
          </div>
          <button type="button" style={btnStyle} disabled={running} onClick={runSync}>
            {running ? 'Syncing…' : 'Pull this day’s games'}
          </button>
        </div>

        {running && (
          <div className="loading-state" style={{ marginTop: 14 }}>
            Pulling {date} from GRID and enriching… this can take up to a minute.
          </div>
        )}

        {errMsg && (
          <div className="toast error" style={{ marginTop: 14 }}>
            Sync failed: {errMsg}
          </div>
        )}

        {result && (
          <div className="notes-block" style={{ marginTop: 14 }}>
            <b style={{ color: 'var(--text)' }}>Done — {result.date}:</b>{' '}
            {result.seriesSeen} series, {result.gamesImported} games imported, {result.gamesEnriched} enriched.
            {result.seriesSeen === 0 && ' (No finished series found on that date.)'}
          </div>
        )}
      </div>

      <div className="panel">
        <h3>Recent syncs</h3>
        <p className="panel-caption">The last dozen sync runs, newest first.</p>
        {runsLoading && <div className="loading-state">Loading run history…</div>}
        {!runsLoading && (!runs || runs.length === 0) && (
          <div className="empty-state">No syncs recorded yet.</div>
        )}
        {!runsLoading && runs && runs.length > 0 && (
          <table className="data-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-faint)', fontSize: 12 }}>
                <th style={{ padding: '6px 10px' }}>Date</th>
                <th style={{ padding: '6px 10px' }}>Status</th>
                <th style={{ padding: '6px 10px' }}>Series</th>
                <th style={{ padding: '6px 10px' }}>Imported</th>
                <th style={{ padding: '6px 10px' }}>Enriched</th>
                <th style={{ padding: '6px 10px' }}>When</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border, #333)', fontSize: 13 }}>
                  <td style={{ padding: '6px 10px' }}>{r.run_date}</td>
                  <td style={{ padding: '6px 10px' }}>
                    <span style={{ color: r.status === 'success' ? '#3fb950' : r.status === 'error' ? '#e5534b' : 'var(--text-faint)' }}>
                      {r.status}
                    </span>
                  </td>
                  <td style={{ padding: '6px 10px' }}>{r.series_seen ?? '—'}</td>
                  <td style={{ padding: '6px 10px' }}>{r.games_imported ?? '—'}</td>
                  <td style={{ padding: '6px 10px' }}>{r.games_enriched ?? '—'}</td>
                  <td style={{ padding: '6px 10px', color: 'var(--text-faint)' }}>{fmtTime(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
