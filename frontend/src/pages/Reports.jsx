import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { FileText, Download, CalendarRange, Sparkles, CheckCircle2 } from 'lucide-react'
import { supabase } from '../lib/supabaseClient'
import { apiDownload } from '../lib/api'
import { assistantStatus } from '../lib/assistant'

const fmt = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const lastDay = (ym) => {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

const KINDS = {
  performance: {
    label: 'Performance report',
    contents: ['Summary KPIs (energy, revenue, output vs expected, PR, availability, CO₂)', 'Daily energy vs expected chart',
      'Loss breakdown (heat, inverter, soiling)', 'Forecast accuracy', 'Anomalies', 'Maintenance work and costs',
      'Cleaning & soiling', 'AI recommendations', 'Environmental impact'],
  },
  maintenance: {
    label: 'Maintenance report',
    contents: ['Anomalies in the period', 'Maintenance completed with costs and water', 'Open and overdue tasks',
      'Cleaning & soiling status', 'AI recommendations', 'Environmental impact'],
  },
}

export default function Reports() {
  const { plant } = useOutletContext()
  const [months, setMonths] = useState({ plantId: null, list: [] })   // 'YYYY-MM' with data, newest first
  const [kind, setKind] = useState('performance')
  const [mode, setMode] = useState('month')                           // month | custom
  const [month, setMonth] = useState('')
  const [range, setRange] = useState({ start: '', end: '' })
  const [ai, setAi] = useState({ available: false, on: false })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState({ text: '', error: false })
  const [done, setDone] = useState([])

  useEffect(() => {
    if (!plant?.id) return undefined
    let cancelled = false
    supabase.from('daily_summaries').select('day').eq('plant_id', plant.id).order('day', { ascending: false }).limit(2000)
      .then(({ data }) => {
        if (cancelled) return
        const list = [...new Set((data ?? []).map((d) => d.day.slice(0, 7)))]
        setMonths({ plantId: plant.id, list })
        setMonth(list[0] ?? '')
        const days = (data ?? []).map((d) => d.day)
        setRange({ start: days.at(-1) ?? '', end: days[0] ?? '' })
      })
    return () => { cancelled = true }
  }, [plant])

  useEffect(() => {
    let cancelled = false
    assistantStatus().then((r) => !cancelled && setAi({ available: Boolean(r.result?.enabled), on: Boolean(r.result?.enabled) }))
    return () => { cancelled = true }
  }, [])

  if (!plant) return null
  const list = months.plantId === plant.id ? months.list : []
  const start = mode === 'month' ? (month ? `${month}-01` : '') : range.start
  const end = mode === 'month' ? (month ? lastDay(month) : '') : range.end
  const valid = start && end && start <= end

  async function download() {
    setBusy(true)
    setMsg({ text: `Creating the PDF${ai.on ? ' with an AI summary' : ''}… this can take a few seconds.`, error: false })
    const safe = plant.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')
    const file = `RenewX_${safe}_${kind}_${start}_${end}.pdf`
    const q = new URLSearchParams({ start, end, kind, ai_summary: String(ai.on) })
    const res = await apiDownload(`/plants/${plant.id}/reports/pdf?${q}`, file)
    setBusy(false)
    if (res.error) return setMsg({ text: res.error, error: true })
    setMsg({ text: `Downloaded ${file}`, error: false })
    setDone((d) => [{ file, at: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) }, ...d].slice(0, 5))
  }

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon blue"><FileText size={26} /></span>
          <div>
            <h1>Reports</h1>
            <p className="muted-text">{plant.name} · downloadable PDF reports for any period</p>
          </div>
        </div>
      </section>

      <section className="row row-fc">
        <div className="card report-form">
          <h2>Create a report</h2>
          <div className="field">Report type
            <div className="seg" role="radiogroup">
              {Object.entries(KINDS).map(([k, v]) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{v.label}</button>
              ))}
            </div>
          </div>
          <div className="field">Period
            <div className="seg" role="radiogroup">
              <button type="button" role="radio" aria-checked={mode === 'month'} className={mode === 'month' ? 'on' : ''} onClick={() => setMode('month')}>Month</button>
              <button type="button" role="radio" aria-checked={mode === 'custom'} className={mode === 'custom' ? 'on' : ''} onClick={() => setMode('custom')}>Custom dates</button>
            </div>
          </div>
          {mode === 'month' ? (
            <label className="field">Month
              {list.length ? (
                <select value={month} onChange={(e) => setMonth(e.target.value)}>
                  {list.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
                </select>
              ) : <span className="hint">No data uploaded yet.</span>}
            </label>
          ) : (
            <div className="field-row">
              <label className="field">From<input type="date" value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} /></label>
              <label className="field">To<input type="date" value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} /></label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={ai.on} disabled={!ai.available} onChange={(e) => setAi((a) => ({ ...a, on: e.target.checked }))} />
            <Sparkles size={14} /> Add an AI executive summary {ai.available ? '(Gemini, checked against the report figures)' : '(AI assistant not configured)'}
          </label>
          {valid && <p className="data-note"><CalendarRange size={13} /> {fmt(start)} – {fmt(end)}</p>}
          {!valid && mode === 'custom' && <p className="msg error">Choose a start date before the end date.</p>}
          {msg.text && <p className={`msg ${msg.error ? 'error' : ''}`}>{msg.text}</p>}
          <button className="btn primary" onClick={download} disabled={busy || !valid}>
            <Download size={16} /> {busy ? 'Creating PDF…' : 'Download PDF'}
          </button>
          {done.length > 0 && (
            <ul className="report-done">
              {done.map((d) => <li key={d.file + d.at}><CheckCircle2 size={14} className="c-green" /> {d.file} <small>{d.at}</small></li>)}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>What’s in the {KINDS[kind].label.toLowerCase()}</h2>
          <ul className="report-contents">
            {KINDS[kind].contents.map((c) => <li key={c}><CheckCircle2 size={15} className="c-green" /> {c}</li>)}
          </ul>
          <p className="data-note">
            A4 PDF with charts and tables, generated on the server from the plant’s stored data (the same numbers as
            the app). Money values use the plant tariff; figures from models are estimates. The optional AI summary is
            only kept if every number in it matches the report.
          </p>
        </div>
      </section>
    </div>
  )
}
