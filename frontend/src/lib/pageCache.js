// In-memory "stale-while-revalidate" cache for page data (no library).
// Going back to a page shows its last data for that plant INSTANTLY, then refreshes it in the background.
//   key      = page name + plant id
//   version  = anything that means "the data changed" (dataVersion after uploads/actions, live readings …)
// Data younger than FRESH_MS with the same version is not fetched again. Cleared on sign-out.
import { useEffect, useReducer } from 'react'

const FRESH_MS = 30_000
const cache = new Map() // key -> { data, error, version, at, seq }
let seq = 0

export function clearPageCache() {
  cache.clear()
}

/**
 * @param {string} name     page name, e.g. 'overview'
 * @param {object} plant    active plant (null = nothing to load)
 * @param {any} version     changes when the data must be reloaded
 * @param {(plant) => Promise<any>} fetcher
 * @returns {{ data: any, error: string, loading: boolean, stale: boolean }}
 *   loading = nothing to show yet (first visit); stale = showing older data while refreshing
 */
export function usePageData(name, plant, version, fetcher) {
  const key = plant?.id ? `${name}:${plant.id}` : null
  const [, rerender] = useReducer((x) => x + 1, 0)

  useEffect(() => {
    if (!key) return
    const hit = cache.get(key)
    if (hit && hit.version === version && !hit.error && Date.now() - hit.at < FRESH_MS) return
    const mine = ++seq
    cache.set(key, { ...(hit ?? { data: undefined, error: '' }), seq: mine })
    fetcher(plant)
      .then((data) => ({ data, error: '' }))
      .catch((e) => ({ data: cache.get(key)?.data, error: e?.message || 'Could not load the data.' }))
      .then((res) => {
        if (cache.get(key)?.seq !== mine) return // a newer request for this page + plant has started
        cache.set(key, { ...res, version, at: Date.now(), seq: mine })
        rerender()
      })
    // fetcher is a module-level function; plant fields (timezone …) are covered by `plant`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version, plant])

  const entry = key ? cache.get(key) : undefined
  const hasData = entry?.data !== undefined
  return {
    data: hasData ? entry.data : null,
    error: entry?.version === version ? entry.error : '',
    loading: Boolean(key) && !hasData && !entry?.error,
    stale: hasData && entry.version !== version,
  }
}
