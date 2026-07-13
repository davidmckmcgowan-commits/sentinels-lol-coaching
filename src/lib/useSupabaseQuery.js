import { useEffect, useState, useCallback } from 'react'

// PostgREST (Supabase's REST layer) caps any single request at 1000 rows by
// default (db-max-rows) — a plain `.select()` with no `.range()` silently
// TRUNCATES rather than erroring, so a growing table quietly starts losing
// data with no error anywhere. Bit us for real on 2026-07-13: grid_player_games
// grew past 11,400 rows once daily GRID sync came online, and the truncated
// (arbitrary-order) 1000-row slice happened to contain almost no Official
// (ESPORTS) games for most players — the dashboard reported "n=0 Official
// games" even though the DB had plenty. Use this helper for any query against
// a table that can plausibly exceed 1000 rows (grid_player_games today; watch
// daily_entries/nightly_sleep/sessions as the season goes on).
export async function fetchAllRows(buildQuery, pageSize = 1000) {
  let allRows = []
  let from = 0
  while (true) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) return { data: null, error }
    if (data) allRows = allRows.concat(data)
    if (!data || data.length < pageSize) break
    from += pageSize
  }
  return { data: allRows, error: null }
}

// Generic hook to run a Supabase query builder function and expose data/loading/error.
// `queryFn` receives the supabase client and must return a PostgREST query builder
// (i.e. something with .then, produced by supabase.from(...).select(...) etc.)
export function useSupabaseQuery(queryFn, deps = []) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(true)

  const run = useCallback(() => {
    let active = true
    setLoading(true)
    setError(null)
    queryFn()
      .then(({ data, error }) => {
        if (!active) return
        if (error) {
          setError(error)
          setData(null)
        } else {
          setData(data)
        }
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        setError(err)
        setLoading(false)
      })
    return () => {
      active = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  useEffect(() => {
    const cleanup = run()
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run])

  return { data, error, loading, refetch: run }
}
