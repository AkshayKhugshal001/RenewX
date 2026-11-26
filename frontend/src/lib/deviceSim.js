// Phone "device" for the live demo: SIMULATED plant readings on REAL weather (same idea as
// ML/tools/make_demo_csv.py). Nothing important is kept on the phone – readings go straight to the backend
// (Supabase plant_readings). The phone only stores, in localStorage:
//   renewx:device:key            the device key (from the QR code)
//   renewx:device:outbox:<pfx>   readings not sent yet (no signal / server waking up), sent later in batches
//   renewx:device:clock:<pfx>    time-lapse position (which 15-minute slot of today comes next)
import { API_URL } from './api'

export const TEMP_COEF = 0.004       // output drop per °C of module temperature above 25 °C
export const SLOT_MS = 15 * 60 * 1000
export const DAY_START_H = 6
export const DAY_END_H = 19
const OUTBOX_MAX = 500

// ── Storage (can throw in private mode – never break the page) ─────────
const KEY_STORE = 'renewx:device:key'
const read = (k) => { try { return localStorage.getItem(k) } catch { return null } }
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v) } catch { /* ignore */ } }

export const savedKey = () => read(KEY_STORE)
export const saveKey = (key) => write(KEY_STORE, key)
export const forgetKey = () => write(KEY_STORE, null)
const pfx = (key) => key.slice(0, 9)

export function loadOutbox(key) {
  try { return JSON.parse(read(`renewx:device:outbox:${pfx(key)}`) || '[]') } catch { return [] }
}
export function saveOutbox(key, items) {
  write(`renewx:device:outbox:${pfx(key)}`, JSON.stringify(items.slice(-OUTBOX_MAX)))
}
export function loadClock(key) {
  try { return JSON.parse(read(`renewx:device:clock:${pfx(key)}`) || 'null') } catch { return null }
}
export const saveClock = (key, clock) => write(`renewx:device:clock:${pfx(key)}`, clock ? JSON.stringify(clock) : null)

// ── Time zones without a library ───────────────────────────────────────
const partsFmt = {}
export function localParts(ms, tz) {
  partsFmt[tz] ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
  const p = Object.fromEntries(partsFmt[tz].formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, date: `${p.year}-${p.month}-${p.day}` }
}
/** UTC milliseconds of a wall-clock time in `tz`. */
export function zonedToUtc(y, m, d, h, min, tz) {
  const guess = Date.UTC(y, m - 1, d, h, min)
  const p = localParts(guess, tz)
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - guess
  return guess - offset
}
export const localHour = (ms, tz) => { const p = localParts(ms, tz); return p.h + p.min / 60 }

/** First time-lapse slot: today 06:00 in the plant's time zone. */
export function timelapseStart(tz, now = Date.now()) {
  const p = localParts(now, tz)
  return { date: p.date, next: zonedToUtc(p.y, p.m, p.d, DAY_START_H, 0, tz) }
}

// ── Weather ────────────────────────────────────────────────────────────
/** 15-minute sunlight (kW/m²) and air temperature for yesterday–tomorrow from Open-Meteo (free, no key). */
export async function fetchWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
    latitude: lat, longitude: lon, minutely_15: 'shortwave_radiation,temperature_2m',
    past_days: 1, forecast_days: 2, timezone: 'GMT', timeformat: 'unixtime',
  })
  const res = await fetch(url)
  if (!res.ok) throw new Error('weather unavailable')
  const m = (await res.json()).minutely_15
  // values describe the PRECEDING 15 minutes -> label them by their start (as in the Kaggle data)
  return m.time.map((t, i) => ({
    t: t * 1000 - SLOT_MS, ghi: Math.max(0, (m.shortwave_radiation[i] ?? 0) / 1000), amb: m.temperature_2m[i],
  }))
}

