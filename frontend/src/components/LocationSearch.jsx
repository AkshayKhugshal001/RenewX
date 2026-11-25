import { useEffect, useRef, useState } from 'react'
import { MapPin, Search } from 'lucide-react'

// Place search (Open-Meteo geocoding: free, no API key).
// Typing a place shows matches; picking one fills latitude, longitude and timezone.
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'

const placeLabel = (p) => [p.name, p.admin1, p.country].filter(Boolean).join(', ')

export default function LocationSearch({ value, onChange, onPick, disabled }) {
  const [results, setResults] = useState([])
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState('') // '' | 'searching' | 'none' | 'error'
  const typed = useRef(false) // only search after the user types (not for an existing value)
  const boxRef = useRef(null)

  useEffect(() => {
    const query = value.split(',')[0].trim()
    if (!typed.current || query.length < 3) return undefined
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      setStatus('searching')
      try {
        const url = `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=6&language=en&format=json`
        const res = await fetch(url, { signal: controller.signal })
        const json = await res.json()
        const found = json.results ?? []
        setResults(found)
        setStatus(found.length ? '' : 'none')
        setOpen(true)
      } catch (e) {
        if (e.name !== 'AbortError') setStatus('error')
      }
    }, 400)
    return () => { clearTimeout(timer); controller.abort() }
  }, [value])

  useEffect(() => {
    if (!open) return undefined
    const close = (e) => !boxRef.current?.contains(e.target) && setOpen(false)
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  function pick(place) {
    typed.current = false
    setOpen(false)
    setResults([])
    onPick({
      location: placeLabel(place),
      latitude: Math.round(place.latitude * 10000) / 10000,
      longitude: Math.round(place.longitude * 10000) / 10000,
      timezone: place.timezone || 'Asia/Kolkata',
    })
  }

  return (
    <div className="loc-search" ref={boxRef}>
      <div className="loc-input">
        <Search size={16} />
        <input
          value={value}
          onChange={(e) => { typed.current = true; onChange(e.target.value) }}
          onFocus={() => results.length && setOpen(true)}
          placeholder="Search a city or town, e.g. Dehradun"
          maxLength={120}
          disabled={disabled}
          autoComplete="off"
        />
      </div>
      {status === 'searching' && <small className="hint">Searching…</small>}
      {status === 'none' && <small className="hint">No places found. You can still enter coordinates below.</small>}
      {status === 'error' && <small className="hint">Place search is unavailable. Enter coordinates below.</small>}
      {open && results.length > 0 && (
        <ul className="loc-results" role="listbox">
          {results.map((p) => (
            <li key={p.id}>
              <button type="button" onClick={() => pick(p)}>
                <MapPin size={15} />
                <span>
                  <strong>{p.name}</strong>
                  <small>{[p.admin1, p.country].filter(Boolean).join(', ')} · {p.latitude.toFixed(3)}°, {p.longitude.toFixed(3)}°</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
