// Plant Overview data: the plant's whole history (Dashboard = latest day only).
// Reads daily_summaries, anomalies, data_uploads and plant_readings from Supabase (RLS-protected).
import { supabase } from './supabaseClient'

const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0)
const mean = (rows, key) => {
  const v = rows.map((r) => r[key]).filter((x) => x !== null && x !== undefined)
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null
}

export const ALARM_LABELS = {
  underperformance: 'Underperformance',
  data_gap: 'Data gap',
  inverter_dropout: 'Inverter not reporting',
  sensor_fault: 'Sensor fault',
}

export async function fetchPlantOverview(plant) {
  if (!plant?.id) return null

  const [days, alarms, uploads, inverters] = await Promise.all([
    supabase.from('daily_summaries').select('*').eq('plant_id', plant.id).order('day').limit(2000),
    supabase.from('anomalies').select('type, severity, status, energy_lost_kwh').eq('plant_id', plant.id).limit(5000),
    supabase
      .from('data_uploads')
      .select('id, file_name, kind, mode, status, rows_total, rows_inserted, rows_updated, rows_skipped, rows_rejected, ts_from, ts_to, error, created_at')
      .eq('plant_id', plant.id)
      .order('created_at', { ascending: false })
      .limit(10),
    supabase
      .from('plant_readings')
      .select('active_inverters')
      .eq('plant_id', plant.id)
      .not('active_inverters', 'is', null)
      .order('active_inverters', { ascending: false })
      .limit(1),
  ])
  const failed = [days, alarms, uploads, inverters].find((r) => r.error)
  if (failed) throw failed.error

  const d = days.data ?? []
  const energy = sum(d, 'energy_kwh')
  const thermal = sum(d, 'thermal_loss_kwh')
  const inverter = sum(d, 'inverter_loss_kwh')
  const potential = energy + thermal + inverter
  const withPr = d.filter((x) => x.performance_ratio != null)
  const byPr = [...withPr].sort((a, b) => b.performance_ratio - a.performance_ratio)

  // alarms grouped by type
  const groups = {}
  for (const a of alarms.data ?? []) {
    const g = (groups[a.type] ??= { type: a.type, total: 0, open: 0, high: 0, energyLost: 0 })
    g.total += 1
    if (a.status === 'open') g.open += 1
    if (a.severity === 'high') g.high += 1
    g.energyLost += a.energy_lost_kwh ?? 0
  }

  return {
    hasData: d.length > 0,
    firstDay: d[0]?.day ?? null,
    lastDay: d.at(-1)?.day ?? null,
    dayCount: d.length,
    inverters: inverters.data?.[0]?.active_inverters ?? null,
    totals: {
      energyKwh: energy,
      revenueInr: sum(d, 'revenue_inr'),
      co2Kg: sum(d, 'co2_avoided_kg'),
      avgPr: mean(d, 'performance_ratio'),
      avgAvailability: mean(d, 'availability_pct'),
      avgCompleteness: mean(d, 'data_completeness_pct'),
      avgDailyKwh: d.length ? energy / d.length : 0,
      avgSpecificYield: mean(d, 'specific_yield_kwh_kwp'),
      avgInverterEff: mean(d, 'inverter_eff_pct'),
      peakKw: Math.max(0, ...d.map((x) => x.peak_ac_kw ?? 0)),
    },
    losses: {
      thermalKwh: thermal,
      inverterKwh: inverter,
      thermalPct: potential > 0 ? (100 * thermal) / potential : 0,
      inverterPct: potential > 0 ? (100 * inverter) / potential : 0,
    },
    lowDataDays: d.filter((x) => (x.data_completeness_pct ?? 0) < 90).length,
    best: byPr.slice(0, 3),
    worst: byPr.slice(-3).reverse(),
    trend: d.map((x) => ({
      day: x.day,
      energy: x.energy_kwh != null ? Math.round(x.energy_kwh / 100) / 10 : null, // MWh, 1 decimal
      pr: x.performance_ratio != null ? Math.round(x.performance_ratio * 1000) / 10 : null, // %
    })),
    alarmGroups: Object.values(groups).sort((a, b) => b.total - a.total),
    uploads: uploads.data ?? [],
  }
}
