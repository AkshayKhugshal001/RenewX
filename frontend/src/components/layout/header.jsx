import { useState } from 'react'
import { Search, Bell, ChevronDown, LogOut } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'

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

      <button className="icon-btn" aria-label="Notifications">
        <Bell size={22} />
      </button>

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
