import { useEffect, useState, useCallback } from 'react'

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
