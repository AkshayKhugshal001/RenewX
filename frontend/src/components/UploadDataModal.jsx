import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import CsvPicker from './CsvPicker'
import { uploadPlantCsv } from '../lib/plantDataUpload'

const n = (x) => Number(x || 0).toLocaleString('en-IN')
const fmtDay = (iso, timeZone) =>
  new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone })

// Summary of what the backend stored and analysed
function UploadReport({ r, timeZone }) {
  return (
    <div className="upload-report">
      <p className="msg ok">
        Saved <strong>{n(r.inserted)}</strong> new reading{r.inserted === 1 ? '' : 's'}
        {r.updated > 0 && <> and updated <strong>{n(r.updated)}</strong></>}
        {' '}for {fmtDay(r.ts_from, timeZone)} – {fmtDay(r.ts_to, timeZone)}.
        {' '}{r.days_analysed} day{r.days_analysed === 1 ? '' : 's'} analysed, {r.alarms_found} alarm{r.alarms_found === 1 ? '' : 's'} found.
      </p>
      <ul className="report-stats">
        <li><b>{n(r.total)}</b> rows in file</li>
        <li><b>{n(r.skipped)}</b> already stored (skipped)</li>
        <li><b>{n(r.rejected)}</b> rejected</li>
        {r.ml_anomalies && <li><b>{n(r.ml_anomalies.found)}</b> ML anomalies (all data)</li>}
      </ul>
      {r.fixes?.length > 0 && (
        <div className="report-list">
          <strong>Automatic fixes</strong>
          <ul>{r.fixes.map((f) => <li key={f}>{f}</li>)}</ul>
        </div>
      )}
      {r.warnings?.length > 0 && (
        <div className="report-list warn">
          <strong>Warnings</strong>
          <ul>{r.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
    </div>
  )
}

// "Upload data" dialog for an existing plant: daily add-on or historical CSV.
export default function UploadDataModal({ plant, onClose, onUploaded }) {
  const [kind, setKind] = useState('daily')
  const [replace, setReplace] = useState(false)
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const done = Boolean(result)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (!file) return setError('Choose a CSV file first.')

    setBusy(true)
    const res = await uploadPlantCsv(plant.id, file, kind, replace ? 'replace' : 'skip')
    setBusy(false)
    if (res.error) return setError(res.error)
    setResult(res.result)
    onUploaded?.()
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-labelledby="upload-modal-title" onSubmit={handleSubmit}>
        <div className="modal-head">
          <h2 id="upload-modal-title">Upload data</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close">
            <X size={20} />
          </button>
        </div>

        <p className="muted-text">
          Add a CSV for <strong>{plant.name}</strong>. New readings are added to the existing data and the
          statistics for those days are recalculated.
        </p>

        <div className="seg" role="radiogroup" aria-label="Type of data">
          <button type="button" role="radio" aria-checked={kind === 'daily'} className={kind === 'daily' ? 'on' : ''} onClick={() => setKind('daily')} disabled={busy || done}>
            Daily / recent data
          </button>
          <button type="button" role="radio" aria-checked={kind === 'historical'} className={kind === 'historical' ? 'on' : ''} onClick={() => setKind('historical')} disabled={busy || done}>
            Historical data
          </button>
        </div>

        <CsvPicker file={file} onChange={setFile} disabled={busy || done} />

        <label className="check">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} disabled={busy || done} />
          Replace readings that are already stored for the same times
        </label>

        {busy && <p className="msg">Uploading, analysing and updating the forecast… this can take up to a minute.</p>}
        {error && <p className="msg error">{error}</p>}
        {result && <UploadReport r={result} timeZone={plant.timezone || 'Asia/Kolkata'} />}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>{done ? 'Close' : 'Cancel'}</button>
          {!done && (
            <button type="submit" className="btn primary" disabled={busy || !file}>
              {busy ? 'Uploading…' : 'Upload'}
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
