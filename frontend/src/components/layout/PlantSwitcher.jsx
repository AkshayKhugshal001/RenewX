import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Factory, ChevronDown, Check, Plus, Settings2 } from 'lucide-react'
import { usePlants } from '../../context/PlantContext'

// Always-visible plant switcher that lives in the top bar
export default function PlantSwitcher() {
  const { plants, activePlant, loading, selectPlant, openAddPlant } = usePlants()
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  // Close on outside click / Escape
  useEffect(() => {
    if (!open) return
    const onDown = (e) => !ref.current?.contains(e.target) && setOpen(false)
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  if (loading) return null

  // No plants yet: show a single clear call-to-action
  if (plants.length === 0) {
    return (
      <button className="plant-menu-btn cta" onClick={openAddPlant}>
        <Plus size={16} /> <span>Add plant</span>
      </button>
    )
  }

  return (
    <div className="plant-menu" ref={ref}>
      <button
        className="plant-menu-btn"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch plant"
      >
        <Factory size={16} />
        <span>{activePlant?.name ?? 'Select plant'}</span>
        <ChevronDown size={16} />
      </button>

      {open && (
        <div className="plant-menu-list" role="listbox" aria-label="Your plants">
          <small className="plant-menu-title">Your plants ({plants.length})</small>
          {plants.map((p) => (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === activePlant?.id}
              className={`plant-menu-item${p.id === activePlant?.id ? ' on' : ''}`}
              onClick={() => { selectPlant(p.id); setOpen(false) }}
            >
              <i className={`dot ${p.status === 'online' ? 'on' : 'off'}`} />
              <span>
                {p.name}
                {p.location && <small>{p.location}</small>}
              </span>
              {p.id === activePlant?.id && <Check size={16} />}
            </button>
          ))}

          <div className="plant-menu-foot">
            <button onClick={() => { setOpen(false); openAddPlant() }}>
              <Plus size={16} /> Add new plant
            </button>
            <Link to="/settings" onClick={() => setOpen(false)}>
              <Settings2 size={16} /> Manage plants
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}