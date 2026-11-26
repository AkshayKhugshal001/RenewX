import { useOutletContext } from 'react-router-dom'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts'
import {
  Zap, IndianRupee, Leaf, Gauge, Activity, Database, MapPin, Factory, Upload,
  TrendingUp, TrendingDown, AlertTriangle, Thermometer, Cpu,
} from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { fetchPlantOverview, ALARM_LABELS } from '../lib/plantOverviewData'
import { usePageData } from '../lib/pageCache'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const inr = (n) => `₹ ${num(n)}`
const dayLabel = (day, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  day ? new Date(`${day}T12:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' }) : '—'
const when = (iso) =>
  new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }

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

function DayList({ rows }) {
  return (
    <ul className="metrics">
      {rows.map((r) => (
        <li key={r.day}>
          {dayLabel(r.day, { weekday: 'short', day: 'numeric', month: 'short' })}
          <span className="sub">{num(r.energy_kwh / 1000, 1)} MWh</span>
          <b>{num(r.performance_ratio * 100, 1)} %</b>
        </li>
      ))}
    </ul>
  )
}

export default function PlantOverview() {
  const { plant } = useOutletContext()
  const { dataVersion, openUploadData, openEditPlant } = usePlants()
  // cached per plant: shown instantly on revisits, refreshed in the background (lib/pageCache.js)
  const { data, error, loading } = usePageData('overview', plant, dataVersion, fetchPlantOverview)

  if (!plant) return null
  const t = data?.totals
  const hasCoords = plant.latitude != null && plant.longitude != null

  return (
    <div className="overview">
      {/* ── plant profile ───────────────────────────── */}
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon green"><Factory size={26} /></span>
          <div>
            <h1>{plant.name}</h1>
            <p className="muted-text">
              <MapPin size={14} /> {plant.location || 'No location set'}
              {hasCoords && <> · {num(plant.latitude, 4)}°, {num(plant.longitude, 4)}°</>}
            </p>
          </div>
          <div className="profile-actions">
            <button className="btn sm" onClick={() => openEditPlant(plant)}>Edit plant</button>
            <button className="btn sm primary" onClick={() => openUploadData(plant)}><Upload size={14} /> Upload data</button>
          </div>
        </div>
        <dl className="profile-facts">
          <div><dt>Capacity</dt><dd>{num(plant.capacity_mw, 2)} MW</dd></div>
          <div><dt>Inverters</dt><dd>{num(data?.inverters)}</dd></div>
          <div><dt>Tariff</dt><dd>₹ {num(plant.tariff_inr_per_kwh, 2)} / kWh</dd></div>
          <div><dt>Grid</dt><dd>{plant.grid_connected ? 'Connected' : 'Off-grid'}</dd></div>
          <div>
            <dt>Status</dt>
            <dd><i className={`dot ${plant.status === 'online' ? 'on' : 'off'}`} /> {plant.status === 'online' ? 'Online' : 'Offline'}</dd>
          </div>
          <div><dt>Data range</dt><dd>{data?.hasData ? `${dayLabel(data.firstDay)} – ${dayLabel(data.lastDay)}` : 'No data yet'}</dd></div>
        </dl>
        {plant.capacity_mw <= 0 && (
          <p className="msg error">Capacity is not set, so performance ratio cannot be calculated. Edit the plant to add it.</p>
        )}
        {!hasCoords && <p className="data-note">Add latitude and longitude to enable weather data for this plant.</p>}
      </section>

      {error && <p className="msg error">{error}</p>}
      {loading && <p className="empty">Loading plant history…</p>}

      {data && !data.hasData && (
        <div className="card empty-plants">
          <div>
            <h2>No data uploaded yet</h2>
            <p>Upload a CSV of historical readings to see this plant&apos;s long-term performance.</p>
          </div>
          <button className="btn primary" onClick={() => openUploadData(plant)}><Upload size={16} /> Upload data</button>
        </div>
      )}

      {data?.hasData && (
        <>
          {/* ── lifetime totals ─────────────────────── */}
          <section className="kpis">
            <Stat icon={Zap} tone="lime" label="Total Energy" value={`${num(t.energyKwh / 1000, 1)} MWh`}
              note={`${num(t.avgDailyKwh / 1000, 1)} MWh/day over ${data.dayCount} days`} />
            <Stat icon={IndianRupee} tone="teal" label="Total Revenue" value={inr(t.revenueInr)}
              note={plant.tariff_inr_per_kwh > 0 ? `at ₹ ${num(plant.tariff_inr_per_kwh, 2)}/kWh` : 'Set a tariff to calculate'} />
            <Stat icon={Leaf} tone="green" label="CO₂ Avoided" value={`${num(t.co2Kg / 1000, 1)} t`} note="vs. Indian grid average" />
            <Stat icon={Gauge} tone="blue" label="Avg Performance Ratio" value={t.avgPr == null ? '—' : `${num(t.avgPr * 100, 1)} %`}
              note={t.avgSpecificYield == null ? null : `${num(t.avgSpecificYield, 2)} kWh/kWp per day`} />
            <Stat icon={Activity} tone="gray" label="Avg Availability" value={`${num(t.avgAvailability, 1)} %`}
              note={`peak output ${num(t.peakKw / 1000, 1)} MW`} />
            <Stat icon={Database} tone="gray" label="Data Completeness" value={`${num(t.avgCompleteness, 1)} %`}
              note={data.lowDataDays ? `${data.lowDataDays} day(s) below 90 %` : 'all days ≥ 90 %'} />
          </section>

          {/* ── daily trend ─────────────────────────── */}
          <section className="card">
            <div className="card-head">
              <h2>Daily Energy &amp; Performance Ratio</h2>
              <div className="legend">
                <span><i className="sw bar" /> Energy (MWh)</span>
                <span><i className="sw dashed" /> Performance ratio (%)</span>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={data.trend} margin={{ top: 8, right: 4, left: -4, bottom: 0 }}>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} minTickGap={24} />
                <YAxis yAxisId="e" {...axis} width={56} unit=" MWh" />
                <YAxis yAxisId="pr" orientation="right" {...axis} width={48} unit="%" domain={[0, 100]} />
                <Tooltip
                  labelFormatter={(d) => dayLabel(d, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
                  formatter={(v, name) => [v == null ? '—' : name === 'Energy' ? `${num(v, 1)} MWh` : `${num(v, 1)} %`, name]}
                />
                <Bar yAxisId="e" dataKey="energy" name="Energy" fill="#86efac" radius={[4, 4, 0, 0]} />
                <Line yAxisId="pr" dataKey="pr" name="Performance ratio" stroke="#2563eb" strokeWidth={2} strokeDasharray="6 4" dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </section>

          {/* ── days, losses, alarms ───────────────── */}
          <section className="row row-ov">
            <div className="card">
              <h2><TrendingUp size={20} className="c-teal" /> Best days</h2>
              <p className="data-note">Highest performance ratio</p>
              {data.best.length ? <DayList rows={data.best} /> : <p className="empty">Set the capacity to rank days.</p>}
              <h2 className="mt"><TrendingDown size={20} className="c-red" /> Worst days</h2>
              <p className="data-note">Lowest performance ratio</p>
              {data.worst.length ? <DayList rows={data.worst} /> : <p className="empty">—</p>}
            </div>

            <div className="card">
              <h2>Losses (whole period)</h2>
              <ul className="metrics">
                <li><Thermometer size={18} className="c-red" /> Heat (module above 25 °C)
                  <span className="sub">{num(data.losses.thermalKwh / 1000, 1)} MWh</span><b>{num(data.losses.thermalPct, 1)} %</b></li>
                <li><Cpu size={18} className="c-blue" /> Inverter (DC → AC)
                  <span className="sub">{num(data.losses.inverterKwh / 1000, 1)} MWh</span><b>{num(data.losses.inverterPct, 1)} %</b></li>
                <li><Gauge size={18} className="c-teal" /> Avg inverter efficiency <b>{num(t.avgInverterEff, 1)} %</b></li>
              </ul>
              <p className="data-note">Percentages are shares of the energy the plant could have produced without that loss. Soiling and shading are added with the cleaning module.</p>
            </div>

            <div className="card">
              <h2><AlertTriangle size={20} className="c-amber" /> Alarms</h2>
              {data.alarmGroups.length === 0 ? (
                <p className="empty">No alarms found in this plant&apos;s data.</p>
              ) : (
                <ul className="metrics">
                  {data.alarmGroups.map((g) => (
                    <li key={g.type}>
                      {ALARM_LABELS[g.type] ?? g.type}
                      <span className="sub">
                        {g.open} open{g.high > 0 && <> · <span className="sev high">{g.high} high</span></>}
                        {g.energyLost > 0 && <> · {num(g.energyLost / 1000, 1)} MWh lost</>}
                      </span>
                      <b>{g.total}</b>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}

      {/* ── upload history ─────────────────────────── */}
      {data && data.uploads.length > 0 && (
        <section className="card">
          <h2>Upload history</h2>
          <div className="table-wrap">
            <table className="mini-table">
              <thead>
                <tr><th>When</th><th>File</th><th>Type</th><th>Period</th><th>New</th><th>Updated</th><th>Skipped</th><th>Rejected</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.uploads.map((u) => (
                  <tr key={u.id}>
                    <td>{when(u.created_at)}</td>
                    <td className="file" title={u.file_name}>{u.file_name}</td>
                    <td>{u.kind === 'daily' ? 'Daily' : 'Historical'}{u.mode === 'replace' ? ' (replace)' : ''}</td>
                    <td>{u.ts_from ? `${dayLabel(u.ts_from.slice(0, 10), { day: 'numeric', month: 'short' })} – ${dayLabel(u.ts_to.slice(0, 10), { day: 'numeric', month: 'short', year: 'numeric' })}` : '—'}</td>
                    <td>{num(u.rows_inserted)}</td>
                    <td>{num(u.rows_updated)}</td>
                    <td>{num(u.rows_skipped)}</td>
                    <td>{num(u.rows_rejected)}</td>
                    <td><span className={`status-tag ${u.status}`} title={u.error || ''}>{u.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  )
}
