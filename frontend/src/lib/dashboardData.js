// Dashboard data, read from Supabase (RLS: only the user's own plants).
//   daily_summaries -> KPIs, week/month charts, loss breakdown   (pre-computed by the backend on upload)
//   plant_readings  -> the latest day's 15-minute power curve + weather metrics
//   anomalies       -> number of open alarms
//   power_forecasts -> expected output (ML model on the plant's own sunlight sensor) for the latest day
// "Today" on the dashboard means the most recent day that has data (the dataset may be historical).
import { supabase } from './supabaseClient'
import { apiGet } from './api'

const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const zeroSeries = (labels, keys) => labels.map((label) => ({ label, ...Object.fromEntries(keys.map((k) => [k, 0])) }))

export const emptyDashboard = () => ({
  hasData: false,
  asOf: null, // 'YYYY-MM-DD' of the latest day with data
  kpis: {
    generationKwh: 0,
    revenue: 0,
    waterLitres: 0,
    co2AvoidedKg: 0,
    ecologicalRisk: null, // null = no data yet
    availability: 0,
    deltas: { generation: 0, revenue: 0, water: 0, co2: 0, availability: 0 },
  },
  metrics: { irradiance: 0, moduleTemp: 0, ambientTemp: 0, soilingLoss: 0, inverterEff: 0, alarms: 0 },
  recommendation: null, // { title, gainKwh, gainInr, waterL, impact, confidence }
  losses: [
    { name: 'Soiling', value: 0, color: '#f59e0b' },
    { name: 'Thermal', value: 0, color: '#3b82f6' },
    { name: 'Shading', value: 0, color: '#8b5cf6' },
    { name: 'Inverter', value: 0, color: '#22c55e' },
    { name: 'Other', value: 0, color: '#9ca3af' },
  ],
  power: {
    Today: zeroSeries(['6 AM', '12 PM', '6 PM'], ['actual', 'forecast']),
    Week: zeroSeries(WEEK, ['actual', 'forecast']),
    Month: zeroSeries(Array.from({ length: 30 }, (_, i) => String(i + 1)), ['actual', 'forecast']),
  },
  powerUnit: { Today: ' MW', Week: ' MWh', Month: ' MWh' },
  water: {
    Week: zeroSeries(WEEK, ['litres']),
    Month: zeroSeries(Array.from({ length: 30 }, (_, i) => String(i + 1)), ['litres']),
  },
  actions: [], // [{ title, when, status }]
})

const round = (x, d = 1) => (x === null || x === undefined ? 0 : Math.round(x * 10 ** d) / 10 ** d)
const pctChange = (now, before) => (now != null && before ? ((now - before) / before) * 100 : 0)
const avg = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined)
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

// 'YYYY-MM-DD' -> labels without timezone surprises
const dayDate = (day) => new Date(`${day}T12:00:00Z`)
const weekdayLabel = (day) => `${WEEK[(dayDate(day).getUTCDay() + 6) % 7]} ${dayDate(day).getUTCDate()}`
const monthLabel = (day) => dayDate(day).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })
const shiftDay = (day, n) => new Date(dayDate(day).getTime() + n * 86400000).toISOString().slice(0, 10)