/** Clear-sky stand-in when there is no location or no internet weather. */
export function clearSky(ms, tz) {
  const h = localHour(ms, tz)
  const ghi = h > 6 && h < 18.5 ? 0.95 * Math.sin((Math.PI * (h - 6)) / 12.5) : 0
  return { ghi, amb: 22 + 7 * Math.sin((Math.PI * (h - 9)) / 12) }
}

export function weatherAt(series, ms, tz) {
  if (!series?.length || ms < series[0].t || ms > series[series.length - 1].t) return { ...clearSky(ms, tz), source: 'clear-sky' }
  let i = series.findIndex((w) => w.t > ms)
  if (i <= 0) i = series.length - 1
  const a = series[i - 1], b = series[i]
  const f = b.t === a.t ? 0 : (ms - a.t) / (b.t - a.t)
  return { ghi: a.ghi + f * (b.ghi - a.ghi), amb: (a.amb ?? 25) + f * ((b.amb ?? 25) - (a.amb ?? 25)), source: 'open-meteo' }
}

// ── Faults the demo can inject (the backend's rule alarms detect the first three) ──
export const FAULTS = [
  { id: 'inverter_trip', label: 'Inverter trip', note: 'A quarter of the inverters stop → "inverter dropout" alarm after 2 slots' },
  { id: 'sensor_fault', label: 'Sunlight sensor failure', note: 'Sensor reads 0 while producing → "sensor fault" after 2 slots' },
  { id: 'output_drop', label: 'Severe output drop', note: 'Output 40 % of normal (soiling / string fault) → "underperformance" after 1 h (4 slots)' },
  { id: 'overheating', label: 'Overheating', note: 'Modules +20 °C. No rule alarm – the ML detector finds it at the daily refresh' },
]

const noise = (sd) => {
  const u = 1 - Math.random(), v = Math.random()
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}
const r2 = (x) => Math.round(x * 100) / 100

/**
 * One reading. profile = { k (kW per kW/m² at 25 °C), heat (°C per kW/m²), inverters }, from GET /device/info.
 * wx = { ghi, amb }. Returns the body of one /ingest reading.
 */
export function simulate(ms, wx, profile, capacityKw, fault) {
  const g = Math.max(0, wx.ghi)
  let module = wx.amb + profile.heat * g + noise(0.5)
  if (fault === 'overheating') module += 20
  let ac = g > 0.005 ? profile.k * g * (1 - TEMP_COEF * (module - 25)) * (1 + noise(0.03)) : 0
  let inverters = profile.inverters
  let sensor = Math.max(0, g * (1 + noise(0.02)))
  if (fault === 'inverter_trip') {
    const off = Math.max(1, Math.ceil(inverters / 4))
    ac *= (inverters - off) / inverters
    inverters -= off
  }
  if (fault === 'output_drop') ac *= 0.4
  if (fault === 'sensor_fault') sensor = 0
  if (capacityKw > 0) ac = Math.min(ac, capacityKw * 1.05)
  ac = Math.max(0, ac)
  return {
    ts: new Date(ms).toISOString(),
    ac_power_kw: r2(ac),
    dc_power_kw: r2(ac / 0.975),
    irradiation_kw_m2: Math.round(sensor * 1000) / 1000,
    ambient_temp_c: Math.round(wx.amb * 10) / 10,
    module_temp_c: Math.round(module * 10) / 10,
    active_inverters: inverters,
  }
}

// ── Backend calls with the device key ──────────────────────────────────
async function call(path, key, init = {}) {
  let res
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...init.headers, 'X-Device-Key': key } })
  } catch {
    return { error: 'No connection to the RenewX server (offline, or the free server is waking up – about 1 min).', offline: true }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return { error: typeof json.detail === 'string' ? json.detail : `Server error ${res.status}`, status: res.status }
  return { result: json }
}

export const deviceInfo = (key) => call('/device/info', key)
export const sendReadings = (key, readings, timelapse) => call('/ingest', key, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ readings, timelapse }),
})
