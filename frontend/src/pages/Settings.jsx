import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import QRCode from 'qrcode'
import {
  Plus, Pencil, Trash2, Upload, Factory, Palette, UserRound, Sun, Moon, Monitor, LogOut, KeyRound, Check,
  Radio, Smartphone, Copy,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { useAuth } from '../context/AuthContext'
import { getThemeChoice, setThemeChoice } from '../lib/theme'
import { agoText, createDevice, deviceUrl, isLocalhost, listDevices, revokeDevice } from '../lib/liveFeed'

const SECTIONS = [
  { id: 'plants', label: 'Plants', icon: Factory },
  { id: 'data', label: 'Data input', icon: Radio },
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

function NewDeviceQr({ device, onDone }) {
  const url = deviceUrl(device.key)
  const [qr, setQr] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    QRCode.toDataURL(url, { width: 240, margin: 1 }).then(setQr).catch(() => setQr(''))
  }, [url])
  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true) } catch { window.prompt('Copy this link:', url) }
  }
  return (
    <div className="new-device">
      {qr ? <img src={qr} alt="QR code that opens the device page on a phone" width={240} height={240} /> : <p className="empty">Creating QR code…</p>}
      <div>
        <h3>Scan with the phone</h3>
        <p className="muted-text">
          The QR code opens the RenewX device page with this key. <b>It is shown only once</b> – RenewX stores only a
          fingerprint (hash) of the key. If you lose it, create a new device.
        </p>
        {isLocalhost() && (
          <p className="msg error">
            This link points to localhost, which a phone cannot open. Use the deployed site, or run
            <code> npm run dev -- --host</code>, open the app via your PC&apos;s network IP and set VITE_API_URL to that IP.
          </p>
        )}
        <div className="device-actions">
          <button className="btn sm" onClick={copy}><Copy size={14} /> {copied ? 'Copied' : 'Copy link'}</button>
          <button className="btn sm primary" onClick={onDone}>Done</button>
        </div>
      </div>
    </div>
  )
}

function DataInputSection() {
  const { activePlant: plant, setDataMode } = usePlants()
  const [devices, setDevices] = useState([])
  const [name, setName] = useState('Phone device')
  const [created, setCreated] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!plant?.id) return
    let cancelled = false
    listDevices(plant.id).then(({ data, error }) => {
      if (cancelled) return
      setDevices(data)
      setError(error ? 'Could not load devices – has 010_live_feed.sql been run?' : '')
    })
    return () => { cancelled = true }
  }, [plant?.id, version])

  if (!plant) return <div className="card"><p className="empty">Add a plant first.</p></div>
  const live = plant.data_mode === 'live'

  async function chooseMode(mode) {
    if (mode === plant.data_mode) return
    setBusy('mode')
    const r = await setDataMode(plant.id, mode)
    setBusy('')
    setError(r.error ? (plant.data_mode === undefined ? 'Run 010_live_feed.sql in Supabase first.' : r.error) : '')
  }
  async function create(e) {
    e.preventDefault()
    setBusy('create')
    const r = await createDevice(plant.id, name.trim() || 'Phone device')
    setBusy('')
    if (r.error) return setError(r.error)
    setError('')
    setCreated(r.result)
    setVersion((v) => v + 1)
  }
  async function revoke(d) {
    if (!window.confirm(`Revoke “${d.name}”? It will no longer be able to send data.`)) return
    const r = await revokeDevice(d.id)
    if (r.error) return setError(r.error)
    setVersion((v) => v + 1)
  }

  return (
    <div className="settings-stack">
      <div className="card">
        <h2>Data input · {plant.name}</h2>
        <p className="muted-text">How readings reach RenewX for this plant. Switch plants in the sidebar.</p>
        <div className="seg mode-seg" role="radiogroup" aria-label="Data input mode">
          <button role="radio" aria-checked={!live} className={!live ? 'on' : ''} disabled={busy === 'mode'} onClick={() => chooseMode('manual')}>
            <Upload size={15} /> Manual (CSV)
          </button>
          <button role="radio" aria-checked={live} className={live ? 'on' : ''} disabled={busy === 'mode'} onClick={() => chooseMode('live')}>
            <Radio size={15} /> Live feed
          </button>
        </div>
        <p className="muted-text">
          {live
            ? 'Devices send readings every few seconds; today’s statistics and rule alarms update immediately. Forecasts, ML anomalies and recommendations update at the daily refresh. CSV uploads still work.'
            : 'You upload CSV files (history or daily). Devices are not accepted.'}
        </p>
        {error && <p className="msg error">{error}</p>}
      </div>

      {live && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2><Smartphone size={18} /> Devices</h2>
              <p className="muted-text">
                For the demo a phone acts as the plant&apos;s data logger (simulated values on real weather). A real
                ESP32 or inverter logger could use the same key and API.
              </p>
            </div>
          </div>

          {created ? (
            <NewDeviceQr device={created} onDone={() => setCreated(null)} />
          ) : (
            <form className="field-row device-create" onSubmit={create}>
              <label className="field">Device name
                <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} disabled={busy === 'create'} />
              </label>
              <button className="btn primary" disabled={busy === 'create'}>
                <Plus size={16} /> {busy === 'create' ? 'Creating…' : 'Create device + QR'}
              </button>
            </form>
          )}

          {devices.length === 0 ? (
            <p className="empty">No devices yet.</p>
          ) : (
            <ul className="plant-list">
              {devices.map((d) => (
                <li key={d.id} className="plant-row">
                  <div className="plant-row-main">
                    <strong>{d.name} {d.revoked_at && <span className="status-tag">revoked</span>}</strong>
                    <small>
                      Key {d.key_prefix}… · last data {agoText(d.last_seen_at)} · {Number(d.readings_sent).toLocaleString('en-IN')} readings
                    </small>
                  </div>
                  {!d.revoked_at && (
                    <div className="plant-row-actions">
                      <button className="btn sm danger" onClick={() => revoke(d)}>Revoke</button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
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
      {section === 'data' && <DataInputSection />}
      {section === 'appearance' && <AppearanceSection />}
      {section === 'account' && <AccountSection />}
    </div>
  )
}
