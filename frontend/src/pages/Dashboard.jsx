import { useEffect, useState } from 'react'
import { useOutletContext } from 'react-router-dom'
import {
  ResponsiveContainer, ComposedChart, Area, Line, BarChart, Bar,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts'
import {
  Zap, IndianRupee, Droplet, Leaf, Sprout, Settings, Sun, Thermometer, Wind,
  TrendingUp, Lightbulb, ChevronRight, ArrowUp, ArrowDown, Radio, CalendarDays, Upload,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { usePlants } from '../context/PlantContext'
import { emptyDashboard, fetchDashboard } from '../lib/dashboardData'

const inr = (n) => `₹ ${Number(n).toLocaleString('en-IN')}`
const num = (n) => Number(n).toLocaleString('en-IN')
const yDomain = [0, (max) => Math.max(max, 10)]

function Delta({ value, goodWhen = 'up', suffix }) {
  if (!value) return <span className="delta flat">0.0% <small>{suffix}</small></span>
  const up = value > 0
  const good = (goodWhen === 'up') === up
  const Icon = up ? ArrowUp : ArrowDown
  return (
    <span className={`delta ${good ? 'good' : 'bad'}`}>
      <Icon size={14} /> {Math.abs(value).toFixed(1)}% <small>{suffix}</small>
    </span>
  )
}

function Kpi({ icon: Icon, tone, label, value, children }) {
  return (
    <div className="card kpi">
      <span className={`kpi-icon ${tone}`}><Icon size={26} /></span>
      <div>
        <p className="kpi-label">{label}</p>
        <p className="kpi-value">{value}</p>
        {children}
      </div>
    </div>
  )
}

function Tabs({ options, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button key={o} role="tab" aria-selected={o === value} className={o === value ? 'on' : ''} onClick={() => onChange(o)}>
          {o}
        </button>
      ))}
    </div>
  )
}

const axis = { tick: { fontSize: 12, fill: '#64748b' }, axisLine: false, tickLine: false }

