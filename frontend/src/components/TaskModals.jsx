import { useEffect, useState } from 'react'
import { X, Trash2 } from 'lucide-react'
import { CATEGORIES, createTask, deleteTask, editTask, todayIso, updateTask } from '../lib/maintenanceData'

const REPEAT = [['', 'Does not repeat'], ['7', 'Every week'], ['30', 'Every month'], ['90', 'Every 3 months'], ['180', 'Every 6 months'], ['365', 'Every year']]

function useEscape(busy, onClose) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
}

function Shell({ title, busy, onClose, onSubmit, children }) {
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <form className="modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={onSubmit}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} disabled={busy} aria-label="Close"><X size={20} /></button>
        </div>
        {children}
      </form>
    </div>
  )
}

/** Create (task = null, optional `preset`) or edit a task. onSaved(row | null) – null after delete. */
export function TaskFormModal({ plantId, task, preset, onClose, onSaved }) {
  const editing = Boolean(task)
  const base = task ?? preset ?? {}
  const [form, setForm] = useState({
    title: base.title ?? '',
    category: base.category ?? 'inspection',
    priority: base.priority ?? 'medium',
    due_date: base.due_date ?? todayIso(),
    assigned_to: base.assigned_to ?? '',
    est_cost_inr: base.est_cost_inr ?? '',
    recurrence_days: base.recurrence_days == null ? '' : String(base.recurrence_days),
    notes: base.notes ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEscape(busy, onClose)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!form.title.trim()) return setError('Give the task a title.')
    if (form.est_cost_inr !== '' && Number(form.est_cost_inr) < 0) return setError('Cost cannot be negative.')
    setBusy(true)
    const res = editing
      ? await editTask(task.id, form)
      : await createTask(plantId, { ...form, source: preset?.source, anomaly_id: preset?.anomaly_id })
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved(res.data)
  }

  async function remove() {
    if (!window.confirm('Delete this task? This cannot be undone.')) return
    setBusy(true)
    const res = await deleteTask(task.id)
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved(null)
  }

  return (
    <Shell title={editing ? 'Edit task' : 'New maintenance task'} busy={busy} onClose={onClose} onSubmit={submit}>
      {preset?.anomaly_id && !editing && (
        <p className="data-note">Linked to the selected anomaly – it is marked acknowledged now and resolved when this task is done.</p>
      )}
      <label className="field">Title
        <input value={form.title} onChange={set('title')} maxLength={200} disabled={busy} autoFocus />
      </label>
      <div className="field-row">
        <label className="field">Category
          <select value={form.category} onChange={set('category')} disabled={busy}>
            {Object.entries(CATEGORIES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
          </select>
        </label>
        <label className="field">Priority
          <select value={form.priority} onChange={set('priority')} disabled={busy}>
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">Due date
          <input type="date" value={form.due_date ?? ''} onChange={set('due_date')} disabled={busy} />
        </label>
        <label className="field">Repeat
          <select value={form.recurrence_days} onChange={set('recurrence_days')} disabled={busy}>
            {REPEAT.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            {form.recurrence_days && !REPEAT.some(([v]) => v === form.recurrence_days) &&
              <option value={form.recurrence_days}>Every {form.recurrence_days} days</option>}
          </select>
        </label>
      </div>
      <div className="field-row">
        <label className="field">Assigned to <span className="optional hint">optional</span>
          <input value={form.assigned_to} onChange={set('assigned_to')} maxLength={100} placeholder="e.g. Site technician" disabled={busy} />
        </label>
        <label className="field">Estimated cost (₹) <span className="optional hint">optional</span>
          <input type="number" min="0" step="100" value={form.est_cost_inr} onChange={set('est_cost_inr')} disabled={busy} />
        </label>
      </div>
      <label className="field">Notes <span className="optional hint">optional</span>
        <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={2000} disabled={busy} />
      </label>
      {error && <p className="msg error">{error}</p>}
      <div className="modal-actions">
        {editing && (
          <button type="button" className="btn danger" onClick={remove} disabled={busy} style={{ marginRight: 'auto' }}>
            <Trash2 size={15} /> Delete
          </button>
        )}
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save' : 'Create task'}</button>
      </div>
    </Shell>
  )
}

/** Mark a task done: completion date (may be in the past), actual cost, water used, notes. */
export function TaskDoneModal({ task, onClose, onSaved }) {
  const [form, setForm] = useState({
    date: todayIso(), actual_cost_inr: task.est_cost_inr ?? '', water_litres: '', notes: task.notes ?? '',
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEscape(busy, onClose)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!form.date) return setError('Choose the date the work was done.')
    if (form.date > todayIso()) return setError('The completion date cannot be in the future.')
    setBusy(true)
    const res = await updateTask(task.id, {
      status: 'done',
      completed_at: `${form.date}T12:00:00+05:30`,
      actual_cost_inr: form.actual_cost_inr === '' ? null : Number(form.actual_cost_inr),
      water_litres: form.water_litres === '' ? null : Number(form.water_litres),
      notes: form.notes.trim() || null,
    })
    setBusy(false)
    if (res.error) return setError(res.error)
    onSaved(res.data)
  }

  return (
    <Shell title="Mark task done" busy={busy} onClose={onClose} onSubmit={submit}>
      <p className="muted-text"><strong>{task.title}</strong></p>
      <div className="field-row">
        <label className="field">Done on
          <input type="date" value={form.date} max={todayIso()} onChange={set('date')} disabled={busy} />
        </label>
        <label className="field">Actual cost (₹)
          <input type="number" min="0" step="100" value={form.actual_cost_inr} onChange={set('actual_cost_inr')} disabled={busy} />
        </label>
      </div>
      {task.category === 'cleaning' && (
        <label className="field">Water used (litres)
          <input type="number" min="0" step="10" value={form.water_litres} onChange={set('water_litres')} disabled={busy} />
        </label>
      )}
      <label className="field">Notes
        <textarea rows={3} value={form.notes} onChange={set('notes')} maxLength={2000} disabled={busy} />
      </label>
      <p className="hint">
        The output after this date is compared with the week before to show whether the work helped.
        {task.recurrence_days ? ` The next run is planned automatically in ${task.recurrence_days} days.` : ''}
      </p>
      {error && <p className="msg error">{error}</p>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Mark done'}</button>
      </div>
    </Shell>
  )
}
