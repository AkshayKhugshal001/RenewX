import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Pencil, Trash2, Upload, Factory, Palette, UserRound, Sun, Moon, Monitor, LogOut, KeyRound, Check } from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { useAuth } from '../context/AuthContext'
import { getThemeChoice, setThemeChoice } from '../lib/theme'

const SECTIONS = [
  { id: 'plants', label: 'Plants', icon: Factory },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'account', label: 'Account', icon: UserRound },
]

function PlantsSection() {
  const { plants, activePlant, loading, selectPlant, openAddPlant, openEditPlant, openUploadData, deletePlant } = usePlants()
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
                  <button className="btn sm" onClick={() => openUploadData(p)}>
                    <Upload size={14} /> Upload data
                  </button>
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
  )
}

const THEME_OPTIONS = [
  { id: 'light', label: 'Light', icon: Sun, note: 'Bright background' },
  { id: 'dark', label: 'Dark', icon: Moon, note: 'Easier on the eyes at night' },
  { id: 'system', label: 'System', icon: Monitor, note: 'Follow the device setting' },
]

function AppearanceSection() {
  const [theme, setTheme] = useState(getThemeChoice)
  function choose(id) {
    setTheme(id)
    setThemeChoice(id)
  }
  return (
    <div className="card">
      <h2>Appearance</h2>
      <p className="muted-text">Choose how RenewX looks on this device.</p>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {THEME_OPTIONS.map(({ id, label, icon: Icon, note }) => (
          <button key={id} role="radio" aria-checked={theme === id} className={`theme-option ${theme === id ? 'on' : ''}`}
            onClick={() => choose(id)}>
            <span className={`theme-preview ${id}`}><i /><i /><i /></span>
            <span className="theme-label"><Icon size={16} /> {label} {theme === id && <Check size={15} className="c-green" />}</span>
            <small>{note}</small>
          </button>
        ))}
      </div>
    </div>
  )
}

function AccountSection() {
  const { user, profile, updateName, changePassword, signOut } = useAuth()
  const [name, setName] = useState(profile?.full_name || user?.user_metadata?.full_name || '')
  const [pw, setPw] = useState({ password: '', confirm: '' })
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState({ text: '', error: false, for: '' })

  async function saveName(e) {
    e.preventDefault()
    if (!name.trim()) return setMsg({ text: 'Enter a name.', error: true, for: 'name' })
    setBusy('name')
    const r = await updateName(name)
    setBusy('')
    setMsg(r.error ? { text: r.error, error: true, for: 'name' } : { text: 'Name saved.', error: false, for: 'name' })
  }

  async function savePassword(e) {
    e.preventDefault()
    if (pw.password.length < 8) return setMsg({ text: 'Use at least 8 characters.', error: true, for: 'pw' })
    if (pw.password !== pw.confirm) return setMsg({ text: 'The passwords do not match.', error: true, for: 'pw' })
    setBusy('pw')
    const r = await changePassword(pw.password)
    setBusy('')
    if (r.error) return setMsg({ text: r.error, error: true, for: 'pw' })
    setPw({ password: '', confirm: '' })
    setMsg({ text: 'Password changed.', error: false, for: 'pw' })
  }

  const note = (k) => msg.for === k && msg.text && <p className={`msg ${msg.error ? 'error' : 'ok'}`}>{msg.text}</p>
  return (
    <div className="account-grid">
      <form className="card account-card" onSubmit={saveName}>
        <h2>Profile</h2>
        <label className="field">Email
          <input value={user?.email ?? ''} disabled />
        </label>
        <label className="field">Display name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={busy === 'name'} />
        </label>
        {note('name')}
        <button className="btn primary" disabled={busy === 'name'}>{busy === 'name' ? 'Saving…' : 'Save name'}</button>
      </form>

      <form className="card account-card" onSubmit={savePassword}>
        <h2><KeyRound size={18} /> Change password</h2>
        <label className="field">New password
          <input type="password" autoComplete="new-password" value={pw.password} onChange={(e) => setPw((p) => ({ ...p, password: e.target.value }))} disabled={busy === 'pw'} />
        </label>
        <label className="field">Repeat new password
          <input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw((p) => ({ ...p, confirm: e.target.value }))} disabled={busy === 'pw'} />
        </label>
        {note('pw')}
        <button className="btn primary" disabled={busy === 'pw'}>{busy === 'pw' ? 'Saving…' : 'Change password'}</button>
      </form>

      <div className="card account-card">
        <h2>Session</h2>
        <p className="muted-text">Signed in as {user?.email}. Signing out ends the session on this device.</p>
        <button className="btn danger" onClick={() => signOut()}><LogOut size={15} /> Sign out</button>
      </div>
    </div>
  )
}

export default function Settings() {
  const [params, setParams] = useSearchParams()
  const section = SECTIONS.some((s) => s.id === params.get('section')) ? params.get('section') : 'plants'

  return (
    <div className="settings">
      <div className="tabs page-tabs settings-tabs" role="tablist">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={section === id} className={section === id ? 'on' : ''}
            onClick={() => setParams(id === 'plants' ? {} : { section: id })}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      {section === 'plants' && <PlantsSection />}
      {section === 'appearance' && <AppearanceSection />}
      {section === 'account' && <AccountSection />}
    </div>
  )
}
