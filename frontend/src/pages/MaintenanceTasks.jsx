import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  HeartPulse, ClipboardList, AlarmClock, CheckCircle2, Plus, CalendarPlus, Play, Check, Pencil,
  Repeat, User, Link2, TrendingUp, TrendingDown,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import {
  CATEGORIES, SOURCE_LABELS, addStandardSchedule, fetchMaintenance, isOverdue, taskImpact,
  todayIso, updateTask,
} from '../lib/maintenanceData'
import { ALARM_LABELS } from '../lib/plantOverviewData'
import { TaskDoneModal, TaskFormModal } from '../components/TaskModals'
import { analyseCleaning } from '../lib/api'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const fmtDate = (iso) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000)

function dueText(t) {
  if (!t.due_date) return 'No due date'
  const d = daysBetween(todayIso(), t.due_date)
  if (d < 0) return `${-d} day${d === -1 ? '' : 's'} overdue`
  if (d === 0) return 'Due today'
  if (d === 1) return 'Due tomorrow'
  return `Due in ${d} days · ${fmtDate(t.due_date)}`
}

function Stat({ icon: Icon, tone, label, value, note }) {
  return (
    <div className="card kpi">
      <span className={`kpi-icon ${tone}`}><Icon size={24} /></span>
      <div>
        <p className="kpi-label">{label}</p>
        <p className="kpi-value">{value}</p>
        {note && <small className="kpi-note">{note}</small>}
      </div>
    </div>
  )
}

function Impact({ task, summaries, tariff }) {
  const i = taskImpact(task, summaries, tariff)
  if (!i) return null
  if (i.pending) return <span className="impact pending">Effect: waiting for data after this date ({i.afterDays}/3 days)</span>
  const up = i.changePct >= 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span className={`impact ${up ? 'good' : 'bad'}`}>
      <Icon size={14} /> Output vs expected {up ? '+' : ''}{num(i.changePct, 1)} % after this work
      {Math.abs(i.weeklyKwh) >= 1 && <> · {up ? '+' : ''}{num(i.weeklyKwh)} kWh/week{tariff ? ` (₹ ${num(i.weeklyInr)})` : ''}</>}
    </span>
  )
}

function TaskRow({ t, summaries, tariff, onStart, onDone, onEdit, busy }) {
  const overdue = isOverdue(t)
  const open = t.status === 'planned' || t.status === 'in_progress'
  return (
    <li className={`task ${overdue ? 'overdue' : ''} ${t.status}`}>
      <div className="task-main">
        <div className="task-title">
          <strong>{t.title}</strong>
          <span className={`sev-tag ${t.priority}`}>{t.priority}</span>
        </div>
        <div className="task-meta">
          <span className="chip">{CATEGORIES[t.category]}</span>
          {t.status === 'in_progress' && <span className="chip blue">In progress</span>}
          {open && <span className={overdue ? 'due bad' : 'due'}>{dueText(t)}</span>}
          {t.status === 'done' && <span>Done {fmtDate(t.completed_at)}{t.actual_cost_inr != null && ` · ₹ ${num(t.actual_cost_inr)}`}{t.water_litres != null && ` · ${num(t.water_litres)} L water`}</span>}
          {t.status === 'cancelled' && <span>Cancelled</span>}
          {t.assigned_to && <span><User size={13} /> {t.assigned_to}</span>}
          {t.recurrence_days && <span><Repeat size={13} /> every {t.recurrence_days} d</span>}
          {t.anomaly && <span><Link2 size={13} /> {ALARM_LABELS[t.anomaly.type] ?? t.anomaly.type} ({t.anomaly.status})</span>}
          {!t.anomaly && t.source !== 'manual' && <span>{SOURCE_LABELS[t.source]}</span>}
        </div>
        {t.status === 'done' && <Impact task={t} summaries={summaries} tariff={tariff} />}
      </div>
      <div className="task-actions">
        {t.status === 'planned' && <button className="btn sm" disabled={busy} onClick={() => onStart(t)}><Play size={14} /> Start</button>}
        {open && <button className="btn sm primary" disabled={busy} onClick={() => onDone(t)}><Check size={14} /> Done</button>}
        <button className="btn sm" disabled={busy} onClick={() => onEdit(t)} aria-label="Edit task"><Pencil size={14} /></button>
      </div>
    </li>
  )
}

function Group({ title, items, empty, rowProps }) {
  return (
    <section className="card task-group">
      <div className="card-head"><h2>{title} <small className="count">{items.length}</small></h2></div>
      {items.length === 0 ? <p className="empty">{empty}</p> : (
        <ul className="tasks">{items.map((t) => <TaskRow key={t.id} t={t} {...rowProps} />)}</ul>
      )}
    </section>
  )
}

