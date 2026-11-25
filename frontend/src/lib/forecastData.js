// Forecasting page data, read from Supabase (RLS: only the user's own plants).
//   forecast_runs    -> latest run: mode (live/simulated), chosen models, test scores, notes
//   power_forecasts  -> day_ahead hourly kW (future window + issued forecasts for past days)
//   weather_data     -> hourly weather for the forecast window (recorded or forecast)
//   daily_summaries  -> actual vs expected energy for recent days (accuracy + hidden losses)
// Hourly values are labelled by the END of the hour (Open-Meteo convention), so the local day/hour
// of a value is taken from ts − 30 min.
import { supabase } from './supabaseClient'

const HOUR_MS = 3600000
const RECENT_DAYS = 14

const fmt = (tz, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, ...opts })
const r1 = (x) => Math.round(x * 10) / 10

function localKeys(tz) {
  const date = fmt(tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
  const hour = fmt(tz, { hour: '2-digit', hourCycle: 'h23' })
  return (ts) => {
    const mid = new Date(new Date(ts).getTime() - HOUR_MS / 2)
    return { day: date.format(mid), hour: Number(hour.format(mid)) }
  }
}

/** Sum hourly kW rows into kWh per local day. */
function dailyTotals(rows, keyOf) {
  const out = new Map()
  for (const r of rows) {
    const { day } = keyOf(r.ts)
    const d = out.get(day) ?? { day, energy: 0, lower: 0, upper: 0 }
    d.energy += r.predicted_kw ?? 0
    d.lower += r.lower_kw ?? r.predicted_kw ?? 0
    d.upper += r.upper_kw ?? r.predicted_kw ?? 0
    out.set(day, d)
  }
  return out
}

export async function fetchForecast(plant) {
  if (!plant?.id) return null
  const tz = plant.timezone || 'Asia/Kolkata'
  const keyOf = localKeys(tz)

  const [{ data: runs, error }, { data: summaries, error: sErr }] = await Promise.all([
    supabase.from('forecast_runs').select('*').eq('plant_id', plant.id).order('created_at', { ascending: false }).limit(1),
    supabase.from('daily_summaries').select('day, energy_kwh, expected_energy_kwh')
      .eq('plant_id', plant.id).order('day', { ascending: false }).limit(RECENT_DAYS),
  ])
  if (error) throw error
  if (sErr) throw sErr
  const run = runs?.[0] ?? null
  const recent = [...(summaries ?? [])].reverse()

  // ── future window: hourly forecast + weather ──────────────
  let hourly = []
  if (run?.forecast_from && run?.forecast_to) {
    const [{ data: fc, error: fErr }, { data: wx, error: wErr }] = await Promise.all([
      supabase.from('power_forecasts').select('ts, predicted_kw, lower_kw, upper_kw')
        .eq('plant_id', plant.id).eq('kind', 'day_ahead')
        .gt('ts', run.forecast_from).lte('ts', run.forecast_to).order('ts'),
      supabase.from('weather_data').select('ts, ghi_w_m2, temp_c, cloud_cover_pct, precipitation_mm')
        .eq('plant_id', plant.id).in('source', ['open-meteo', 'open-meteo-forecast'])
        .gt('ts', run.forecast_from).lte('ts', run.forecast_to).order('ts'),
    ])
    if (fErr) throw fErr
    if (wErr) throw wErr
    const weatherAt = new Map((wx ?? []).map((w) => [new Date(w.ts).getTime(), w]))
    hourly = (fc ?? []).map((f) => ({ ...f, ...keyOf(f.ts), weather: weatherAt.get(new Date(f.ts).getTime()) ?? {} }))
  }

  const totals = dailyTotals(hourly, keyOf)
  const days = [...totals.values()].map((d) => {
    const hours = hourly.filter((h) => h.day === d.day)
    const sunHours = hours.filter((h) => (h.weather.ghi_w_m2 ?? 0) > 0)
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
    return {
      day: d.day,
      mwh: r1(d.energy / 1000),
      lowerMwh: r1(d.lower / 1000),
      upperMwh: r1(d.upper / 1000),
      cloudPct: Math.round(mean(sunHours.map((h) => h.weather.cloud_cover_pct ?? 0)) ?? 0),
      rainMm: r1(hours.reduce((s, h) => s + (h.weather.precipitation_mm ?? 0), 0)),
      maxTempC: hours.length ? Math.round(Math.max(...hours.map((h) => h.weather.temp_c ?? -99))) : null,
      hours: hours.map((h) => ({
        hour: h.hour,
        label: `${String(h.hour).padStart(2, '0')}:00`,
        mw: Math.round(h.predicted_kw / 10) / 100,
        band: [Math.max(0, (h.lower_kw ?? h.predicted_kw) / 1000), (h.upper_kw ?? h.predicted_kw) / 1000],
        sun: Math.round(h.weather.ghi_w_m2 ?? 0),
      })),
    }
  })

  // ── accuracy: issued day-ahead forecasts vs what the plant produced ──
  let accuracy = recent.map((d) => ({
    day: d.day,
    actualMwh: d.energy_kwh != null ? r1(d.energy_kwh / 1000) : null,
    expectedMwh: d.expected_energy_kwh != null ? r1(d.expected_energy_kwh / 1000) : null,
    dayAheadMwh: null,
  }))
  if (recent.length) {
    const from = new Date(new Date(`${recent[0].day}T00:00:00Z`).getTime() - 86400000).toISOString()
    const to = new Date(new Date(`${recent.at(-1).day}T00:00:00Z`).getTime() + 2 * 86400000).toISOString()
    const { data: past, error: pErr } = await supabase.from('power_forecasts').select('ts, predicted_kw')
      .eq('plant_id', plant.id).eq('kind', 'day_ahead').gt('ts', from).lte('ts', to).order('ts')
    if (pErr) throw pErr
    const pastTotals = dailyTotals(past ?? [], keyOf)
    accuracy = accuracy.map((a) => {
      const p = pastTotals.get(a.day)
      return p ? { ...a, dayAheadMwh: r1(p.energy / 1000) } : a
    })
  }

  // Hidden loss: energy the plant should have made (expected model) but didn't, over the recent days
  const hiddenLossKwh = recent.reduce(
    (s, d) => s + Math.max(0, (d.expected_energy_kwh ?? 0) - (d.energy_kwh ?? 0)), 0)
  const compared = accuracy.filter((a) => a.dayAheadMwh != null && a.actualMwh > 0)
  const measuredErrorPct = compared.length
    ? r1(compared.reduce((s, a) => s + Math.abs(a.dayAheadMwh - a.actualMwh) / a.actualMwh, 0) / compared.length * 100)
    : null

  return {
    run,
    days,
    accuracy,
    recentDays: recent.length,
    hiddenLossKwh: Math.round(hiddenLossKwh),
    measuredErrorPct,
    comparedDays: compared.length,
  }
}
