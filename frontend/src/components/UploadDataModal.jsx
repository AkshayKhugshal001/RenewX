import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import CsvPicker from './CsvPicker'
import { uploadPlantCsv } from '../lib/plantDataUpload'

// "Upload data" dialog for an existing plant: daily add-on or historical CSV.
export default function UploadDataModal({ plant, onClose }) {
  const [kind, setKind] = useState('daily')
  const [file, setFile] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

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
    const res = await uploadPlantCsv(plant.id, file, kind)
    setBusy(false)
    if (res.error) setError(res.error)
    else setDone(res.message || 'Upload complete.')
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
          Add a CSV for <strong>{plant.name}</strong>. Rows are matched to the plant by their timestamps.
        </p>

        <div className="seg" role="radiogroup" aria-label="Type of data">
          <button type="button" role="radio" aria-checked={kind === 'daily'} className={kind === 'daily' ? 'on' : ''} onClick={() => setKind('daily')} disabled={busy || Boolean(done)}>
            Daily / recent data
          </button>
          <button type="button" role="radio" aria-checked={kind === 'historical'} className={kind === 'historical' ? 'on' : ''} onClick={() => setKind('historical')} disabled={busy || Boolean(done)}>
            Historical data
          </button>
        </div>

        <CsvPicker file={file} onChange={setFile} disabled={busy || Boolean(done)} />

        {error && <p className="msg error">{error}</p>}
        {done && <p className="msg ok">{done}</p>}

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