export default function MaintenanceTasks() {
  const { plant } = useOutletContext()
  const { dataVersion, notifyDataChanged } = usePlants()
  const key = `${plant?.id}:${dataVersion}`
  const [state, setState] = useState({ key: null, plantId: null, data: null, error: '' })
  const [modal, setModal] = useState(null) // { kind: 'form', task? } | { kind: 'done', task }
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showDone, setShowDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetchMaintenance(plant)
      .then((data) => !cancelled && setState({ key, plantId: plant?.id, data, error: '' }))
      .catch((e) => !cancelled && setState({ key, plantId: plant?.id, data: null, error: e.message || 'Could not load tasks.' }))
    return () => { cancelled = true }
  }, [plant, key])

  if (!plant) return null
  // keep showing the previous result while refreshing, but never another plant's tasks
  const data = state.plantId === plant.id ? state.data : null
  const tasks = data?.tasks ?? []
  const tariff = plant.tariff_inr_per_kwh || 0
  const h = data?.health

  const overdue = tasks.filter(isOverdue)
  const upcoming = tasks.filter((t) => t.status === 'planned' && !isOverdue(t))
  const inProgress = tasks.filter((t) => t.status === 'in_progress' && !isOverdue(t))
  const done = tasks.filter((t) => t.status === 'done' || t.status === 'cancelled')
    .sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at))
  const month = todayIso().slice(0, 7)
  const doneThisMonth = tasks.filter((t) => t.status === 'done' && t.completed_at?.slice(0, 7) === month)
  const spent = doneThisMonth.reduce((s, t) => s + Number(t.actual_cost_inr ?? 0), 0)
  const hasSchedule = tasks.some((t) => t.recurrence_days && t.status !== 'done' && t.status !== 'cancelled')

  const saved = (text) => { setModal(null); setMsg(text); notifyDataChanged() }

  async function start(t) {
    setBusy(true)
    const res = await updateTask(t.id, { status: 'in_progress' })
    setBusy(false)
    if (res.error) return setMsg(res.error)
    notifyDataChanged()
  }

  async function schedule() {
    setBusy(true)
    const res = await addStandardSchedule(plant.id)
    setBusy(false)
    if (res.error) return setMsg(res.error)
    saved('Standard schedule added: monthly inverter inspection, quarterly sensor calibration, yearly thermal inspection.')
  }

  const rowProps = {
    summaries: data?.summaries ?? [], tariff, busy,
    onStart: start, onDone: (t) => setModal({ kind: 'done', task: t }), onEdit: (t) => setModal({ kind: 'form', task: t }),
  }

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon teal"><ClipboardList size={26} /></span>
          <div>
            <h1>Maintenance tasks</h1>
            <p className="muted-text">{plant.name} · plan work, record what was done and see whether it helped</p>
          </div>
          <div className="profile-actions">
            {!hasSchedule && (
              <button className="btn sm" onClick={schedule} disabled={busy}><CalendarPlus size={15} /> Add standard schedule</button>
            )}
            <button className="btn sm primary" onClick={() => setModal({ kind: 'form' })} disabled={busy}><Plus size={15} /> New task</button>
          </div>
        </div>
        {msg && <p className="msg">{msg}</p>}
        {state.error && <p className="msg error">{state.error}</p>}
      </section>

      <section className="kpis">
        <Stat icon={HeartPulse} tone="green" label="Plant health" value={h ? `${h.score} / 100` : '—'}
          note={h ? `${h.label} · output ${num(h.ratio * 100, 0)} % of expected, availability ${num(h.avail, 0)} %` : 'needs uploaded data'} />
        <Stat icon={ClipboardList} tone="blue" label="Open tasks" value={num(overdue.length + upcoming.length + inProgress.length)}
          note={`${inProgress.length} in progress`} />
        <Stat icon={AlarmClock} tone="lime" label="Overdue" value={num(overdue.length)} note={overdue.length ? 'needs attention' : 'nothing overdue'} />
        <Stat icon={CheckCircle2} tone="teal" label="Done this month" value={num(doneThisMonth.length)}
          note={spent ? `₹ ${num(spent)} spent` : 'no costs recorded'} />
      </section>

      {h && (
        <p className="data-note health-note">
          Health score = output vs expected {h.parts.output}/40 · availability {h.parts.availability}/30 ·
          open anomalies {h.parts.anomalies}/20 ({h.openAnomalies} open) · overdue tasks {h.parts.tasks}/10.
        </p>
      )}

      {!data && !state.error ? <p className="data-note">Loading…</p> : (
        <>
          {overdue.length > 0 && <Group title="Overdue" items={overdue} rowProps={rowProps} />}
          <Group title="Upcoming" items={[...inProgress, ...upcoming]} rowProps={rowProps}
            empty="No planned work. Create a task, add the standard schedule, or create one from an anomaly." />
          <section className="card task-group">
            <div className="card-head">
              <h2>Completed <small className="count">{done.length}</small></h2>
              {done.length > 5 && <button className="btn sm" onClick={() => setShowDone((v) => !v)}>{showDone ? 'Show fewer' : 'Show all'}</button>}
            </div>
            {done.length === 0 ? <p className="empty">Nothing completed yet.</p> : (
              <ul className="tasks">{(showDone ? done : done.slice(0, 5)).map((t) => <TaskRow key={t.id} t={t} {...rowProps} />)}</ul>
            )}
          </section>
        </>
      )}

      {modal?.kind === 'form' && (
        <TaskFormModal plantId={plant.id} task={modal.task} onClose={() => setModal(null)}
          onSaved={(row) => saved(row ? (modal.task ? 'Task saved.' : 'Task created.') : 'Task deleted.')} />
      )}
      {modal?.kind === 'done' && (
        <TaskDoneModal task={modal.task} onClose={() => setModal(null)}
          onSaved={() => {
            if (modal.task.category === 'cleaning') analyseCleaning(plant.id).then((res) => !res.error && notifyDataChanged())
            saved(modal.task.anomaly ? 'Task done – its anomaly is marked resolved.'
              : modal.task.category === 'cleaning' ? 'Cleaning recorded – the soiling estimate is being updated.'
                : modal.task.recurrence_days ? `Task done – next one planned in ${modal.task.recurrence_days} days.` : 'Task done.')
          }} />
      )}
    </div>
  )
}
