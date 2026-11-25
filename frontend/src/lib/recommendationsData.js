// AI Recommendations (RLS: own plants only). The backend builds and ranks them; the browser approves/dismisses.
// Approve = what the recommendation's `action` says:
//   create_task – new maintenance task (source 'recommendation', linked both ways)
//   reschedule  – move an existing task to the suggested day
//   open_task   – just go to the task (reminders)
//   none        – accept (what-ifs, "postpone cleaning")
import { supabase } from './supabaseClient'
import { apiPost } from './api'
import { createTask, updateTask } from './maintenanceData'

const COLUMNS = '*, task:maintenance_tasks!recommendations_task_id_fkey(id, title, status, completed_at, due_date)'

export const TYPE_LABELS = {
  cleaning: 'Cleaning', anomaly: 'Fault', sensor: 'Sensor', schedule: 'Scheduling', reminder: 'Reminder',
  cooling: 'Cooling', battery: 'Battery what-if',
}

export const approveLabel = (r) => ({
  create_task: 'Approve – create task', reschedule: 'Approve – move task', open_task: 'Open task', none: 'Accept',
}[r.action?.kind] ?? 'Accept')

export async function fetchRecommendations(plant) {
  if (!plant?.id) return null
  const [recs, days] = await Promise.all([
    supabase.from('recommendations').select(COLUMNS).eq('plant_id', plant.id)
      .order('rank', { ascending: true }).limit(200),
    supabase.from('daily_summaries').select('day, energy_kwh, expected_energy_kwh')
      .eq('plant_id', plant.id).order('day', { ascending: true }).limit(1000),
  ])
  if (recs.error) throw recs.error
  const all = recs.data ?? []
  return {
    open: all.filter((r) => r.status === 'open'),
    history: all.filter((r) => r.status !== 'open').sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    summaries: days.data ?? [],
  }
}

/** Top open recommendation (dashboard card). */
export async function fetchTopRecommendation(plantId) {
  const { data } = await supabase.from('recommendations').select('*').eq('plant_id', plantId)
    .eq('status', 'open').order('rank', { ascending: true }).limit(1)
  return data?.[0] ?? null
}

async function setStatus(id, values) {
  const { data, error } = await supabase.from('recommendations').update(values).eq('id', id).select('*').single()
  return error ? { error: error.message } : { data }
}

/** @returns {Promise<{ error?: string, navigateTo?: string, message?: string }>} */
export async function approveRecommendation(plantId, rec) {
  const a = rec.action ?? {}
  if (a.kind === 'open_task') return { navigateTo: '/maintenance?tab=tasks' }
  if (a.kind === 'create_task') {
    const t = a.task ?? {}
    const res = await createTask(plantId, {
      title: t.title || rec.title, category: t.category || 'other', priority: t.priority || rec.priority,
      due_date: t.due_date || rec.due_date, est_cost_inr: t.est_cost_inr ?? '', notes: t.notes || rec.summary || '',
      assigned_to: '', recurrence_days: '', source: 'recommendation', recommendation_id: rec.id,
    })
    if (res.error) return { error: res.error }
    const s = await setStatus(rec.id, { status: 'approved', task_id: res.data.id })
    return s.error ? s : { message: `Task created: “${res.data.title}”.` }
  }
  if (a.kind === 'reschedule') {
    const res = await updateTask(a.task_id, { due_date: a.due_date })
    if (res.error) return { error: res.error }
    const s = await setStatus(rec.id, { status: 'approved', task_id: a.task_id })
    return s.error ? s : { message: `Task moved to ${a.due_date}.` }
  }
  const s = await setStatus(rec.id, { status: 'approved' })
  return s.error ? s : { message: 'Recommendation accepted.' }
}

export const dismissRecommendation = (rec, reason) =>
  setStatus(rec.id, { status: 'dismissed', dismiss_reason: reason?.trim() || null })

export const refreshRecommendations = (plantId) => apiPost(`/plants/${plantId}/recommendations/refresh`)
