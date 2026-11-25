import { useEffect, useMemo, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceArea,
} from 'recharts'
import {
  ShieldAlert, AlertTriangle, Zap, Search, Cpu, RefreshCw, Check, CheckCheck, RotateCcw, ClipboardPlus, ClipboardList,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { ALARM_LABELS, fetchAnomalies, fetchAnomalyDay, runDetection, setAnomalyStatus } from '../lib/anomaliesData'
import { taskFromAnomaly } from '../lib/maintenanceData'
import { TaskFormModal } from '../components/TaskModals'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const label = (type) => ALARM_LABELS[type] ?? type
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }
const duration = (a) => {
  const min = Math.round((new Date(a.ts_end) - new Date(a.ts_start)) / 60000)
  const h = Math.floor(min / 60)
  return h ? `${h} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`
}
const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 }

function Stat({ icon: Icon, tone, label: title, value, note }) {
  return (
    <div className="card kpi">
      <span className={`kpi-icon ${tone}`}><Icon size={24} /></span>
      <div>
        <p className="kpi-label">{title}</p>
        <p className="kpi-value">{value}</p>
        {note && <small className="kpi-note">{note}</small>}
      </div>
    </div>
  )
}

function Select({ value, onChange, options, label: title }) {
  return (
    <label className="filter">
      <span>{title}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
    </label>
  )
}

function DayChart({ plant, anomaly }) {
  const key = anomaly.id
  const [state, setState] = useState({ key: null, data: null, error: '' })
  useEffect(() => {
    let cancelled = false
    fetchAnomalyDay(plant, anomaly)
      .then((data) => !cancelled && setState({ key, data, error: '' }))
      .catch((e) => !cancelled && setState({ key, data: null, error: e.message }))
    return () => { cancelled = true }
  }, [plant, anomaly, key])
  const data = state.key === key ? state.data : null
  if (state.key === key && state.error) return <p className="msg error">{state.error}</p>
  if (!data) return <p className="data-note">Loading the day’s readings…</p>
  if (!data.points.length) return <p className="data-note">No readings stored for this day.</p>
  return (
    <>
      <div className="legend">
        <span><i className="sw" /> Actual</span>
        <span><i className="sw dashed" style={{ borderColor: '#0f766e' }} /> Expected</span>
        <span><i className="sw bar" style={{ background: '#fecaca' }} /> Anomaly</span>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data.points} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
          <CartesianGrid stroke="#e8edf3" vertical={false} />
          <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
          <YAxis {...axis} unit=" MW" width={64} />
          <Tooltip formatter={(v, name) => [v == null ? '—' : `${num(v, 2)} MW`, name]} />
          {data.from && <ReferenceArea x1={data.from} x2={data.to} fill="#fecaca" fillOpacity={0.6} />}
          <Area dataKey="actual" name="Actual" stroke="#16a34a" strokeWidth={2} fill="#22c55e" fillOpacity={0.12} />
          <Line dataKey="expected" name="Expected" stroke="#0f766e" strokeWidth={2} strokeDasharray="6 4" dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}