export async function fetchDashboard(plant) {
  const base = emptyDashboard()
  if (!plant?.id) return base
  const tz = plant.timezone || 'Asia/Kolkata'

  const envReq = apiGet(`/plants/${plant.id}/environment`).catch(() => ({}))
  const [{ data: days, error }, { count: openAlarms }, { data: tasks }, { data: cleanings }, { data: recs }] = await Promise.all([
    supabase.from('daily_summaries').select('*').eq('plant_id', plant.id).order('day', { ascending: false }).limit(30),
    supabase.from('anomalies').select('id', { count: 'exact', head: true }).eq('plant_id', plant.id).eq('status', 'open'),
    // next open maintenance tasks (table from 005_maintenance.sql; an error just means no actions shown)
    supabase.from('maintenance_tasks').select('title, due_date, status').eq('plant_id', plant.id)
      .in('status', ['planned', 'in_progress']).order('due_date', { ascending: true, nullsFirst: false }).limit(3),
    // water used by finished cleaning tasks
    supabase.from('maintenance_tasks').select('completed_at, water_litres').eq('plant_id', plant.id)
      .eq('status', 'done').eq('category', 'cleaning').not('water_litres', 'is', null).limit(500),
    // top AI recommendation (table from 008_recommendations.sql; an error just means none shown)
    supabase.from('recommendations').select('*').eq('plant_id', plant.id).eq('status', 'open')
      .order('rank', { ascending: true }).limit(1),
  ])
  const top = recs?.[0]
  const recommendation = top ? {
    title: top.title,
    gainKwh: Math.round(top.gain_kwh ?? 0),
    gainInr: Math.round(top.gain_inr ?? 0),
    waterL: Math.max(0, Math.round(top.water_l ?? 0)),
    impact: top.co2_kg > 0 ? `≈ ${Math.round(top.co2_kg).toLocaleString('en-IN')} kg CO₂ avoided (30 days)` : 'No extra emissions',
    confidence: top.confidence,
    raw: top,
  } : null
  const actions = (tasks ?? []).map((t) => ({
    title: t.title,
    when: t.due_date
      ? `Due ${new Date(`${t.due_date}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`
      : 'No due date',
    status: t.status === 'in_progress' ? 'In progress' : 'Planned',
  }))
  if (error) throw error
  if (!days?.length) return { ...base, actions, recommendation }

  const [latest, previous] = days
  const lastWeek = days.slice(1, 8)

  // 15-minute readings around the latest day, then keep the ones on that local date
  const windowFrom = `${shiftDay(latest.day, -1)}T00:00:00Z`
  const windowTo = `${shiftDay(latest.day, 2)}T00:00:00Z`
  const [{ data: readings }, { data: expected }] = await Promise.all([
    supabase
      .from('plant_readings')
      .select('ts, ac_power_kw, irradiation_kw_m2, module_temp_c, ambient_temp_c')
      .eq('plant_id', plant.id)
      .gte('ts', windowFrom)
      .lt('ts', windowTo)
      .order('ts'),
    // missing table (003 not run yet) or no forecast -> simply no expected line
    supabase
      .from('power_forecasts')
      .select('ts, predicted_kw')
      .eq('plant_id', plant.id)
      .eq('kind', 'expected')
      .gte('ts', windowFrom)
      .lt('ts', windowTo),
  ])
  const expectedAt = new Map((expected ?? []).map((e) => [new Date(e.ts).getTime(), e.predicted_kw]))
  const expectedMw = (ts) => {
    const kw = expectedAt.get(new Date(ts).getTime())
    return kw == null ? null : round(kw / 1000, 2)
  }
  const expectedMwh = (d) => (d.expected_energy_kwh == null ? null : round(d.expected_energy_kwh / 1000))
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
  const today = (readings ?? []).filter((r) => localDate.format(new Date(r.ts)) === latest.day)
  const daylight = today.filter((r) => {
    const h = Number(localTime.format(new Date(r.ts)).slice(0, 2))
    return h >= 5 && h <= 19
  })

  // Loss breakdown: share of the energy the plant could have produced without that loss
  const thermal = latest.thermal_loss_kwh ?? 0
  const inverter = latest.inverter_loss_kwh ?? 0
  const soilingPct = latest.soiling_loss_pct ?? 0   // modelled by the Cleaning module
  const soiling = soilingPct > 0 && soilingPct < 100 ? ((latest.energy_kwh ?? 0) * soilingPct) / (100 - soilingPct) : 0
  const potential = (latest.energy_kwh ?? 0) + thermal + inverter + soiling
  const share = (x) => (potential > 0 ? (100 * x) / potential : 0)

  const chronological = [...days].reverse()
  const week = chronological.slice(-7)
  const waterByDay = {}
  for (const c of cleanings ?? []) {
    const d = localDate.format(new Date(c.completed_at))
    waterByDay[d] = (waterByDay[d] ?? 0) + Number(c.water_litres)
  }
  const waterIn = (list) => list.reduce((s, d) => s + (waterByDay[d.day] ?? 0), 0)
  const waterWeek = waterIn(week)
  const waterPrev = waterIn(chronological.slice(-14, -7))
  const irrPeak = Math.max(0, ...today.map((r) => r.irradiation_kw_m2 ?? 0))

  return {
    ...base,
    hasData: true,
    asOf: latest.day,
    kpis: {
      generationKwh: round(latest.energy_kwh, 0),
      revenue: round(latest.revenue_inr, 0),
      waterLitres: Math.round(waterWeek), // cleaning water over the last 7 days of data
      co2AvoidedKg: round(latest.co2_avoided_kg, 0),
      ecologicalRisk: (await envReq).result?.indicator?.level ?? null,
      ecologicalNote: (await envReq).result?.indicator?.reason ?? null,
      availability: round(latest.availability_pct, 1),
      deltas: {
        generation: pctChange(latest.energy_kwh, previous?.energy_kwh),
        revenue: pctChange(latest.revenue_inr, previous?.revenue_inr),
        water: pctChange(waterWeek, waterPrev),
        co2: pctChange(latest.co2_avoided_kg, previous?.co2_avoided_kg),
        availability: pctChange(latest.availability_pct, avg(lastWeek.map((d) => d.availability_pct))),
      },
    },
    metrics: {
      irradiance: Math.round(irrPeak * 1000), // peak of the day, W/m²
      moduleTemp: round(latest.avg_module_temp_c),
      ambientTemp: round(latest.avg_ambient_temp_c),
      soilingLoss: round(soilingPct, 1),
      inverterEff: round(latest.inverter_eff_pct),
      alarms: openAlarms ?? 0,
    },
    losses: base.losses.map((l) =>
      l.name === 'Thermal' ? { ...l, value: share(thermal) }
        : l.name === 'Inverter' ? { ...l, value: share(inverter) }
          : l.name === 'Soiling' ? { ...l, value: share(soiling) } : l,
    ),
    power: {
      Today: daylight.map((r) => ({
        label: localTime.format(new Date(r.ts)),
        actual: round((r.ac_power_kw ?? 0) / 1000, 2),
        forecast: expectedMw(r.ts),
      })),
      Week: week.map((d) => ({ label: weekdayLabel(d.day), actual: round((d.energy_kwh ?? 0) / 1000), forecast: expectedMwh(d) })),
      Month: chronological.map((d) => ({ label: monthLabel(d.day), actual: round((d.energy_kwh ?? 0) / 1000), forecast: expectedMwh(d) })),
    },
    actions,
    recommendation,
    water: {
      Week: week.map((d) => ({ label: weekdayLabel(d.day), litres: waterByDay[d.day] ?? 0 })),
      Month: chronological.map((d) => ({ label: monthLabel(d.day), litres: waterByDay[d.day] ?? 0 })),
    },
  }
}
