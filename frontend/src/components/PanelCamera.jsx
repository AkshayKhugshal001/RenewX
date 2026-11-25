import { useEffect, useState } from 'react'
import { Camera, ImagePlus, Images, Trash2, X } from 'lucide-react'
import { addPhoto, deletePhoto, fetchPhotos, importSamples } from '../lib/panelPhotos'
import { analyseCleaning } from '../lib/api'
import { todayIso } from '../lib/maintenanceData'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10)

function AddPhotoModal({ plantId, references, defaultDate, onClose, onSaved }) {
  const [file, setFile] = useState(null)
  const [kind, setKind] = useState(references.length ? 'inspection' : 'reference')
  const [date, setDate] = useState(defaultDate)
  const [refId, setRefId] = useState(references[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function submit(e) {
    e.preventDefault()
    if (!file) return setError('Choose a photo.')
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return setError('Use a JPG, PNG or WebP photo.')
    if (file.size > 6 * 1024 * 1024) return setError('Photo is too large (max 6 MB).')
    setBusy(true)
    setError('')
    const res = await addPhoto(plantId, {
      file, kind, takenOn: date, reference: references.find((r) => r.id === refId), label: file.name.replace(/\.[^.]+$/, ''),
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved(res.data)
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label="Add panel photo" onSubmit={submit}>
        <div className="modal-head">
          <h2>Add panel photo</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={20} /></button>
        </div>
        <p className="muted-text">Simulates a capture of the plant camera. Use the same view as the reference for the best comparison.</p>
        <div className="seg" role="radiogroup" aria-label="Photo type">
          <button type="button" role="radio" aria-checked={kind === 'inspection'} className={kind === 'inspection' ? 'on' : ''}
            onClick={() => setKind('inspection')} disabled={busy || !references.length}>Camera capture</button>
          <button type="button" role="radio" aria-checked={kind === 'reference'} className={kind === 'reference' ? 'on' : ''}
            onClick={() => setKind('reference')} disabled={busy}>Clean reference</button>
        </div>
        <label className="field">Photo
          <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={busy} />
        </label>
        <div className="field-row">
          <label className="field">Taken on
            <input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} disabled={busy} />
          </label>
          {kind === 'inspection' && (
            <label className="field">Compare with
              <select value={refId} onChange={(e) => setRefId(e.target.value)} disabled={busy}>
                <option value="">No reference</option>
                {references.map((r) => <option key={r.id} value={r.id}>{r.label || 'Reference'} · {dayLabel(r.taken_on)}</option>)}
              </select>
            </label>
          )}
        </div>
        {busy && <p className="msg">Analysing the photo with OpenCV…</p>}
        {error && <p className="msg error">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy || !file}>{busy ? 'Analysing…' : 'Add photo'}</button>
        </div>
      </form>
    </div>
  )
}

/** Panel camera section of the Cleaning & Cooling page. `analysis` = latest cleaning_analyses row. */
export default function PanelCamera({ plant, analysis, dataVersion, onChanged }) {
  const key = `${plant.id}:${dataVersion}`
  const [state, setState] = useState({ key: null, plantId: null, rows: [], error: '' })
  const [selectedId, setSelectedId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState('')
  const [msg, setMsg] = useState({ text: '', error: false })

  useEffect(() => {
    let cancelled = false
    fetchPhotos(plant)
      .then((rows) => !cancelled && setState({ key, plantId: plant.id, rows, error: '' }))
      .catch((e) => !cancelled && setState({ key, plantId: plant.id, rows: [], error: e.message || 'Could not load photos.' }))
    return () => { cancelled = true }
  }, [plant, key])

  const rows = state.plantId === plant.id ? state.rows : []
  const references = rows.filter((r) => r.kind === 'reference')
  const captures = rows.filter((r) => r.kind === 'inspection')
  const selected = rows.find((r) => r.id === selectedId) ?? captures[0] ?? rows[0] ?? null
  const ref = selected?.kind === 'inspection' ? rows.find((r) => r.id === selected.reference_id) : null
  const res = selected?.result ?? {}
  const captureDay = analysis?.as_of && analysis.as_of <= todayIso() ? analysis.as_of : todayIso()

  async function finish(text) {
    setMsg({ text: `${text} Updating the cleaning decision…`, error: false })
    const r = await analyseCleaning(plant.id)
    setMsg({ text: r.error ? `${text} (The cleaning decision could not be updated: ${r.error})` : text, error: Boolean(r.error) })
    onChanged()
  }

  async function loadSamples() {
    setBusy('import')
    const referenceDate = analysis?.last_reset && analysis.last_reset < captureDay ? analysis.last_reset : addDays(captureDay, -10)
    const r = await importSamples(plant.id, { referenceDate, captureDate: captureDay }, (t) => setMsg({ text: t, error: false }))
    setBusy('')
    if (r.error) return setMsg({ text: r.error, error: true })
    await finish('Sample photos imported: clean photos as references, dirty photos as camera captures.')
  }

  async function remove(row) {
    if (!window.confirm('Delete this photo?')) return
    setBusy(row.id)
    const r = await deletePhoto(row)
    setBusy('')
    if (r.error) return setMsg({ text: r.error, error: true })
    if (selectedId === row.id) setSelectedId(null)
    await finish('Photo deleted.')
  }

  return (
    <section className="card camera">
      <div className="card-head">
        <h2><Camera size={18} /> Panel camera <small className="proto">prototype</small></h2>
        <div className="detail-actions">
          {rows.length === 0 && (
            <button className="btn sm" onClick={loadSamples} disabled={Boolean(busy)}><Images size={15} /> Import sample photos</button>
          )}
          <button className="btn sm primary" onClick={() => setAdding(true)} disabled={Boolean(busy)}><ImagePlus size={15} /> Add photo</button>
        </div>
      </div>
      <p className="data-note">
        In a real plant a fixed camera photographs the same panels every day and compares each capture with a clean
        reference taken after cleaning. Here a photo upload simulates a capture. OpenCV finds the panel, removes the grid
        lines and measures dirt spots (area) and dust film (colour shift towards brown). The latest capture (≤ 14 days
        old) feeds the cleaning decision above.
      </p>
      {msg.text && <p className={`msg ${msg.error ? 'error' : ''}`}>{msg.text}</p>}
      {state.error && <p className="msg error">{state.error.includes('panel_inspections') ? 'Run 007_panel_photos.sql in Supabase first.' : state.error}</p>}

      {selected && (
        <>
          <div className="photo-compare">
            {ref && (
              <figure>
                <img src={ref.imageUrl} alt="Clean reference" />
                <figcaption>Clean reference · {dayLabel(ref.taken_on)}</figcaption>
              </figure>
            )}
            <figure>
              <img src={selected.imageUrl} alt="Panel photo" />
              <figcaption>{selected.kind === 'reference' ? 'Reference' : 'Camera capture'} · {dayLabel(selected.taken_on)}</figcaption>
            </figure>
            <figure>
              <img src={selected.overlayUrl} alt="Detected dirt in red" />
              <figcaption>Analysed: dirt in red{res.aligned ? ', new dirt in orange' : ''}, panel outlined in green</figcaption>
            </figure>
          </div>
          <dl className="facts">
            <div><dt>Soiled</dt><dd>{num(res.soiled_pct, 1)} % <span className={`sev-tag ${res.severity === 'heavy' ? 'high' : res.severity === 'moderate' ? 'medium' : 'low'}`}>{res.severity}</span></dd></div>
            <div><dt>Dirt spots (area)</dt><dd>{num(res.spots_pct, 1)} %</dd></div>
            <div><dt>Dust film (colour)</dt><dd>{num(res.film_pct, 1)} %{res.colour_shift != null && ` (shift ${res.colour_shift > 0 ? '+' : ''}${num(res.colour_shift, 1)})`}</dd></div>
            <div><dt>Rough power loss</dt><dd>≈ {num(res.est_loss_pct, 1)} %</dd></div>
            {res.reference_soiled_pct != null && <div><dt>Reference photo</dt><dd>{num(res.reference_soiled_pct, 1)} % soiled</dd></div>}
            <div><dt>Data estimate</dt><dd>{analysis ? `${num(analysis.loss_pct, 1)} % output loss` : '—'}</dd></div>
          </dl>
          <p className="data-note">Method: {res.method}{res.match_points != null && !res.aligned && ` (views too different to align: ${res.match_points} matching points)`}. Power loss ≈ 0.6 × soiled area (rough assumption).</p>
        </>
      )}

      {rows.length > 0 && (
        <ul className="photo-list">
          {rows.map((r) => (
            <li key={r.id} className={r.id === selected?.id ? 'on' : ''}>
              <button className="photo-pick" onClick={() => setSelectedId(r.id)}>
                <img src={r.imageUrl} alt="" />
                <span>
                  <strong>{r.kind === 'reference' ? 'Reference' : 'Capture'} · {dayLabel(r.taken_on)}</strong>
                  <small>{r.label || '—'}</small>
                  <small>{num(r.result?.soiled_pct, 1)} % soiled · {r.result?.severity}</small>
                </span>
              </button>
              <button className="icon-btn" onClick={() => remove(r)} disabled={Boolean(busy)} aria-label="Delete photo"><Trash2 size={15} /></button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddPhotoModal plantId={plant.id} references={references} defaultDate={captureDay}
          onClose={() => setAdding(false)}
          onSaved={(row) => { setAdding(false); setSelectedId(row.id); finish('Photo analysed and saved.') }} />
      )}
    </section>
  )
}
