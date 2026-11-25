import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend } from 'recharts'
import { Leaf, Trees, Car, Home, Factory, Droplets, Info, CloudRain } from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { apiGet } from '../lib/api'

const num = (n, d = 0) => (n == null ? '—' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }))
const dayLabel = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  iso ? new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' }) : '—'
const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }
const tonnes = (kg) => (kg >= 1000 ? `${num(kg / 1000, 1)} t` : `${num(kg)} kg`)

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

export default function Environment() {
  const { plant } = useOutletContext()
  const { dataVersion } = usePlants()
  const key = `${plant?.id}:${dataVersion}`
  const [state, setState] = useState({ key: null, plantId: null, data: null, error: '' })

  useEffect(() => {
    if (!plant?.id) return undefined
    let cancelled = false
    apiGet(`/plants/${plant.id}/environment`).then((res) => {
      if (!cancelled) setState({ key, plantId: plant.id, data: res.result ?? null, error: res.error ?? '' })
    })
    return () => { cancelled = true }
  }, [plant, key])

  if (!plant) return null
  const loading = state.key !== key
  const e = state.plantId === plant.id ? state.data : null
  const t = e?.total
  const ind = e?.indicator
  const daily = (e?.daily ?? []).map((d) => ({ ...d, co2_t: Math.round(d.co2_kg / 100) / 10 }))

  return (
    <div className="overview">
      <section className="card profile">
        <div className="profile-main">
          <span className="kpi-icon green"><Leaf size={26} /></span>
          <div>
            <h1>Environment</h1>
            <p className="muted-text">
              {plant.name} · climate benefit, water use and site conditions
              {e?.has_data && <> · {dayLabel(e.first_day)} – {dayLabel(e.last_day)} ({e.days} days of data)</>}
            </p>
          </div>
          {ind && <span className={`eco-badge ${ind.level.toLowerCase()}`}>Ecological indicator: {ind.level}</span>}
        </div>
        {state.error && <p className="msg error">{state.error}</p>}
        {loading && <p className="data-note">Loading…</p>}
        {!loading && e && !e.has_data && <p className="msg">No data yet – upload a CSV to see the environmental impact.</p>}
      </section>

      {t && (
        <>
          <section className="kpis">
            <Stat icon={Leaf} tone="green" label="CO₂ avoided" value={tonnes(t.co2_kg)}
              note={`${num(t.energy_kwh / 1000, 1)} MWh of clean energy · latest day ${tonnes(e.latest.co2_kg)}`} />
            <Stat icon={Trees} tone="lime" label="Equal to trees" value={num(t.trees)} note="absorbing CO₂ for one year" />
            <Stat icon={Car} tone="gray" label="Equal to cars" value={num(t.cars, 1)} note="driven for one year" />
            <Stat icon={Home} tone="blue" label="Homes powered" value={num(t.homes)} note={`for the ${t.days} days of data`} />
            <Stat icon={Factory} tone="gray" label="Coal not burned" value={tonnes(t.coal_kg)} note="in coal power plants" />
            <Stat icon={Droplets} tone="teal" label="Water for cleaning" value={`${num(e.water.total_l)} L`}
              note={`${num(e.water.per_mwh, 1)} L per MWh · ${e.water.cleanings} cleaning(s)`} />
          </section>

          <section className="row row-fc">
            <div className="card">
              <div className="card-head"><h2>CO₂ avoided per day</h2></div>
              <ResponsiveContainer width="100%" height={250}>
                <ComposedChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke="#e8edf3" vertical={false} />
                  <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} interval="preserveStartEnd" />
                  <YAxis {...axis} unit=" t" width={52} />
                  <Tooltip labelFormatter={(d) => dayLabel(d)} formatter={(v) => [`${num(v, 1)} t CO₂`, 'Avoided']} />
                  <Bar dataKey="co2_t" fill="#86efac" radius={[4, 4, 0, 0]} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            <div className="card">
              <div className="card-head"><h2><Droplets size={18} className="c-blue" /> Water</h2></div>
              <dl className="facts">
                <div><dt>Used for cleaning</dt><dd>{num(e.water.total_l)} L</dd></div>
                <div><dt>Per MWh produced</dt><dd>{num(e.water.per_mwh, 1)} L</dd></div>
                <div><dt>Cleanings</dt><dd>{e.water.cleanings}</dd></div>
                <div><dt>Saved by waiting for rain</dt><dd>{num(e.water.saved_by_rain_l)} L</dd></div>
              </dl>
              <div className={`eco-box ${ind.level.toLowerCase()}`}>
                <strong>Ecological indicator: {ind.level}</strong>
                <p>{ind.reason}</p>
              </div>
              <p className="data-note">Water use comes from cleaning tasks marked done (with the water used). Cooling is
                recommended only when it pays off, so it adds no water unless approved.</p>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><h2><CloudRain size={18} className="c-blue" /> Site conditions</h2></div>
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={daily} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="day" {...axis} tickFormatter={(d) => dayLabel(d, { day: 'numeric', month: 'short' })} interval="preserveStartEnd" />
                <YAxis yAxisId="s" {...axis} width={44} />
                <YAxis yAxisId="t" orientation="right" {...axis} unit="°C" width={48} />
                <Tooltip labelFormatter={(d) => dayLabel(d)}
                  formatter={(v, name) => [v == null ? '—' : name === 'Sunlight' ? `${v} kWh/m²` : name === 'Rain' ? `${v} mm` : `${v} °C`, name]} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar yAxisId="s" dataKey="sun_kwh_m2" name="Sunlight" fill="#fde68a" radius={[3, 3, 0, 0]} />
                <Bar yAxisId="s" dataKey="rain_mm" name="Rain" fill="#7dd3fc" radius={[3, 3, 0, 0]} />
                <Line yAxisId="t" dataKey="temp_c" name="Air temperature" stroke="#f97316" dot={false} strokeWidth={2} />
                <Line yAxisId="t" dataKey="max_module_c" name="Max module temperature" stroke="#dc2626" dot={false} strokeDasharray="5 4" />
              </ComposedChart>
            </ResponsiveContainer>
            <p className="data-note">Sunlight and temperatures from the plant’s sensors; rain from Open-Meteo for the plant location.
              Soiling and cooling are analysed on the Cleaning &amp; Cooling page.</p>
          </section>

          <p className="data-note">
            <Info size={13} /> Approximate factors: {e.factors.co2_kg_per_kwh} kg CO₂ per kWh (Indian grid), {e.factors.tree_kg_co2_per_year} kg
            CO₂ absorbed per tree per year, {num(e.factors.car_kg_co2_per_year / 1000, 1)} t CO₂ per car per year, {e.factors.coal_kg_per_kwh} kg
            coal per kWh, {e.factors.home_kwh_per_month} kWh per home per month. Ecological indicator: water per MWh (low &lt; 50,
            high ≥ 150 L/MWh), raised if cleaning happens more than 4 times a month.
          </p>
        </>
      )}
    </div>
  )
}
