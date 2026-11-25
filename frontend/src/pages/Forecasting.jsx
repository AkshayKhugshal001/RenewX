import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  ResponsiveContainer, ComposedChart, Area, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import { CloudSun, CalendarRange, TrendingDown, Target, RefreshCw, MapPin, Info, Upload } from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { fetchForecast } from '../lib/forecastData'
import { refreshForecast } from '../lib/api'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const dayLabel = (day, opts = { weekday: 'short', day: 'numeric', month: 'short' }) =>
  new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' })
const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }

const MODE = {
  live: { label: 'Live forecast', cls: 'done', text: 'Based on the weather forecast for the plant’s location.' },
  simulated: {
    label: 'Simulated forecast', cls: 'sim',
    text: 'The data is historical, so the days after it are forecast from the weather recorded then.',
  },
  none: { label: 'No forecast', cls: '', text: '' },
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

function ModelTable({ title, m }) {
  if (!m) return null
  const rows = Object.entries(m.candidates ?? {})
  return (
    <div>
      <h3 className="fc-sub">
        {title}: <b>{m.chosen}</b>
        <small> · {m.train_days} day{m.train_days === 1 ? '' : 's'} of data · PR {num(m.performance_ratio, 3)}</small>
      </h3>
      {rows.length === 0 ? (
        <p className="data-note">Not enough data to compare models yet – using the physics formula.</p>
      ) : (
        <div className="table-wrap">
          <table className="mini-table">
            <thead>
              <tr><th>Model</th><th>MAE (kW)</th><th>RMSE (kW)</th><th>R²</th><th>Daily energy error</th></tr>
            </thead>
            <tbody>
              {rows.map(([name, s]) => (
                <tr key={name} className={name === m.chosen ? 'chosen' : ''}>
                  <td>{name}{name === m.chosen && <span className="status-tag done">chosen</span>}</td>
                  <td>{num(s.mae_kw)}</td>
                  <td>{num(s.rmse_kw)}</td>
                  <td>{num(s.r2, 3)}</td>
                  <td>{s.daily_energy_error_pct == null ? '—' : `${num(s.daily_energy_error_pct, 1)} %`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function Forecasting() {
  const { plant } = useOutletContext()
  const { dataVersion, notifyDataChanged, openEditPlant, openUploadData } = usePlants()
  const key = `${plant?.id}:${dataVersion}`
  const [state, setState] = useState({ key: null, data: null, error: '' })
  const [picked, setPicked] = useState(null)
  const [refresh, setRefresh] = useState({ busy: false, error: '' })

  useEffect(() => {
    let cancelled = false
    fetchForecast(plant)
      .then((data) => !cancelled && setState({ key, data, error: '' }))
      .catch((e) => !cancelled && setState({ key, data: null, error: e.message || 'Could not load the forecast.' }))
    return () => { cancelled = true }
  }, [plant, key])

  async function handleRefresh() {
    setRefresh({ busy: true, error: '' })
    const res = await refreshForecast(plant.id)
    setRefresh({ busy: false, error: res.error ?? '' })
    if (!res.error) notifyDataChanged()
  }

  if (!plant) return null
  const loading = state.key !== key
  const data = loading ? null : state.data
  const error = loading ? '' : state.error
  const run = data?.run
  const mode = MODE[run?.mode] ?? MODE.none
  const hasCoords = plant.latitude != null && plant.longitude != null
  const days = data?.days ?? []
  const selected = days.find((d) => d.day === picked) ?? days[0]
  const next = days[0]
  const total = days.reduce((s, d) => s + d.mwh, 0)
  const da = run?.metrics?.day_ahead
  const testError = da?.candidates?.[da.chosen]?.daily_energy_error_pct

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon blue"><CloudSun size={26} /></span>
          <div>
            <h1>Forecasting</h1>
            <p className="muted-text">
              <MapPin size={14} /> {plant.location || plant.name}
              {hasCoords && <> · {num(plant.latitude, 4)}°, {num(plant.longitude, 4)}°</>}
              {run && <> · updated {when(run.created_at)}</>}
            </p>
          </div>
          {run && <span className={`status-tag ${mode.cls}`}>{mode.label}</span>}
          <div className="profile-actions">
            {!hasCoords && (
              <button className="btn sm" onClick={() => openEditPlant(plant)}><MapPin size={15} /> Set location</button>
            )}
            <button className="btn sm primary" onClick={handleRefresh} disabled={refresh.busy}>
              <RefreshCw size={15} className={refresh.busy ? 'spin' : ''} /> {refresh.busy ? 'Updating…' : 'Refresh forecast'}
            </button>
          </div>
        </div>
        {mode.text && <p className="data-note">{mode.text}</p>}
        {run?.notes?.length > 0 && (
          <div className="report-list warn">
            <strong><Info size={14} /> Notes</strong>
            <ul>{run.notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </div>
        )}
        {refresh.busy && <p className="msg">Downloading weather and training the models… this can take up to a minute.</p>}
        {refresh.error && <p className="msg error">{refresh.error}</p>}
        {error && <p className="msg error">{error}</p>}
        {!loading && !run && !error && (
          <p className="msg">
            No forecast yet. {hasCoords ? 'Press “Refresh forecast”, or upload data.' : 'Set the plant’s location first, then press “Refresh forecast”.'}
          </p>
        )}
      </section>

      <section className="kpis">
        <Stat icon={CloudSun} tone="blue" label={next ? `Next day · ${dayLabel(next.day)}` : 'Next day'}
          value={next ? `${num(next.mwh, 1)} MWh` : '—'}
          note={next ? `likely ${num(next.lowerMwh, 1)} – ${num(next.upperMwh, 1)} MWh` : 'no forecast yet'} />
        <Stat icon={CalendarRange} tone="lime" label={`Next ${days.length || 7} days`}
          value={days.length ? `${num(total, 1)} MWh` : '—'}
          note={days.length ? `${dayLabel(days[0].day)} – ${dayLabel(days.at(-1).day)}` : ''} />
        <Stat icon={TrendingDown} tone="gray" label="Hidden loss (expected − actual)"
          value={data?.recentDays ? `${num(data.hiddenLossKwh / 1000, 1)} MWh` : '—'}
          note={data?.recentDays ? `last ${data.recentDays} days of data` : 'needs uploaded data'} />
        <Stat icon={Target} tone="green" label="Day-ahead accuracy"
          value={testError != null ? `±${num(testError, 1)} %` : '—'}
          note={testError != null ? 'average daily energy error on held-out test days' : 'needs 5+ days of data'} />
      </section>

      {days.length > 0 && (
        <section className="row row-fc">
          <div className="card">
            <div className="card-head">
              <h2>Daily forecast</h2>
              <small className="data-note">click a day for its hourly curve</small>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={days} margin={{ top: 8, right: 0, left: -8, bottom: 0 }}
                onClick={(e) => e?.activeLabel && setPicked(e.activeLabel)}>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { weekday: 'short', day: 'numeric' })} />
                <YAxis yAxisId="e" {...axis} unit=" MWh" width={72} />
                <YAxis yAxisId="c" orientation="right" {...axis} unit="%" domain={[0, 100]} width={44} />
                <Tooltip
                  labelFormatter={(d) => dayLabel(d)}
                  formatter={(v, name, item) =>
                    name === 'Energy'
                      ? [`${num(v, 1)} MWh (${num(item.payload.lowerMwh, 1)} – ${num(item.payload.upperMwh, 1)})`, name]
                      : [`${v} %`, name]}
                />
                <Bar yAxisId="e" dataKey="mwh" name="Energy" radius={[5, 5, 0, 0]} cursor="pointer"
                  fill="#60a5fa" />
                <Line yAxisId="c" dataKey="cloudPct" name="Cloud cover (daytime)" stroke="#94a3b8" strokeWidth={2} dot={{ r: 3 }} />
              </ComposedChart>
            </ResponsiveContainer>
            <ul className="fc-days">
              {days.map((d) => (
                <li key={d.day}>
                  <button className={d.day === selected?.day ? 'on' : ''} onClick={() => setPicked(d.day)}>
                    <small>{dayLabel(d.day, { weekday: 'short', day: 'numeric' })}</small>
                    <b>{num(d.mwh, 1)}</b>
                    <small>{d.maxTempC != null ? `${d.maxTempC}°C` : ''}{d.rainMm > 0 ? ` · ${num(d.rainMm, 1)} mm` : ''}</small>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Hourly · {selected && dayLabel(selected.day)}</h2>
            </div>
            <div className="legend">
              <span><i className="sw" style={{ borderColor: '#2563eb' }} /> Forecast</span>
              <span><i className="sw bar" style={{ background: '#bfdbfe' }} /> Likely range</span>
            </div>
            <ResponsiveContainer width="100%" height={270}>
              <ComposedChart data={selected?.hours.filter((h) => h.hour >= 5 && h.hour <= 19)}
                margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="label" {...axis} interval={2} />
                <YAxis {...axis} unit=" MW" width={64} />
                <Tooltip formatter={(v, name) =>
                  name === 'Likely range' ? [`${num(v[0], 2)} – ${num(v[1], 2)} MW`, name] : [`${num(v, 2)} MW`, name]} />
                <Area dataKey="band" name="Likely range" stroke="none" fill="#bfdbfe" fillOpacity={0.8} />
                <Line dataKey="mw" name="Forecast" stroke="#2563eb" strokeWidth={2.5} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      {data?.accuracy?.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Recent days: actual vs forecast</h2>
            <button className="btn sm" onClick={() => openUploadData(plant)}><Upload size={15} /> Upload today’s data</button>
          </div>
          <div className="legend">
            <span><i className="sw bar" /> Actual</span>
            <span><i className="sw dashed" style={{ borderColor: '#0f766e' }} /> Expected (from plant sensor)</span>
            <span><i className="sw dashed" /> Day-ahead forecast</span>
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={data.accuracy} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="#e8edf3" vertical={false} />
              <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} />
              <YAxis {...axis} unit=" MWh" width={72} />
              <Tooltip labelFormatter={(d) => dayLabel(d)} formatter={(v, name) => [v == null ? '—' : `${num(v, 1)} MWh`, name]} />
              <Bar dataKey="actualMwh" name="Actual" fill="#86efac" radius={[4, 4, 0, 0]} />
              <Line dataKey="expectedMwh" name="Expected" stroke="#0f766e" strokeWidth={2} strokeDasharray="6 4" dot={{ r: 3 }} />
              <Line dataKey="dayAheadMwh" name="Day-ahead forecast" stroke="#2563eb" strokeWidth={2} strokeDasharray="2 3" dot={{ r: 3 }} connectNulls={false} />
            </ComposedChart>
          </ResponsiveContainer>
          <p className="data-note">
            Expected = what the plant should have produced given the sunlight its own sensor measured; a gap below it
            points to losses (soiling, faults, outages). Day-ahead = the forecast issued before the day
            {data.comparedDays > 0 && <> – measured error on these {data.comparedDays} days: <b>±{num(data.measuredErrorPct, 1)} %</b></>}.
          </p>
        </section>
      )}

      {run?.metrics && Object.keys(run.metrics).length > 0 && (
        <section className="card">
          <h2>Models</h2>
          <p className="data-note">
            Each time data is added, three models are trained and tested on the most recent days they did not see.
            The most accurate one is used.
          </p>
          <div className="fc-models">
            <ModelTable title="Expected generation (plant sensor, 15-min)" m={run.metrics.expected} />
            <ModelTable title="Day-ahead (weather forecast, hourly)" m={run.metrics.day_ahead} />
          </div>
        </section>
      )}
    </div>
  )
}
