import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import CsvPicker from './CsvPicker'
import LocationSearch from './LocationSearch'

// Used for both "Add plant" (plant = null) and "Edit plant" (plant = existing row).
// `onSubmit(values, csvFile)` must resolve to { error?: string, uploadError?: string }.
// The CSV (historical data) is optional and only offered when adding a new plant.
export default function PlantFormModal({ plant, onClose, onSubmit }) {
  const editing = Boolean(plant)
  const [form, setForm] = useState({
    name: plant?.name ?? '',
    location: plant?.location ?? '',
    capacity_mw: plant?.capacity_mw ?? '',
    grid_connected: plant?.grid_connected ?? true,
    status: plant?.status ?? 'online',
    tariff_inr_per_kwh: plant?.tariff_inr_per_kwh ?? '',
    cleaning_cost_inr_per_mw: plant?.cleaning_cost_inr_per_mw ?? 6000,
    cleaning_water_l_per_mw: plant?.cleaning_water_l_per_mw ?? 4000,
    battery_capacity_mwh: plant?.battery_capacity_mwh ?? 10,
    battery_power_mw: plant?.battery_power_mw ?? 5,
    latitude: plant?.latitude ?? '',
    longitude: plant?.longitude ?? '',
    timezone: plant?.timezone ?? 'Asia/Kolkata',
  })
  const [csvFile, setCsvFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (key) => (e) =>
    setForm((f) => ({ ...f, [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Close on Escape
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    if (!form.name.trim()) return setError('Plant name is required.')
    if (form.capacity_mw !== '' && Number(form.capacity_mw) < 0) return setError('Capacity cannot be negative.')
    if (form.tariff_inr_per_kwh !== '' && Number(form.tariff_inr_per_kwh) < 0) return setError('Tariff cannot be negative.')
    if (Number(form.cleaning_cost_inr_per_mw) < 0 || Number(form.cleaning_water_l_per_mw) < 0) return setError('Cleaning cost and water cannot be negative.')
    if (form.latitude !== '' && Math.abs(Number(form.latitude)) > 90) return setError('Latitude must be between -90 and 90.')
    if (form.longitude !== '' && Math.abs(Number(form.longitude)) > 180) return setError('Longitude must be between -180 and 180.')
    if ((form.latitude === '') !== (form.longitude === '')) return setError('Enter both latitude and longitude, or neither.')

    setBusy(true)
    const { error, uploadError } = await onSubmit(form, csvFile)
    setBusy(false)
    if (error) return setError(error)
    // The plant itself was created; only the CSV failed, so don't keep the form open (it would create a duplicate).
    if (uploadError) window.alert(`Plant created, but the CSV upload failed: ${uploadError}\n\nYou can retry from "Upload data".`)
    onClose()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="plant-modal-title" onSubmit={handleSubmit}>
        <div className="modal-head">
          <h2 id="plant-modal-title">{editing ? 'Edit plant' : 'Add a new plant'}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <label className="field">
          Plant name *
          <input value={form.name} onChange={set('name')} placeholder="e.g. Solar Plant 1" maxLength={80} autoFocus />
        </label>

        <div className="field">
          Location
          <LocationSearch
            value={form.location}
            onChange={(location) => setForm((f) => ({ ...f, location }))}
            onPick={(place) => setForm((f) => ({ ...f, ...place }))}
            disabled={busy}
          />
        </div>

        <div className="field-row">
          <label className="field">
            Latitude
            <input type="number" step="any" value={form.latitude} onChange={set('latitude')} placeholder="filled from location" />
          </label>
          <label className="field">
            Longitude
            <input type="number" step="any" value={form.longitude} onChange={set('longitude')} placeholder="filled from location" />
          </label>
        </div>

        <div className="field-row">
          <label className="field">
            Capacity (MW)
            <input type="number" min="0" step="0.01" value={form.capacity_mw} onChange={set('capacity_mw')} placeholder="0" />
          </label>
          <label className="field">
            Status
            <select value={form.status} onChange={set('status')}>
              <option value="online">Online</option>
              <option value="offline">Offline</option>
            </select>
          </label>
        </div>

        <label className="field">
          Tariff (₹ per kWh)
          <input type="number" min="0" step="0.01" value={form.tariff_inr_per_kwh} onChange={set('tariff_inr_per_kwh')} placeholder="e.g. 3.50" />
        </label>

        <div className="field-row">
          <label className="field">
            Cleaning cost (₹ per MW)
            <input type="number" min="0" step="100" value={form.cleaning_cost_inr_per_mw} onChange={set('cleaning_cost_inr_per_mw')} />
          </label>
          <label className="field">
            Cleaning water (L per MW)
            <input type="number" min="0" step="100" value={form.cleaning_water_l_per_mw} onChange={set('cleaning_water_l_per_mw')} />
          </label>
        </div>

        <small className="hint">
          Capacity is used for performance ratio, tariff for revenue, location for weather and forecasts, and the cleaning
          cost/water (defaults are rough estimates) to decide when cleaning pays off.
        </small>

        <div className="field-row">
          <label className="field">
            Battery what-if (MWh)
            <input type="number" min="0" step="0.5" value={form.battery_capacity_mwh} onChange={set('battery_capacity_mwh')} />
          </label>
          <label className="field">
            Battery power (MW)
            <input type="number" min="0" step="0.5" value={form.battery_power_mw} onChange={set('battery_power_mw')} />
          </label>
        </div>
        <small className="hint">Simulated battery used by AI Recommendations to show what storage would earn (0 = off).</small>

        <label className="check">
          <input type="checkbox" checked={form.grid_connected} onChange={set('grid_connected')} />
          Grid connected
        </label>

        {!editing && (
          <div className="field csv-section">
            Historical data <span className="optional">(optional)</span>
            <CsvPicker file={csvFile} onChange={setCsvFile} disabled={busy} />
            <small className="hint">
              Upload past performance data now, or skip this to create a brand-new plant and add data later.
            </small>
          </div>
        )}

        {error && <p className="msg error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? 'Saving…' : editing ? 'Save changes' : 'Add plant'}
          </button>
        </div>
      </form>
    </div>
  )
}