function Detail({ plant, a, onStatus, onCreateTask, busy }) {
  const d = a.details ?? {}
  const tz = plant.timezone || 'Asia/Kolkata'
  const fmt = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })
  const facts = [
    ['When', `${fmt(a.ts_start)} – ${fmt(a.ts_end)} (${duration(a)})`],
    ['Detected by', a.source === 'ml' ? `ML · ${(d.detectors ?? []).map((x) => (x === 'iforest' ? 'Isolation Forest' : 'Residual')).join(' + ')}` : 'Rule'],
    a.energy_lost_kwh > 0 && ['Energy lost', `${num(a.energy_lost_kwh)} kWh${d.revenue_lost_inr ? ` · ₹ ${num(d.revenue_lost_inr)}` : ''}`],
    a.expected_kw != null && ['Avg expected / actual', `${num(a.expected_kw / 1000, 2)} / ${num(a.actual_kw / 1000, 2)} MW`],
    d.output_ratio != null && ['Output vs expected', `${num(d.output_ratio * 100, 0)} %`],
    a.type === 'inverter_fault' && ['Inverter efficiency (AC/DC)', `${d.acdc} (normal ${d.acdc_normal})`],
    a.type === 'overheating' && ['Extra module heat', `+${d.temp_excess_c} °C`],
    a.score != null && a.source === 'ml' && ['Anomaly score', `${num(a.score, 3)} (1 = most unusual)`],
  ].filter(Boolean)
  return (
    <div className="card anomaly-detail">
      <div className="card-head">
        <h2><AlertTriangle size={18} className={a.severity === 'high' ? 'c-red' : 'c-amber'} /> {label(a.type)}</h2>
        <span className={`sev-tag ${a.severity}`}>{a.severity}</span>
      </div>
      <p className="explain">{a.explanation}</p>
      <dl className="facts">
        {facts.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      <DayChart plant={plant} anomaly={a} />
      {a.tasks?.length > 0 && (
        <p className="linked-task">
          <ClipboardList size={15} /> Task: <strong>{a.tasks[0].title}</strong> ({a.tasks[0].status.replace('_', ' ')}) ·{' '}
          <Link to="/maintenance?tab=tasks">open tasks</Link>
        </p>
      )}
      <div className="detail-actions">
        <span className={`status-tag ${a.status === 'resolved' ? 'done' : ''}`}>{a.status}</span>
        {a.status === 'open' && (
          <button className="btn sm" disabled={busy} onClick={() => onStatus(a, 'acknowledged')}><Check size={15} /> Acknowledge</button>
        )}
        {a.status !== 'resolved' && (
          <button className="btn sm primary" disabled={busy} onClick={() => onStatus(a, 'resolved')}><CheckCheck size={15} /> Mark resolved</button>
        )}
        {a.status !== 'open' && (
          <button className="btn sm" disabled={busy} onClick={() => onStatus(a, 'open')}><RotateCcw size={15} /> Reopen</button>
        )}
        {a.status !== 'resolved' && !a.tasks?.length && (
          <button className="btn sm" disabled={busy} onClick={() => onCreateTask(a)}><ClipboardPlus size={15} /> Create task</button>
        )}
      </div>
    </div>
  )
}

