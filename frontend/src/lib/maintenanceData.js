// Maintenance tasks (RLS: own plants only). Unlike the data tables, the browser writes tasks directly.
// The database (005_maintenance.sql) handles: completion time, resolving a linked anomaly when a task is done,
// acknowledging it when a task is created, and planning the next run of a repeating task.
import { supabase } from './supabaseClient'
import { ALARM_LABELS } from './plantOverviewData'

export const CATEGORIES = {
  inspection: 'Inspection', cleaning: 'Cleaning', repair: 'Repair',
  calibration: 'Calibration', preventive: 'Preventive', other: 'Other',
}
export const STATUS_LABELS = { planned: 'Planned', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' }
export const SOURCE_LABELS = { manual: 'Manual', anomaly: 'From anomaly', schedule: 'Scheduled', recommendation: 'AI recommendation' }

const TASK_COLUMNS = '*, anomaly:anomalies(id, type, severity, status, ts_start)'
const DAY = 86400000

export const todayIso = () => {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}
export const addDays = (iso, n) => new Date(new Date(`${iso}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10)

/** Standard preventive schedule (cleaning is planned by the Cleaning module later). */
export const STANDARD_SCHEDULE = [
  { title: 'Inverter inspection (fans, filters, error logs)', category: 'preventive', priority: 'medium', recurrence_days: 30, est_cost_inr: 2000, in: 7 },
  { title: 'Irradiation & temperature sensor calibration', category: 'calibration', priority: 'medium', recurrence_days: 90, est_cost_inr: 3000, in: 14 },
  { title: 'Thermal-camera inspection of modules (hot spots)', category: 'inspection', priority: 'low', recurrence_days: 365, est_cost_inr: 15000, in: 30 },
]

// anomaly cause -> what kind of task fixes it
const FIX = {
  inverter_fault: ['repair', 'Inspect inverters'],
  inverter_dropout: ['repair', 'Check inverter communication / trips'],
  overheating: ['inspection', 'Check module ventilation and hot spots'],
  shading: ['inspection', 'Find and remove shading'],
  clipping: ['inspection', 'Check inverter power limit / grid curtailment'],
  sensor_mismatch: ['calibration', 'Clean and calibrate the irradiation sensor'],
  sensor_fault: ['calibration', 'Repair the irradiation sensor'],
  data_gap: ['inspection', 'Check data logger and communication'],
  output_drop: ['inspection', 'Inspect strings, connectors and breakers'],
  underperformance: ['inspection', 'Inspect strings, connectors and breakers'],
}

/** Pre-filled task for an anomaly: category from the cause, due date from the severity. */
export function taskFromAnomaly(a, plant) {
  const [category, action] = FIX[a.type] ?? ['inspection', `Investigate ${ALARM_LABELS[a.type] ?? a.type}`]
  const day = new Date(a.ts_start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: plant.timezone || 'Asia/Kolkata' })
  return {
    title: `${action} (${ALARM_LABELS[a.type] ?? a.type}, ${day})`,
    category,
    priority: a.severity,
    due_date: addDays(todayIso(), { high: 1, medium: 3, low: 7 }[a.severity] ?? 7),
    source: 'anomaly',
    anomaly_id: a.id,
    notes: a.explanation ?? '',
  }
}

const clean = (v) => ({
  title: v.title?.trim(),
  category: v.category,
  priority: v.priority,
  due_date: v.due_date || null,
  assigned_to: v.assigned_to?.trim() || null,
  est_cost_inr: v.est_cost_inr === '' || v.est_cost_inr == null ? null : Number(v.est_cost_inr),
  recurrence_days: v.recurrence_days === '' || v.recurrence_days == null ? null : Number(v.recurrence_days),
  notes: v.notes?.trim() || null,
})

export async function createTask(plantId, values) {
  const row = {
    ...clean(values), plant_id: plantId, source: values.source ?? 'manual',
    anomaly_id: values.anomaly_id ?? null, ...(values.recommendation_id && { recommendation_id: values.recommendation_id }),
  }
  const { data, error } = await supabase.from('maintenance_tasks').insert(row).select(TASK_COLUMNS).single()
  return error ? { error: error.message } : { data }
}

export async function updateTask(id, values) {
  const { data, error } = await supabase.from('maintenance_tasks').update(values).eq('id', id).select(TASK_COLUMNS).single()
  return error ? { error: error.message } : { data }
}
export const editTask = (id, values) => updateTask(id, clean(values))

export async function deleteTask(id) {
  const { error } = await supabase.from('maintenance_tasks').delete().eq('id', id)
  return error ? { error: error.message } : {}
}

export async function addStandardSchedule(plantId) {
  const rows = STANDARD_SCHEDULE.map(({ in: inDays, ...t }) => ({
    ...t, plant_id: plantId, source: 'schedule', due_date: addDays(todayIso(), inDays),
  }))
  const { error } = await supabase.from('maintenance_tasks').insert(rows)
  return error ? { error: error.message } : {}
}

/** Tasks + what's needed for the health score and the before/after check. */
export async function fetchMaintenance(plant) {
  if (!plant?.id) return null
  const [tasks, days, open] = await Promise.all([
    supabase.from('maintenance_tasks').select(TASK_COLUMNS).eq('plant_id', plant.id)
      .order('due_date', { ascending: true, nullsFirst: false }).limit(500),
    supabase.from('daily_summaries').select('day, energy_kwh, expected_energy_kwh, availability_pct')
      .eq('plant_id', plant.id).order('day', { ascending: true }).limit(1000),
    supabase.from('anomalies').select('severity').eq('plant_id', plant.id).eq('status', 'open'),
  ])
  for (const r of [tasks, days, open]) if (r.error) throw r.error
  const list = tasks.data ?? []
  return {
    tasks: list,
    summaries: days.data ?? [],
    health: healthScore(days.data ?? [], open.data ?? [], list),
  }
}

export const isOverdue = (t) => ['planned', 'in_progress'].includes(t.status) && t.due_date && t.due_date < todayIso()

/**
 * Plant health 0–100:
 *   40  output vs expected (last 7 days with data; 70 % → 0 pts, 100 % → 40 pts)
 *   30  availability (last 7 days)
 *   20  open anomalies (high −8, medium −4, low −1)
 *   10  overdue tasks (−5 each)
 */
export function healthScore(summaries, openAnomalies, tasks) {
  const recent = summaries.filter((d) => d.expected_energy_kwh > 0).slice(-7)
  if (!recent.length) return null
  const ratio = recent.reduce((s, d) => s + (d.energy_kwh ?? 0), 0) / recent.reduce((s, d) => s + d.expected_energy_kwh, 0)
  const avail = recent.reduce((s, d) => s + (d.availability_pct ?? 0), 0) / recent.length
  const penalty = openAnomalies.reduce((s, a) => s + ({ high: 8, medium: 4, low: 1 }[a.severity] ?? 0), 0)
  const overdue = tasks.filter(isOverdue).length
  const parts = {
    output: 40 * Math.min(1, Math.max(0, (ratio - 0.7) / 0.3)),
    availability: 30 * Math.min(1, avail / 100),
    anomalies: Math.max(0, 20 - penalty),
    tasks: Math.max(0, 10 - 5 * overdue),
  }
  const score = Math.round(Object.values(parts).reduce((s, x) => s + x, 0))
  return {
    score,
    label: score >= 85 ? 'Good' : score >= 70 ? 'Fair' : 'Needs attention',
    ratio, avail, openAnomalies: openAnomalies.length, overdue,
    parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, Math.round(v)])),
  }
}

/**
 * Did the task help? Output ÷ expected output for up to 7 days before vs 7 days after completion
 * (weather-independent because "expected" already accounts for the sunlight). Needs ≥ 3 days each side.
 */
export function taskImpact(task, summaries, tariff = 0) {
  if (task.status !== 'done' || !task.completed_at) return null
  const day = task.completed_at.slice(0, 10)
  const ok = summaries.filter((d) => d.expected_energy_kwh > 0 && d.energy_kwh != null)
  const before = ok.filter((d) => d.day < day).slice(-7)
  const after = ok.filter((d) => d.day > day).slice(0, 7)
  if (before.length < 3 || after.length < 3) return { pending: true, afterDays: after.length }
  const r = (xs) => xs.reduce((s, d) => s + d.energy_kwh, 0) / xs.reduce((s, d) => s + d.expected_energy_kwh, 0)
  const rb = r(before)
  const ra = r(after)
  const expectedPerDay = after.reduce((s, d) => s + d.expected_energy_kwh, 0) / after.length
  const weeklyKwh = (ra - rb) * expectedPerDay * 7
  return { pending: false, changePct: (ra / rb - 1) * 100, weeklyKwh, weeklyInr: weeklyKwh * tariff, before: rb, after: ra }
}
