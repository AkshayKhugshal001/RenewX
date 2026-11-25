// Anomalies page data (RLS: only the user's own plants).
//   anomalies       -> rule alarms (source 'rule') and ML anomalies (source 'ml'), written by the backend
//   plant_readings  -> actual power on the day of a selected anomaly
//   power_forecasts -> expected power on that day (kind 'expected')
// The browser may only change an anomaly's `status`; the database fills acknowledged_at / resolved_at.
import { supabase } from './supabaseClient'
import { apiPost } from './api'

export { ALARM_LABELS } from './plantOverviewData'

export async function fetchAnomalies(plant) {
  if (!plant?.id) return []
  const query = (columns) => supabase
    .from('anomalies')
    .select(columns)
    .eq('plant_id', plant.id)
    .order('ts_start', { ascending: false })
    .limit(1000)
  // tasks created for each anomaly (maintenance_tasks comes with 005_maintenance.sql; works without it too)
  let { data, error } = await query('*, tasks:maintenance_tasks(id, title, status)')
  if (error) ({ data, error } = await query('*'))
  if (error) throw error
  return data ?? []
}

const localDay = (iso, tz) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
const shift = (day, n) => new Date(new Date(`${day}T00:00:00Z`).getTime() + n * 86400000).toISOString()

/** Actual vs expected power (MW) on the local day of an anomaly, 05:00–19:00. */
export async function fetchAnomalyDay(plant, anomaly) {
  const tz = plant.timezone || 'Asia/Kolkata'
  const day = localDay(anomaly.ts_start, tz)
  const [from, to] = [shift(day, -1), shift(day, 2)]
  const [{ data: readings, error }, { data: expected }] = await Promise.all([
    supabase.from('plant_readings').select('ts, ac_power_kw, irradiation_kw_m2')
      .eq('plant_id', plant.id).gte('ts', from).lt('ts', to).order('ts'),
    supabase.from('power_forecasts').select('ts, predicted_kw')
      .eq('plant_id', plant.id).eq('kind', 'expected').gte('ts', from).lt('ts', to),
  ])
  if (error) throw error
  const exp = new Map((expected ?? []).map((e) => [new Date(e.ts).getTime(), e.predicted_kw]))
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })
  const start = new Date(anomaly.ts_start).getTime()
  const end = new Date(anomaly.ts_end).getTime()
  const points = (readings ?? [])
    .filter((r) => localDay(r.ts, tz) === day)
    .map((r) => {
      const t = new Date(r.ts).getTime()
      const e = exp.get(t)
      return {
        t,
        label: time.format(new Date(r.ts)),
        actual: r.ac_power_kw == null ? null : Math.round(r.ac_power_kw / 10) / 100,
        expected: e == null ? null : Math.round(e / 10) / 100,
        inWindow: t >= start && t < end,
      }
    })
    .filter((p) => { const h = Number(p.label.slice(0, 2)); return h >= 5 && h <= 19 })
  const inside = points.filter((p) => p.inWindow)
  return { day, points, from: inside[0]?.label ?? null, to: inside.at(-1)?.label ?? null }
}

export async function setAnomalyStatus(id, status) {
  const { data, error } = await supabase.from('anomalies').update({ status }).eq('id', id).select('*').single()
  if (error) return { error: error.message }
  return { data }
}

export const runDetection = (plantId) => apiPost(`/plants/${plantId}/anomalies/detect`)
