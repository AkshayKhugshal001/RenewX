import { NavLink } from 'react-router-dom'
import {
  Sun, LayoutDashboard, Factory, TrendingUp, Sparkles,
  Snowflake, Wrench, Leaf, FileText, Settings, ChevronDown, Plus,
} from 'lucide-react'
import { usePlants } from '../../context/PlantContext'

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/plant-overview', label: 'Plant Overview', icon: Factory },
  { to: '/forecasting', label: 'Forecasting', icon: TrendingUp },
  { to: '/recommendations', label: 'AI Recommendations', icon: Sparkles },
  { to: '/cleaning-cooling', label: 'Cleaning & Cooling', icon: Snowflake },
  { to: '/maintenance', label: 'Maintenance', icon: Wrench },
  { to: '/environment', label: 'Environment', icon: Leaf },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/settings', label: 'Settings', icon: Settings },
]

export default function Sidebar() {
  const { plants, activePlant: plant, selectPlant, openAddPlant } = usePlants()

  return (
    <aside className="sidebar">
      <div className="brand">
        <Sun size={38} strokeWidth={1.75} className="brand-icon" />
        <div>
          <strong>RenewX</strong>
          <span>Predict · Diagnose · Optimize</span>
        </div>
      </div>

      <nav>
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
            <Icon size={20} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="plant-card">
        <div className="plant-photo" aria-hidden="true" />
        {plant ? (
          <>
            <strong>{plant.name}</strong>
            {plant.location && <span>{plant.location}</span>}
            <span>
              {plant.capacity_mw ?? 0} MW | {plant.grid_connected ? 'Grid Connected' : 'Off-grid'}
            </span>
            <span className="status">
              <i className={`dot ${plant.status === 'online' ? 'on' : 'off'}`} />
              {plant.status === 'online' ? 'Online' : 'Offline'}
            </span>
          </>
        ) : (
          <>
            <strong>No plant added</strong>
            <span>Add a plant to start</span>
          </>
        )}

        {plants.length > 0 && (
          <div className="switch">
            <select
              value={plant?.id ?? ''}
              onChange={(e) => selectPlant(e.target.value)}
              aria-label="Switch plant"
            >
              {plants.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        )}

        <button className="add-plant" onClick={openAddPlant}>
          <Plus size={16} /> Add plant
        </button>
      </div>
    </aside>
  )
}