export default function Dashboard() {
  const { user, profile } = useAuth()
  const { plant } = useOutletContext()
  const { openUploadData } = usePlants()
  const [data, setData] = useState(emptyDashboard)
  const [powerRange, setPowerRange] = useState('Today')
  const [waterRange, setWaterRange] = useState('Week')

  const plantId = plant?.id
  useEffect(() => {
    let cancelled = false
    fetchDashboard(plantId).then((d) => !cancelled && setData(d))
    return () => { cancelled = true }
  }, [plantId])

  const firstName = (profile?.full_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'there').split(' ')[0]
  const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  const { kpis, metrics, recommendation: rec } = data

  const lossTotal = data.losses.reduce((s, l) => s + l.value, 0)
  const pieData = lossTotal === 0 ? [{ name: 'No data', value: 1, color: '#e2e8f0' }] : data.losses

  return (
    <div className="dashboard">
      <div className="welcome">
        <div>
          <h1>Welcome back, {firstName}!</h1>
          <p>Here&apos;s how your solar plant is performing today.</p>
        </div>
        <p className="tagline">Cleaner Energy<br />Brighter Tomorrow</p>
        <div className="pills">
          <span className="pill"><Radio size={16} /> Live Data</span>
          <span className="pill"><CalendarDays size={16} /> {today}</span>
          {plant && (
            <button className="pill pill-action" onClick={() => openUploadData(plant)}>
              <Upload size={16} /> Upload data
            </button>
          )}
        </div>
      </div>

      <section className="kpis">
        <Kpi icon={Zap} tone="lime" label="Today's Generation" value={`${num(kpis.generationKwh)} kWh`}>
          <Delta value={kpis.deltas.generation} suffix="vs. yesterday" />
        </Kpi>
        <Kpi icon={IndianRupee} tone="teal" label="Net Profit (Today)" value={inr(kpis.netProfit)}>
          <Delta value={kpis.deltas.profit} suffix="vs. yesterday" />
        </Kpi>
        <Kpi icon={Droplet} tone="blue" label="Water Usage" value={`${num(kpis.waterLitres)} L`}>
          <Delta value={kpis.deltas.water} goodWhen="down" suffix="vs. last week" />
        </Kpi>
        <Kpi icon={Leaf} tone="green" label="Carbon Emissions" value={<>{num(kpis.carbonKg)} kg CO<sub>2</sub>e</>}>
          <Delta value={kpis.deltas.carbon} goodWhen="down" suffix="vs. baseline" />
        </Kpi>
        <Kpi icon={Sprout} tone="green" label="Ecological Risk" value={kpis.ecologicalRisk ?? '—'}>
          <span className="delta flat"><small>{kpis.ecologicalRisk ? 'No critical issues' : 'No data yet'}</small></span>
        </Kpi>
        <Kpi icon={Settings} tone="gray" label="Plant Availability" value={`${kpis.availability}%`}>
          <Delta value={kpis.deltas.availability} suffix="vs. last week" />
        </Kpi>
      </section>

      <section className="row row-2">
        <div className="card">
          <div className="card-head">
            <h2>Power Generation</h2>
            <Tabs options={['Today', 'Week', 'Month']} value={powerRange} onChange={setPowerRange} />
          </div>
          <div className="legend">
            <span><i className="sw solid" /> Actual</span>
            <span><i className="sw dashed" /> Forecast</span>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={data.power[powerRange]} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                <defs>
                  <linearGradient id="gen" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#22c55e" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#22c55e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#e8edf3" vertical={false} />
                <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
                <YAxis {...axis} domain={yDomain} unit=" kW" width={64} />
                <Tooltip />
                <Area type="monotone" dataKey="actual" name="Actual" stroke="#16a34a" strokeWidth={2.5} fill="url(#gen)" />
                <Line type="monotone" dataKey="forecast" name="Forecast" stroke="#2563eb" strokeWidth={2} strokeDasharray="6 5" dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="card">
          <h2>Key Metrics</h2>
          <ul className="metrics">
            <li><Sun size={18} className="c-amber" /> Irradiance <b>{num(metrics.irradiance)} W/m²</b></li>
            <li><Thermometer size={18} className="c-red" /> Module Temperature <b>{metrics.moduleTemp} °C</b></li>
            <li><Wind size={18} className="c-blue" /> Ambient Temperature <b>{metrics.ambientTemp} °C</b></li>
            <li><Droplet size={18} className="c-blue" /> Soiling Loss <b>{metrics.soilingLoss} %</b></li>
            <li><TrendingUp size={18} className="c-teal" /> Inverter Efficiency <b>{metrics.inverterEff} %</b></li>
            <li><Settings size={18} className="c-gray" /> Active Alarms <b>{metrics.alarms}</b></li>
          </ul>
        </div>

        <div className="card rec">
          <div className="card-head">
            <h2><Lightbulb size={22} /> AI Recommendation</h2>
            {rec && <span className="badge">High Value Action</span>}
          </div>
          {rec ? (
            <>
              <p className="rec-title">{rec.title}</p>
              <p>Expected gain: +{num(rec.gainKwh)} kWh ({inr(rec.gainInr)})</p>
              <p>Water required: {num(rec.waterL)} L</p>
              <p>Environmental impact: {rec.impact}</p>
              <p>Confidence: {rec.confidence}%</p>
            </>
          ) : (
            <>
              <p className="rec-title muted">No recommendation yet</p>
              <p>Recommendations appear here once plant data is connected and the decision engine has run.</p>
            </>
          )}
          <div className="rec-actions">
            <button className="btn primary" disabled={!rec}>Approve</button>
            <button className="btn" disabled={!rec}>View Details</button>
          </div>
        </div>
      </section>

      <section className="row row-3">
        <div className="card">
          <h2>Loss Analysis (Today)</h2>
          <div className="loss">
            <div className="donut">
              <PieChart width={190} height={190}>
                <Pie data={pieData} dataKey="value" innerRadius={62} outerRadius={90} stroke="none" startAngle={90} endAngle={-270}>
                  {pieData.map((d) => <Cell key={d.name} fill={d.color} />)}
                </Pie>
              </PieChart>
              <div className="donut-label"><small>Total Loss</small><strong>{lossTotal.toFixed(1)}%</strong></div>
            </div>
            <ul className="loss-list">
              {data.losses.map((l) => (
                <li key={l.name}><i style={{ background: l.color }} />{l.name}<b>{l.value.toFixed(1)}%</b></li>
              ))}
            </ul>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Water Usage Trend</h2>
            <Tabs options={['Week', 'Month']} value={waterRange} onChange={setWaterRange} />
          </div>
          <ResponsiveContainer width="100%" height={210}>
            <BarChart data={data.water[waterRange]} margin={{ top: 8, right: 4, left: -8, bottom: 0 }}>
              <CartesianGrid stroke="#e8edf3" vertical={false} />
              <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
              <YAxis {...axis} domain={yDomain} width={44} />
              <Tooltip formatter={(v) => [`${num(v)} L`, 'Water']} />
              <Bar dataKey="litres" fill="#60a5fa" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Upcoming Actions</h2>
            <a className="link" href="/recommendations">View All <ChevronRight size={14} /></a>
          </div>
          {data.actions.length === 0 ? (
            <p className="empty">No actions scheduled.</p>
          ) : (
            <ul className="actions">
              {data.actions.map((a) => (
                <li key={a.title}>
                  <div><strong>{a.title}</strong><small>{a.when}</small></div>
                  <span className="status-pill">{a.status}</span>
                  <ChevronRight size={16} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="banner">
        <div>
          <strong>Optimizing Today</strong>
          <span>for a Sustainable Tomorrow</span>
        </div>
        <ul>
          <li><Zap size={16} /> Higher Profit</li>
          <li><Leaf size={16} /> Lower Carbon</li>
          <li><Droplet size={16} /> Smarter Water Use</li>
          <li><Sprout size={16} /> Healthier Ecosystems</li>
        </ul>
      </section>
    </div>
  )
}
