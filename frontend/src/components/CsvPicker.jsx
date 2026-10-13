import { useRef, useState } from 'react'
import { FileSpreadsheet, Upload, X } from 'lucide-react'
import { formatSize, validateCsvFile } from '../lib/plantDataUpload'

// Controlled CSV file chooser (click or drag & drop).
// `file` is the selected File (or null); `onChange(file | null)` is called on pick / remove.
export default function CsvPicker({ file, onChange, disabled }) {
  const inputRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState('')

  function pick(f) {
    if (!f) return
    const problem = validateCsvFile(f)
    setError(problem)
    if (!problem) onChange(f)
  }

  function clear() {
    setError('')
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv"
        hidden
        disabled={disabled}
        onChange={(e) => pick(e.target.files?.[0])}
      />

      {file ? (
        <div className="csv-file">
          <FileSpreadsheet size={20} />
          <span className="csv-file-name">
            <strong>{file.name}</strong>
            <small>{formatSize(file.size)}</small>
          </span>
          <button type="button" className="icon-btn" onClick={clear} disabled={disabled} aria-label="Remove file">
            <X size={18} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`csv-drop${dragging ? ' drag' : ''}`}
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0]) }}
        >
          <Upload size={20} />
          <span><strong>Choose a CSV file</strong> or drag it here</span>
        </button>
      )}

      {error && <p className="msg error">{error}</p>}
    </div>
  )
}
