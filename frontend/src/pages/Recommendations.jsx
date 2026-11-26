import { useState } from 'react'
import { usePageData } from '../lib/pageCache'
import { useNavigate, useOutletContext } from 'react-router-dom'
import {
  ResponsiveContainer, ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts'
import {
  Sparkles, RefreshCw, IndianRupee, Leaf, ListChecks, CheckCircle2, Droplets, Wrench, Cpu, CalendarClock,
  AlarmClock, Thermometer, BatteryCharging, ChevronDown, ChevronUp, Check, X, Gauge,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import {
  TYPE_LABELS, approveLabel, approveRecommendation, dismissRecommendation, fetchRecommendations, refreshRecommendations,
} from '../lib/recommendationsData'
import { taskImpact } from '../lib/maintenanceData'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const inr = (n) => `₹ ${num(n)}`
const dayLabel = (iso) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '—')
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }
const ICONS = { cleaning: Droplets, anomaly: Wrench, sensor: Gauge, schedule: CalendarClock, reminder: AlarmClock, cooling: Thermometer, battery: BatteryCharging }

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

function BatteryChart({ plan }) {
  const data = plan.hours.filter((h) => h.hour >= 5 && h.hour <= 23).map((h) => ({
    label: `${String(h.hour).padStart(2, '0')}:00`,
    without: Math.round(h.gen_kw / 100) / 10, with: Math.round(h.export_kw / 100) / 10, soc: Math.round(h.soc_kwh / 100) / 10,
  }))
  return (
    <ResponsiveContainer width="100%" height={230}>
      <ComposedChart data={data} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
        <CartesianGrid stroke="#e8edf3" vertical={false} />
        <XAxis dataKey="label" {...axis} interval={2} />
        <YAxis yAxisId="p" {...axis} unit=" MW" width={60} />
        <YAxis yAxisId="e" orientation="right" {...axis} unit=" MWh" width={64} />
        <Tooltip formatter={(v, name) => [`${num(v, 1)} ${name === 'Battery charge' ? 'MWh' : 'MW'}`, name]} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Area yAxisId="e" dataKey="soc" name="Battery charge" fill="#fde68a" stroke="#f59e0b" fillOpacity={0.5} />
        <Line yAxisId="p" dataKey="without" name="Export without battery" stroke="#94a3b8" strokeDasharray="5 4" dot={false} />
        <Line yAxisId="p" dataKey="with" name="Export with battery" stroke="#2563eb" strokeWidth={2} dot={false} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

function RecCard({ r, top, busy, onApprove, onDismiss }) {
  const [open, setOpen] = useState(top)
  const Icon = ICONS[r.type] ?? Sparkles
  const net = r.gain_inr - Math.max(r.cost_inr ?? 0, 0)
  return (
    <li className={`rec-card ${top ? 'top' : ''}`}>
      <div className="rec-head">
        <span className={`rec-icon ${r.type}`}><Icon size={20} /></span>
        <div className="rec-main">
          <div className="rec-title-row">
            {top && <span className="badge">Top recommendation</span>}
            <span className="chip">{TYPE_LABELS[r.type] ?? r.type}</span>
            <span className={`sev-tag ${r.priority}`}>{r.priority}</span>
          </div>
          <h3>{r.title}</h3>
          <p className="rec-summary" title={r.ai_summary ? `Original: ${r.summary}` : undefined}>
            {r.ai_summary || r.summary}
            {r.ai_summary && <span className="ai-tag"><Sparkles size={11} /> AI wording</span>}
          </p>
          <div className="rec-numbers">
            {r.gain_inr > 0 && <span><IndianRupee size={13} /> +{inr(r.gain_inr)}{r.gain_kwh > 0 && ` · ${num(r.gain_kwh / 1000, 1)} MWh`} <small>/ 30 days</small></span>}
            {r.cost_inr > 0 && <span>Cost {inr(r.cost_inr)}</span>}
            {r.cost_inr < 0 && <span className="good">Saves {inr(-r.cost_inr)}</span>}
            {r.water_l > 0 && <span><Droplets size={13} /> {num(r.water_l)} L</span>}
            {r.co2_kg > 0 && <span><Leaf size={13} /> {num(r.co2_kg / 1000, 1)} t CO₂</span>}
            {r.gain_inr > 0 && r.cost_inr > 0 && <span className={net > 0 ? 'good' : 'bad'}>Net {net > 0 ? '+' : ''}{inr(net)}</span>}
            {r.due_date && <span><CalendarClock size={13} /> {dayLabel(r.due_date)}</span>}
          </div>
          <div className="confidence">
            <span>Confidence {r.confidence}%</span>
            <div className="conf-bar"><div style={{ width: `${r.confidence}%` }} /></div>
          </div>
        </div>
      </div>
      {open && (
        <div className="rec-details">
          {r.evidence?.length > 0 && (
            <ul className="report-list">
              {r.evidence.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          {r.type === 'battery' && r.details?.plan && (
            <>
              <BatteryChart plan={r.details.plan} />
              <p className="data-note">
                Assumptions: {r.details.plan.assumptions.capacity_kwh / 1000} MWh / {r.details.plan.assumptions.power_kw / 1000} MW battery,
                {' '}{r.details.plan.assumptions.round_trip_eff * 100} % round trip, tariff ₹{r.details.plan.assumptions.tariff}/kWh with
                {' '}solar hours {r.details.plan.assumptions.solar_hours} and peak {r.details.plan.assumptions.peak_hours}. Optimised with linear programming.
              </p>
            </>
          )}
        </div>
      )}
      <div className="rec-actions-row">
        <button className="btn sm" onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {open ? 'Hide details' : 'Details'}
        </button>
        <span className="spacer" />
        <button className="btn sm" disabled={busy} onClick={() => onDismiss(r)}><X size={14} /> Dismiss</button>
        <button className="btn sm primary" disabled={busy} onClick={() => onApprove(r)}><Check size={14} /> {approveLabel(r)}</button>
      </div>
    </li>
  )
}

export default function Recommendations() {
  const { plant } = useOutletContext()
  const { dataVersion, notifyDataChanged } = usePlants()
  const navigate = useNavigate()
  const { data, error } = usePageData('recommendations', plant, dataVersion, fetchRecommendations)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', error: false })

  if (!plant) return null
  const open = data?.open ?? []
  const history = data?.history ?? []
  const tariff = plant.tariff_inr_per_kwh || 0
  const potential = open.reduce((s, r) => s + Math.max(0, r.gain_inr - Math.max(r.cost_inr ?? 0, 0)), 0)
  const co2 = open.reduce((s, r) => s + (r.co2_kg ?? 0), 0)
  const month = new Date().toISOString().slice(0, 7)
  const actedThisMonth = history.filter((r) => r.status !== 'dismissed' && r.updated_at.slice(0, 7) === month).length

  async function refresh() {
    setBusy(true)
    setMsg({ text: 'Rebuilding recommendations from the latest forecasts, anomalies, cleaning and battery models…', error: false })
    const res = await refreshRecommendations(plant.id)
    setBusy(false)
    setMsg(res.error ? { text: res.error, error: true } : { text: `${res.result.count} recommendation(s) ready.`, error: false })
    if (!res.error) notifyDataChanged()
  }

  async function approve(r) {
    setBusy(true)
    const res = await approveRecommendation(plant.id, r)
    setBusy(false)
    if (res.navigateTo) return navigate(res.navigateTo)
    setMsg(res.error ? { text: res.error, error: true } : { text: res.message, error: false })
    if (!res.error) notifyDataChanged()
  }

  async function dismiss(r) {
    const reason = window.prompt('Why dismiss this recommendation? (optional)', '')
    if (reason === null) return
    setBusy(true)
    const res = await dismissRecommendation(r, reason)
    setBusy(false)
    setMsg(res.error ? { text: res.error, error: true } : { text: 'Dismissed – it will not be suggested again for 7 days.', error: false })
    if (!res.error) notifyDataChanged()
  }

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon lime"><Sparkles size={26} /></span>
          <div>
            <h1>AI Recommendations</h1>
            <p className="muted-text">{plant.name} · ranked actions from the forecast, anomaly ML, soiling, panel camera and battery models</p>
          </div>
          <div className="profile-actions">
            <button className="btn sm primary" onClick={refresh} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh</button>
          </div>
        </div>
        {msg.text && <p className={`msg ${msg.error ? 'error' : ''}`}>{msg.text}</p>}
        {error && <p className="msg error">{error.includes('recommendations') ? 'Run 008_recommendations.sql in Supabase first.' : error}</p>}
      </section>

      <section className="kpis">
        <Stat icon={ListChecks} tone="blue" label="Open recommendations" value={num(open.length)}
          note={`${open.filter((r) => r.priority === 'high').length} high priority`} />
        <Stat icon={IndianRupee} tone="teal" label="Potential net gain" value={inr(potential)} note="next 30 days, after costs" />
        <Stat icon={Leaf} tone="green" label="CO₂ that could be avoided" value={`${num(co2 / 1000, 1)} t`} note="from the extra clean energy" />
        <Stat icon={CheckCircle2} tone="lime" label="Acted on this month" value={num(actedThisMonth)} note="approved or done" />
      </section>

      <section className="card">
        <div className="card-head"><h2>Recommended actions</h2></div>
        {!data && !error ? <p className="data-note">Loading…</p> : open.length === 0 ? (
          <p className="empty">No open recommendations. They are rebuilt after each upload – or press “Refresh”.</p>
        ) : (
          <ul className="rec-list">
            {open.map((r, i) => <RecCard key={r.id} r={r} top={i === 0} busy={busy} onApprove={approve} onDismiss={dismiss} />)}
          </ul>
        )}
        <p className="data-note">
          <Cpu size={13} /> How it works: each module (forecasting, anomaly detection, soiling and camera, battery
          optimisation) proposes actions with their expected gain, cost and confidence; they are ranked by
          (gain − cost) × confidence. Approving creates or moves a maintenance task, so the result can be measured later.
        </p>
      </section>

      {history.length > 0 && (
        <section className="card">
          <div className="card-head"><h2>History</h2></div>
          <div className="table-wrap">
            <table className="mini-table">
              <thead><tr><th>Recommendation</th><th>Status</th><th>Predicted (30 d)</th><th>Measured after the work</th><th>Updated</th></tr></thead>
              <tbody>
                {history.map((r) => {
                  const impact = r.task?.status === 'done' ? taskImpact(r.task, data.summaries, tariff) : null
                  return (
                    <tr key={r.id}>
                      <td className="file" title={r.title}>{r.title}</td>
                      <td><span className={`status-tag ${r.status === 'done' ? 'done' : ''}`}>{r.status}</span>{r.dismiss_reason && <small className="data-note"> · {r.dismiss_reason}</small>}</td>
                      <td>{r.gain_inr > 0 ? `+${inr(r.gain_inr)}` : '—'}</td>
                      <td>{!impact ? (r.status === 'approved' ? 'task in progress' : '—')
                        : impact.pending ? 'waiting for data'
                          : `${impact.changePct >= 0 ? '+' : ''}${num(impact.changePct, 1)} % output · ${impact.weeklyInr >= 0 ? '+' : ''}${inr(impact.weeklyInr * 30 / 7)} / 30 d`}</td>
                      <td>{dayLabel(r.updated_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
