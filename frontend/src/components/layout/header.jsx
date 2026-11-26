import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Search, ShieldAlert, ChevronDown, LogOut } from 'lucide-react'
import { supabase } from '../../lib/supabaseClient'
import { usePlants } from '../../context/PlantContext'
import { useAuth } from '../../context/AuthContext'
import PlantSwitcher from './PlantSwitcher'

/** Open anomalies of the active plant (refreshed after uploads/actions and every minute). */
function AlarmButton() {
  const { activePlant, dataVersion } = usePlants()
  const plantId = activePlant?.id
  const [count, setCount] = useState({ plantId: null, n: 0 })
  useEffect(() => {
    if (!plantId) return
    let cancelled = false
    const load = () => supabase.from('anomalies').select('id', { count: 'exact', head: true })
      .eq('plant_id', plantId).eq('status', 'open')
      .then(({ count: n }) => !cancelled && setCount({ plantId, n: n ?? 0 }))
    load()
    const t = setInterval(load, 60000)
    return () => { cancelled = true; clearInterval(t) }
  }, [plantId, dataVersion])
  const n = count.plantId === plantId ? count.n : 0
  const label = n ? `${n} open alarm${n > 1 ? 's' : ''} – open Anomalies` : 'No open alarms – open Anomalies'
  return (
    <Link to="/maintenance" className="icon-btn alarm-btn" aria-label={label} title={label}>
      <ShieldAlert size={22} />
      {n > 0 && <span className="alarm-count">{n > 99 ? '99+' : n}</span>}
    </Link>
  )
}

export default function Header() {
  const { user, profile, signOut } = useAuth()
  const [open, setOpen] = useState(false)

  const name = profile?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User'
  const role = profile?.role || 'Plant Manager'

  return (
    <header className="topbar">
      <label className="search">
        <Search size={18} />
        <input placeholder="Search for data, insights, or actions..." />
      </label>

      <PlantSwitcher />

      <AlarmButton />

      <div className="user-menu">
        <button className="user" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="avatar">{name[0].toUpperCase()}</span>
          <span className="user-text">
            <strong>{name}</strong>
            <small>{role}</small>
          </span>
          <ChevronDown size={16} />
        </button>
        {open && (
          <div className="dropdown">
            <small>{user?.email}</small>
            <button onClick={signOut}>
              <LogOut size={16} /> Log out
            </button>
          </div>
        )}
      </div>
    </header>
  )
}