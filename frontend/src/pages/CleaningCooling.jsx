import { useState } from 'react'
import { usePageData } from '../lib/pageCache'
import { Link, useOutletContext } from 'react-router-dom'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from 'recharts'
import {
  Sparkles as Brush, Droplets, Gauge, IndianRupee, CalendarClock, Thermometer, RefreshCw, Settings2, ClipboardPlus,
  CloudRain, Info, CheckCircle2, XCircle, MinusCircle, CircleDashed, Lightbulb,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { ACTIONS, COOLING, fetchCleaning, runCleaningAnalysis } from '../lib/cleaningData'
import { todayIso } from '../lib/maintenanceData'
import { TaskFormModal } from '../components/TaskModals'
import PanelCamera from '../components/PanelCamera'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const dayLabel = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' }) : '—'
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }
const RESET_TEXT = {
  rain: 'rain', cleaning: 'cleaning', gap: 'start after a data gap', start: 'start of data',
  jump: 'a jump in output (likely an unrecorded cleaning)',
}
const EVIDENCE_ICON = {
  supports: [CheckCircle2, 'c-green'], against: [XCircle, 'c-red'], neutral: [MinusCircle, 'c-gray'], missing: [CircleDashed, 'c-gray'],
}

function Evidence({ d }) {
  if (!d) return null
  return (
    <section className="card evidence">
      <div className="card-head">
        <h2>Why this recommendation</h2>
        <span className="score-pill">Cleaning score <b>{d.score}</b>/100</span>
      </div>
      <div className="score-bar" aria-hidden="true">
        <div className="score-fill" style={{ width: `${d.score}%` }} />
        <i style={{ left: '40%' }} /><i style={{ left: '70%' }} />
      </div>
      <div className="score-scale"><span>No cleaning</span><span>Plan cleaning (40+)</span><span>Clean now (70+)</span></div>
      <ul className="evidence-list">
        {d.evidence.map((e) => {
          const [Icon, cls] = EVIDENCE_ICON[e.status] ?? EVIDENCE_ICON.neutral
          return (
            <li key={e.key} className={e.status}>
              <Icon size={18} className={cls} />
              <div><strong>{e.label}</strong><p>{e.text}</p></div>
              {e.max > 0 && <span className="pts">{e.status === 'missing' ? '—' : `${e.points > 0 ? '+' : ''}${num(e.points, 1)}`} / {e.max}</span>}
            </li>
          )
        })}
      </ul>
      {d.side_actions?.length > 0 && (
        <div className="report-list warn">
          <strong><Lightbulb size={14} /> Also</strong>
          <ul>{d.side_actions.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
      )}
      <p className="data-note">
        Score = points ÷ points available × 100 ({d.signals_used} available). Missing signals (e.g. no camera image) are
        left out, so the decision also works from the data alone. Heavy rain in the forecast postpones any cleaning.
      </p>
    </section>
  )
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

function CoolingCard({ title, c }) {
  if (!c) return null
  return (
    <div className="cool-case">
      <div className="cool-head">
        <strong>{title}</strong>
        <span className={`status-tag ${c.verdict === 'recommended' ? 'done' : ''}`}>{COOLING[c.verdict] ?? c.verdict}</span>
      </div>
      <p className="data-note">{c.reason}</p>
      {c.hot_hours_per_day > 0 && (
        <dl className="facts">
          <div><dt>Modules above 45 °C</dt><dd>{num(c.hot_hours_per_day, 1)} h/day{c.window ? ` (${c.window})` : ''}</dd></div>
          <div><dt>Peak module temperature</dt><dd>{num(c.peak_module_temp_c, 1)} °C</dd></div>
          <div><dt>Gain from cooling</dt><dd>{num(c.gain_kwh_per_day)} kWh · ₹ {num(c.gain_inr_per_day)} /day</dd></div>
          <div><dt>Water needed</dt><dd>{num(c.water_l_per_day)} L · ₹ {num(c.water_cost_inr_per_day)} /day</dd></div>
        </dl>
      )}
    </div>
  )
}

export default function CleaningCooling() {
  const { plant } = useOutletContext()
  const { dataVersion, notifyDataChanged, openEditPlant } = usePlants()
  const { data, error } = usePageData('cleaning', plant, dataVersion, fetchCleaning)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', error: false })
  const [taskPreset, setTaskPreset] = useState(null)

  if (!plant) return null
  const a = data?.analysis
  const r = a?.result ?? {}
  const plan = r.plan ?? {}
  const decision = r.decision ?? null
  const rate = r.rate ?? {}
  const act = ACTIONS[a?.action] ?? null
  const cleaningsDone = (data?.cleanings ?? []).filter((t) => t.status === 'done')
  const month = todayIso().slice(0, 7)
  const waterThisMonth = cleaningsDone.filter((t) => t.completed_at?.slice(0, 7) === month)
    .reduce((s, t) => s + Number(t.water_litres ?? 0), 0)
  const openCleaning = (data?.cleanings ?? []).find((t) => t.status === 'planned' || t.status === 'in_progress')

  async function refresh() {
    setBusy(true)
    setMsg({ text: 'Analysing soiling, cleaning and cooling…', error: false })
    const res = await runCleaningAnalysis(plant.id)
    setBusy(false)
    if (res.error) return setMsg({ text: res.error, error: true })
    setMsg({ text: '', error: false })
    notifyDataChanged()
  }

  function planCleaning() {
    setTaskPreset({
      title: 'Module cleaning (whole plant)',
      category: 'cleaning',
      priority: a?.action === 'clean_now' ? 'high' : 'medium',
      due_date: a?.due_date && a.due_date >= todayIso() ? a.due_date : todayIso(),
      est_cost_inr: r.cleaning?.cost_inr ?? '',
      notes: decision?.reason ?? plan.reason ?? '',
      source: 'manual',
    })
  }

  // chart: cleanliness (measured, clear days) vs modelled soiling loss
  const chart = (data?.days ?? []).map((d) => ({
    day: d.day,
    index: d.cleanliness_index == null ? null : Math.round(d.cleanliness_index * 1000) / 10,
    clean: d.soiling_loss_pct == null ? null : Math.round((100 - d.soiling_loss_pct) * 10) / 10,
  }))
  const resets = (r.resets ?? []).filter((x) => chart.some((c) => c.day === x.day))
  const thermal = (data?.days ?? []).slice(-30).map((d) => ({ day: d.day, kwh: Math.round(d.thermal_loss_kwh ?? 0) }))

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon blue"><Droplets size={26} /></span>
          <div>
            <h1>Cleaning &amp; Cooling</h1>
            <p className="muted-text">
              {plant.name} · soiling from actual vs expected output, rain and cleanings
              {a && <> · data up to {dayLabel(a.as_of)}</>}
            </p>
          </div>
          <div className="profile-actions">
            <button className="btn sm" onClick={() => openEditPlant(plant)}><Settings2 size={15} /> Cleaning costs</button>
            <button className="btn sm primary" onClick={refresh} disabled={busy}>
              <RefreshCw size={15} className={busy ? 'spin' : ''} /> Refresh analysis
            </button>
          </div>
        </div>
        {msg.text && <p className={`msg ${msg.error ? 'error' : ''}`}>{msg.text}</p>}
        {error && <p className="msg error">{error}</p>}
        {data && !a && (
          <p className="msg">No analysis yet. It runs after each upload – or press “Refresh analysis”.</p>
        )}
      </section>

      {a && act && (
        <section className={`card verdict ${act.tone}`}>
          <div className="verdict-main">
            <span className="verdict-icon">{a.action === 'wait_rain' ? <CloudRain size={28} /> : <Brush size={28} />}</span>
            <div>
              <p className="verdict-label">Recommendation</p>
              <h2>
                {act.label}
                {a.due_date && a.action !== 'not_needed' && <small> · {a.action === 'clean_now' ? 'by' : 'on'} {dayLabel(a.due_date)}</small>}
              </h2>
              <p>{decision?.reason ?? plan.reason}</p>
            </div>
          </div>
          <div className="verdict-actions">
            {openCleaning ? (
              <Link className="btn sm" to="/maintenance?tab=tasks">Cleaning planned for {dayLabel(openCleaning.due_date)}</Link>
            ) : a.action !== 'not_needed' && (
              <button className="btn sm primary" onClick={planCleaning}><ClipboardPlus size={15} /> Plan cleaning task</button>
            )}
          </div>
        </section>
      )}

      <Evidence d={decision} />

      {a && (
        <section className="kpis">
          <Stat icon={Gauge} tone="lime" label="Soiling loss now" value={`${num(a.loss_pct, 1)} %`}
            note={`${a.days_since_reset} days since ${RESET_TEXT[a.last_reset_reason] ?? a.last_reset_reason} (${dayLabel(a.last_reset, { day: 'numeric', month: 'short' })})`} />
          <Stat icon={CalendarClock} tone="blue" label="Soiling rate" value={`${num(a.rate_pct_per_day, 2)} %/day`}
            note={rate.source === 'assumed' ? 'assumed (not enough clear days to measure)'
              : rate.confidence === 'high' ? `measured · confirmed by +${num(rate.recovery?.observed_pct, 1)} % after rain/cleaning`
                : rate.confidence === 'low' ? 'measured · low confidence: no clear jump after rain' : 'measured'} />
          <Stat icon={IndianRupee} tone="teal" label="Cost of dirt" value={`₹ ${num(plan.daily_loss_inr)} /day`}
            note={`₹ ${num(plan.lost_since_reset_inr)} lost since last clean`} />
          <Stat icon={Droplets} tone="gray" label="One cleaning"
            value={`₹ ${num(r.cleaning?.cost_inr)}`}
            note={`${num(r.cleaning?.water_l)} L water · pays off every ${a.optimal_interval_days ? `${num(a.optimal_interval_days)} days` : '—'}`} />
        </section>
      )}

      {a && (
        <section className="row row-fc">
          <div className="card">
            <div className="card-head"><h2>Panel cleanliness</h2></div>
            <div className="legend">
              <span><i className="sw dot" /> Measured (clear days)</span>
              <span><i className="sw" /> Modelled (100 % − soiling loss)</span>
              <span><i className="sw dashed" style={{ borderColor: '#0ea5e9' }} /> Rain / cleaning</span>
            </div>
            <ResponsiveContainer width="100%" height={250}>
              <ComposedChart data={chart} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} interval="preserveStartEnd" />
                <YAxis {...axis} unit="%" width={52} domain={[(min) => Math.floor(Math.min(min, 90)), (max) => Math.ceil(Math.max(max, 102))]} />
                <Tooltip labelFormatter={(d) => dayLabel(d)} formatter={(v, name) => [v == null ? '—' : `${num(v, 1)} %`, name]} />
                {resets.map((x) => <ReferenceLine key={x.day} x={x.day} stroke="#0ea5e9" strokeDasharray="4 4" />)}
                <Line dataKey="clean" name="Modelled" stroke="#16a34a" strokeWidth={2} dot={false} />
                <Scatter dataKey="index" name="Measured" fill="#2563eb" />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="data-note">
              Measured = actual ÷ expected energy on clear days. Dust makes it drift down; rain (≥ 5 mm) or a cleaning
              resets it. The slope of that drift is the soiling rate.
            </p>
          </div>

          <div className="card">
            <div className="card-head"><h2>Next days</h2></div>
            {plan.projection?.length ? (
              <>
                <ResponsiveContainer width="100%" height={250}>
                  <ComposedChart data={plan.projection} margin={{ top: 8, right: 0, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke="#e8edf3" vertical={false} />
                    <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { weekday: 'short', day: 'numeric' })} />
                    <YAxis yAxisId="l" {...axis} unit="%" width={44} />
                    <YAxis yAxisId="r" orientation="right" {...axis} unit=" mm" width={52} />
                    <Tooltip labelFormatter={(d) => dayLabel(d)}
                      formatter={(v, name, item) => (name === 'Rain' ? [`${v} mm`, name]
                        : [`${num(v, 1)} % (₹ ${num(item.payload.loss_inr)})`, name])} />
                    <Bar yAxisId="r" dataKey="rain_mm" name="Rain" fill="#7dd3fc" radius={[4, 4, 0, 0]} />
                    <Line yAxisId="l" dataKey="loss_pct" name="Soiling loss" stroke="#f59e0b" strokeWidth={2.5} dot={{ r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="data-note">Projected soiling loss if nothing is cleaned, with forecast rain (from the Forecasting module).</p>
              </>
            ) : <p className="empty">Set the plant’s location to get the 7-day rain forecast.</p>}
          </div>
        </section>
      )}

      {data && <PanelCamera plant={plant} analysis={a} dataVersion={dataVersion} onChanged={notifyDataChanged} />}

      {r.cooling && (
        <section className="card">
          <div className="card-head"><h2><Thermometer size={18} className="c-red" /> Cooling</h2></div>
          <div className="cool-grid">
            <CoolingCard title={`Recent days (${r.cooling.days} day${r.cooling.days === 1 ? '' : 's'})`} c={r.cooling} />
            <CoolingCard title={`Hottest 2 weeks in the data${r.cooling.peak?.period ? ` (${r.cooling.peak.period})` : ''}`} c={r.cooling.peak} />
          </div>
          {thermal.some((t) => t.kwh > 0) && (
            <>
              <h3 className="fc-sub mt">Energy lost to heat per day (last {thermal.length} days of data)</h3>
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={thermal} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke="#e8edf3" vertical={false} />
                  <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} interval="preserveStartEnd" />
                  <YAxis {...axis} unit=" kWh" width={78} />
                  <Tooltip labelFormatter={(d) => dayLabel(d)} formatter={(v) => [`${num(v)} kWh`, 'Thermal loss']} />
                  <Bar dataKey="kwh" fill="#fca5a5" radius={[4, 4, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </>
          )}
          <p className="data-note">
            <Info size={13} /> Assumptions: spraying cools modules by {r.cooling.assumptions?.cooling_c} °C when they exceed{' '}
            {r.cooling.assumptions?.from_c} °C, uses {num(r.cooling.assumptions?.water_l_per_mw_h)} L per MW per hour, water
            costs ₹ {r.cooling.assumptions?.water_inr_per_kl} per 1000 L, output drops {r.cooling.assumptions?.temp_coeff_pct} % per °C.
          </p>
        </section>
      )}

      {a && (
        <section className="card">
          <div className="card-head">
            <h2>Cleaning history</h2>
            <small className="data-note">{waterThisMonth ? `${num(waterThisMonth)} L water used this month` : ''}</small>
          </div>
          {cleaningsDone.length === 0 ? (
            <p className="empty">No cleanings recorded yet. Mark a cleaning task done in Maintenance (with the water used) and the soiling estimate resets from that day.</p>
          ) : (
            <div className="table-wrap">
              <table className="mini-table">
                <thead><tr><th>Done on</th><th>Task</th><th>Water</th><th>Cost</th></tr></thead>
                <tbody>
                  {cleaningsDone.map((t) => (
                    <tr key={t.id}>
                      <td>{dayLabel(t.completed_at?.slice(0, 10))}</td>
                      <td>{t.title}</td>
                      <td>{t.water_litres != null ? `${num(t.water_litres)} L` : '—'}</td>
                      <td>{t.actual_cost_inr != null ? `₹ ${num(t.actual_cost_inr)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {taskPreset && (
        <TaskFormModal plantId={plant.id} preset={taskPreset} onClose={() => setTaskPreset(null)}
          onSaved={() => { setTaskPreset(null); setMsg({ text: 'Cleaning task created – see Maintenance → Maintenance tasks.', error: false }); notifyDataChanged() }} />
      )}
    </div>
  )
}