export default function Anomalies() {
  const { plant } = useOutletContext()
  const { dataVersion, notifyDataChanged } = usePlants()
  const key = `${plant?.id}:${dataVersion}`
  const [state, setState] = useState({ key: null, rows: [], error: '' })
  const [patched, setPatched] = useState({}) // id -> updated row (status changes made on this page)
  const [filters, setFilters] = useState({ status: 'open', source: 'all', severity: 'all', type: 'all' })
  const [selectedId, setSelectedId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', error: false })
  const [taskFor, setTaskFor] = useState(null) // anomaly a new task is being created for

  useEffect(() => {
    let cancelled = false
    fetchAnomalies(plant)
      .then((rows) => !cancelled && setState({ key, rows, error: '' }))
      .catch((e) => !cancelled && setState({ key, rows: [], error: e.message || 'Could not load anomalies.' }))
    return () => { cancelled = true }
  }, [plant, key])

  const loading = state.key !== key
  const all = useMemo(
    () => (loading ? [] : state.rows.map((r) => patched[r.id] ?? r)),
    [loading, state.rows, patched],
  )

  const stats = useMemo(() => {
    const ml = all.filter((a) => a.source === 'ml')
    const lostKwh = ml.reduce((s, a) => s + (a.energy_lost_kwh ?? 0), 0)
    const lostInr = ml.reduce((s, a) => s + (a.details?.revenue_lost_inr ?? 0), 0)
    const byCause = {}
    for (const a of ml) byCause[a.type] = (byCause[a.type] ?? 0) + (a.energy_lost_kwh ?? 0)
    const top = Object.entries(byCause).sort((x, y) => y[1] - x[1])[0]
    return {
      open: all.filter((a) => a.status === 'open').length,
      high: all.filter((a) => a.status === 'open' && a.severity === 'high').length,
      lostKwh, lostInr, top, ml: ml.length, rule: all.length - ml.length,
    }
  }, [all])

  const types = useMemo(() => [...new Set(all.map((a) => a.type))].sort(), [all])
  const rows = all
    .filter((a) => (filters.status === 'all' || a.status === filters.status)
      && (filters.source === 'all' || a.source === filters.source)
      && (filters.severity === 'all' || a.severity === filters.severity)
      && (filters.type === 'all' || a.type === filters.type))
    .sort((x, y) => SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] || new Date(y.ts_start) - new Date(x.ts_start))
  const selected = all.find((a) => a.id === selectedId) ?? null
  const setFilter = (k) => (v) => setFilters((f) => ({ ...f, [k]: v }))

  async function handleStatus(a, status) {
    setBusy(true)
    const res = await setAnomalyStatus(a.id, status)
    setBusy(false)
    if (res.error) return setMsg({ text: res.error, error: true })
    setPatched((p) => ({ ...p, [a.id]: res.data }))
    setMsg({ text: '', error: false })
  }

  async function handleDetect() {
    setBusy(true)
    setMsg({ text: 'Running anomaly detection on all of this plant’s data…', error: false })
    const res = await runDetection(plant.id)
    setBusy(false)
    if (res.error) return setMsg({ text: res.error, error: true })
    setMsg({ text: `Detection finished: ${res.result.found} ML anomal${res.result.found === 1 ? 'y' : 'ies'} found.`, error: false })
    setPatched({})
    notifyDataChanged()
  }

  if (!plant) return null
  const tz = plant.timezone || 'Asia/Kolkata'
  const when = (iso) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: tz })

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon gray"><ShieldAlert size={26} /></span>
          <div>
            <h1>Anomalies</h1>
            <p className="muted-text">
              {plant.name} · rule-based alarms + ML detection (Isolation Forest and expected-vs-actual residuals)
            </p>
          </div>
          <div className="profile-actions">
            <button className="btn sm primary" onClick={handleDetect} disabled={busy}>
              <RefreshCw size={15} className={busy ? 'spin' : ''} /> Run detection
            </button>
          </div>
        </div>
        {msg.text && <p className={`msg ${msg.error ? 'error' : ''}`}>{msg.text}</p>}
        {state.error && <p className="msg error">{state.error}</p>}
      </section>

      <section className="kpis">
        <Stat icon={AlertTriangle} tone="lime" label="Open anomalies" value={num(stats.open)}
          note={stats.high ? `${stats.high} high severity` : 'none high severity'} />
        <Stat icon={Zap} tone="teal" label="Energy lost (ML-detected)" value={`${num(stats.lostKwh / 1000, 1)} MWh`}
          note={stats.lostInr ? `≈ ₹ ${num(stats.lostInr)} across all data` : 'across all data'} />
        <Stat icon={Search} tone="blue" label="Biggest cause" value={stats.top ? label(stats.top[0]) : '—'}
          note={stats.top ? `${num(stats.top[1] / 1000, 1)} MWh lost` : 'no ML anomalies'} />
        <Stat icon={Cpu} tone="gray" label="Detected by" value={`${stats.ml} ML · ${stats.rule} rule`}
          note="rule alarms are the baseline" />
      </section>

      <section className="row row-fc">
        <div className="card">
          <div className="filters">
            <Select label="Status" value={filters.status} onChange={setFilter('status')}
              options={[['open', 'Open'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved'], ['all', 'All']]} />
            <Select label="Source" value={filters.source} onChange={setFilter('source')}
              options={[['all', 'All'], ['ml', 'ML'], ['rule', 'Rule']]} />
            <Select label="Severity" value={filters.severity} onChange={setFilter('severity')}
              options={[['all', 'All'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']]} />
            <Select label="Cause" value={filters.type} onChange={setFilter('type')}
              options={[['all', 'All'], ...types.map((t) => [t, label(t)])]} />
          </div>
          {loading ? (
            <p className="data-note">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="empty">{all.length ? 'Nothing matches these filters.' : 'No anomalies yet. Upload data or press “Run detection”.'}</p>
          ) : (
            <div className="table-wrap">
              <table className="mini-table clickable">
                <thead>
                  <tr><th>When</th><th>Cause</th><th>Severity</th><th>Duration</th><th>Energy lost</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id} className={a.id === selectedId ? 'chosen' : ''} onClick={() => setSelectedId(a.id)}>
                      <td>{when(a.ts_start)}</td>
                      <td>{label(a.type)}{a.tasks?.length > 0 && <ClipboardList size={13} className="c-teal task-flag" aria-label="has a task" />}</td>
                      <td><span className={`sev-tag ${a.severity}`}>{a.severity}</span></td>
                      <td>{duration(a)}</td>
                      <td>{a.energy_lost_kwh > 0 ? `${num(a.energy_lost_kwh)} kWh` : '—'}</td>
                      <td>{a.source === 'ml' ? 'ML' : 'Rule'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {selected ? (
          <Detail plant={plant} a={selected} onStatus={handleStatus} onCreateTask={setTaskFor} busy={busy} />
        ) : (
          <div className="card">
            <h2>Details</h2>
            <p className="empty">Select an anomaly to see its explanation, the day’s power curve and actions.</p>
          </div>
        )}
      </section>

      {taskFor && (
        <TaskFormModal plantId={plant.id} preset={taskFromAnomaly(taskFor, plant)} onClose={() => setTaskFor(null)}
          onSaved={() => {
            setTaskFor(null)
            setPatched({})
            setMsg({ text: 'Task created and the anomaly marked acknowledged. See the "Maintenance tasks" tab.', error: false })
            notifyDataChanged()
          }} />
      )}
    </div>
  )
}
