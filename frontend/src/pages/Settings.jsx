import { useState } from 'react'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import { usePlants } from '../context/PlantContext'

export default function Settings() {
  const { plants, activePlant, loading, selectPlant, openAddPlant, openEditPlant, deletePlant } = usePlants()
  const [error, setError] = useState('')
  const [deletingId, setDeletingId] = useState(null)

  async function handleDelete(plant) {
    const ok = window.confirm(
      `Delete "${plant.name}"?\n\nThis permanently removes the plant and any data linked to it. This cannot be undone.`,
    )
    if (!ok) return
    setError('')
    setDeletingId(plant.id)
    const { error } = await deletePlant(plant.id)
    setDeletingId(null)
    if (error) setError(error)
  }

  return (
    <div className="settings">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>My Plants</h2>
            <p className="muted-text">Add, edit or remove the plants linked to your account.</p>
          </div>
          <button className="btn primary" onClick={openAddPlant}>
            <Plus size={16} /> Add plant
          </button>
        </div>

        {error && <p className="msg error">{error}</p>}

        {loading ? (
          <p className="empty">Loading plants…</p>
        ) : plants.length === 0 ? (
          <p className="empty">You haven&apos;t added any plants yet.</p>
        ) : (
          <ul className="plant-list">
            {plants.map((p) => {
              const isActive = p.id === activePlant?.id
              return (
                <li key={p.id} className={`plant-row${isActive ? ' active' : ''}`}>
                  <div className="plant-row-main">
                    <strong>
                      {p.name} {isActive && <span className="badge">Active</span>}
                    </strong>
                    <small>
                      {p.location || 'No location'} · {p.capacity_mw ?? 0} MW ·{' '}
                      {p.grid_connected ? 'Grid connected' : 'Off-grid'} ·{' '}
                      {p.status === 'online' ? 'Online' : 'Offline'}
                    </small>
                  </div>
                  <div className="plant-row-actions">
                    {!isActive && (
                      <button className="btn sm" onClick={() => selectPlant(p.id)}>Switch to</button>
                    )}
                    <button className="btn sm" onClick={() => openEditPlant(p)}>
                      <Pencil size={14} /> Edit
                    </button>
                    <button
                      className="btn sm danger"
                      onClick={() => handleDelete(p)}
                      disabled={deletingId === p.id}
                      aria-label={`Delete ${p.name}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}