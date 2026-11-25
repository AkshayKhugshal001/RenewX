// Cleaning & Cooling page data (RLS: own plants only).
//   cleaning_analyses -> latest soiling/cleaning/cooling analysis (written by the backend after each upload)
//   daily_summaries   -> per-day cleanliness index, modelled soiling loss, thermal loss
//   maintenance_tasks -> cleaning tasks (water used)
import { supabase } from './supabaseClient'
import { analyseCleaning } from './api'

export const ACTIONS = {
  clean_now: { label: 'Clean now', tone: 'bad' },
  clean_in: { label: 'Clean later', tone: 'ok' },
  wait_rain: { label: 'Wait for rain', tone: 'info' },
  not_needed: { label: 'No cleaning needed', tone: 'good' },
}

export const COOLING = {
  recommended: 'Cooling recommended',
  not_worth_it: 'Cooling not worth it',
  not_needed: 'Cooling not needed',
  unknown: 'Not enough data',
}

export async function fetchCleaning(plant) {
  if (!plant?.id) return null
  const [run, days, tasks] = await Promise.all([
    supabase.from('cleaning_analyses').select('*').eq('plant_id', plant.id).order('created_at', { ascending: false }).limit(1),
    supabase.from('daily_summaries')
      .select('day, energy_kwh, expected_energy_kwh, cleanliness_index, soiling_loss_pct, thermal_loss_kwh, max_module_temp_c')
      .eq('plant_id', plant.id).order('day', { ascending: false }).limit(90),
    supabase.from('maintenance_tasks').select('id, title, status, due_date, completed_at, water_litres, actual_cost_inr')
      .eq('plant_id', plant.id).eq('category', 'cleaning').order('due_date', { ascending: false, nullsFirst: false }).limit(50),
  ])
  if (run.error) throw run.error
  if (days.error) throw days.error
  return {
    analysis: run.data?.[0] ?? null,
    days: [...(days.data ?? [])].reverse(),
    cleanings: tasks.error ? [] : tasks.data ?? [],
  }
}

export const runCleaningAnalysis = analyseCleaning
