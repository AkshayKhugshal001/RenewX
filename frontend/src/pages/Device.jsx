// /device – the phone acts as a SIMULATED plant data logger for the live demo (public page, no login).
// It authenticates with the device key from the QR code (Settings → Data input) and sends readings to
// POST /ingest. See lib/deviceSim.js for what is stored on the phone (only the key + an unsent-readings queue).
import { useCallback, useEffect, useRef, useState } from 'react'
import { Radio, Play, Pause, RotateCcw, Zap, Sun, Thermometer, Cpu, WifiOff, AlertTriangle, KeyRound } from 'lucide-react'
import {
  DAY_END_H, FAULTS, SLOT_MS, deviceInfo, fetchWeather, forgetKey, loadClock, loadOutbox, localParts, saveClock,
  saveKey, saveOutbox, savedKey, sendReadings, simulate, timelapseStart, weatherAt, zonedToUtc,
} from '../lib/deviceSim'

const PERIOD = { realtime: 10000, timelapse: 4000 }
const fmt = (n, d = 0) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: d })

function keyFromHash() {
  const m = window.location.hash.match(/[#&]k=([^&]+)/)
  if (!m) return null
  window.history.replaceState(null, '', window.location.pathname) // keep the key out of the address bar / screenshots
  return decodeURIComponent(m[1])
}

export default function Device() {
  const [key, setKey] = useState(() => {
    const k = keyFromHash()
    if (k) saveKey(k)
    return k || savedKey()
  })
  const [pasted, setPasted] = useState('')
  const [info, setInfo] = useState(null)
  const [infoError, setInfoError] = useState('')
  const [weather, setWeather] = useState(null)
  const [mode, setMode] = useState('timelapse')
  const [source, setSource] = useState('weather') // weather | manual
  const [manual, setManual] = useState({ ghi: 0.8, amb: 30 })
  const [fault, setFault] = useState(null)
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState({ text: 'Paused', tone: '' })
  const [last, setLast] = useState(null)       // last simulated reading
  const [reply, setReply] = useState(null)     // last server reply
  const [queued, setQueued] = useState(() => (key ? loadOutbox(key).length : 0))
  const [clock, setClock] = useState(() => (key ? loadClock(key) : null))
  const busy = useRef(false)

  const tz = info?.plant.timezone || 'Asia/Kolkata'

  // Plant facts + profile (retried while the free server wakes up)
  useEffect(() => {
    if (!key) return
    let cancelled = false, timer
    const load = async () => {
      const res = await deviceInfo(key)
      if (cancelled) return
      if (res.result) { setInfo(res.result); setInfoError('') }
      else {
        setInfoError(res.error)
        if (res.offline || res.status >= 500) timer = setTimeout(load, 8000)
      }
    }
    load()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [key])

  // Real weather at the plant (refreshed every 30 min); clear-sky stand-in if unavailable
  useEffect(() => {
    const p = info?.plant
    if (p?.latitude == null) return
    let cancelled = false
    const load = () => fetchWeather(p.latitude, p.longitude).then((w) => !cancelled && setWeather(w)).catch(() => {})
    load()
    const t = setInterval(load, 30 * 60 * 1000)
    return () => { cancelled = true; clearInterval(t) }
  }, [info])

  const flush = useCallback(async () => {
    if (busy.current) return
    const box = loadOutbox(key)
    if (!box.length) return
    const tl = box[0].tl
    let n = 0
    while (n < box.length && n < (info?.limits.max_batch ?? 96) && box[n].tl === tl) n++
    busy.current = true
    const res = await sendReadings(key, box.slice(0, n).map((x) => x.r), tl)
    busy.current = false
    const rest = () => loadOutbox(key).slice(n)
    if (res.result) {
      saveOutbox(key, rest())
      setReply(res.result)
      setStatus({ text: `Sent ${res.result.accepted} reading${res.result.accepted > 1 ? 's' : ''}`, tone: 'ok' })
    } else if (res.status === 422) {
      saveOutbox(key, rest()) // invalid batch – drop it, otherwise it would block the queue forever
      setStatus({ text: res.error, tone: 'error' })
    } else if (res.status === 401 || res.status === 409) {
      setRunning(false)
      setStatus({ text: res.error, tone: 'error' })
    } else {
      setStatus({ text: res.error, tone: res.offline ? 'warn' : 'error' }) // kept in the queue, retried next tick
    }
    setQueued(loadOutbox(key).length)
  }, [key, info])

  const tick = useCallback(() => {
    if (!info) return
    let ms = Date.now()
    if (mode === 'timelapse') {
      let c = loadClock(key)
      if (!c || c.date !== localParts(Date.now(), tz).date) c = timelapseStart(tz)
      const p = localParts(c.next, tz)
      if (c.next >= zonedToUtc(p.y, p.m, p.d, DAY_END_H, 0, tz)) {
        setRunning(false)
        setStatus({ text: 'Day complete (06:00–19:00). Press “Restart day” to run it again.', tone: 'ok' })
        return flush()
      }
      ms = c.next
      c = { ...c, next: c.next + SLOT_MS }
      saveClock(key, c)
      setClock(c)
    }
    const wx = source === 'manual' ? manual : weatherAt(weather, ms, tz)
    const r = simulate(ms, wx, info.profile, info.plant.capacity_kw, fault)
    setLast({ ...r, source: source === 'manual' ? 'manual' : wx.source })
    saveOutbox(key, [...loadOutbox(key), { r, tl: mode === 'timelapse' }])
    setQueued(loadOutbox(key).length)
    flush()
  }, [info, mode, key, tz, source, manual, weather, fault, flush])

  // the loop: always calls the latest tick (settings can change while running)
  const tickRef = useRef(tick)
  useEffect(() => { tickRef.current = tick }, [tick])
  useEffect(() => {
    if (!running) return
    tickRef.current()
    const t = setInterval(() => tickRef.current(), PERIOD[mode])
    return () => clearInterval(t)
  }, [running, mode])

  function restartDay() {
    const c = timelapseStart(tz)
    saveClock(key, c)
    setClock(c)
    setStatus({ text: 'Time-lapse restarts at 06:00 today (existing slots are overwritten).', tone: '' })
  }

  function connectKey(e) {
    e.preventDefault()
    const k = pasted.trim()
    if (!k.startsWith('rx_')) return setInfoError('A device key starts with “rx_”.')
    saveKey(k)
    setKey(k)
    setQueued(loadOutbox(k).length)
    setClock(loadClock(k))
  }

  function forget() {
    if (!window.confirm('Forget this device key on this phone? Unsent readings are discarded.')) return
    saveOutbox(key, [])
    saveClock(key, null)
    forgetKey()
    setRunning(false)
    setKey(null)
    setInfo(null)
  }

  if (!key) {
    return (
      <main className="device">
        <header className="device-head"><Radio size={20} /> <strong>RenewX Device</strong></header>
        <form className="card device-card" onSubmit={connectKey}>
          <h2><KeyRound size={18} /> Connect this phone</h2>
          <p className="muted-text">Scan the QR code in RenewX → Settings → Data input, or paste the device key.</p>
          <label className="field">Device key
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="rx_…" autoComplete="off" />
          </label>
          {infoError && <p className="msg error">{infoError}</p>}
          <button className="btn primary">Connect</button>
        </form>
      </main>
    )
  }

  const slotLabel = clock ? new Date(clock.next).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' }) : '06:00'
  const statusIcon = status.tone === 'warn' ? <WifiOff size={15} /> : status.tone === 'error' ? <AlertTriangle size={15} /> : null

  return (
    <main className="device">
      <header className="device-head">
        <span className={`live-dot ${running ? 'on' : ''}`} />
        <strong>RenewX Device</strong>
        <small>{info ? info.plant.name : 'Connecting…'} · key {key.slice(0, 9)}…</small>
      </header>

      {!info && <p className={`msg ${infoError ? 'error' : ''}`}>{infoError || 'Connecting to the RenewX server…'}</p>}
      {info?.plant.data_mode === 'manual' && (
        <p className="msg error">This plant is in manual mode. Switch it to Live in Settings → Data input, then press Start.</p>
      )}

      <section className="card device-card">
        <div className="device-actions">
          <button className="btn primary" disabled={!info} onClick={() => setRunning((r) => !r)}>
            {running ? <><Pause size={16} /> Pause</> : <><Play size={16} /> Start sending</>}
          </button>
          {mode === 'timelapse' && <button className="btn" disabled={!info} onClick={restartDay}><RotateCcw size={15} /> Restart day</button>}
        </div>
        <p className={`device-status ${status.tone}`}>{statusIcon} {status.text}</p>
        <p className="muted-text">
          {mode === 'timelapse' ? `Next slot ${slotLabel} · ` : ''}Queued (not sent yet): {queued}
        </p>
      </section>

      <section className="card device-card">
        <h2>Mode</h2>
        <div className="seg">
          <button className={mode === 'timelapse' ? 'on' : ''} onClick={() => setMode('timelapse')}>Time-lapse</button>
          <button className={mode === 'realtime' ? 'on' : ''} onClick={() => setMode('realtime')}>Real time</button>
        </div>
        <p className="muted-text">
          {mode === 'timelapse'
            ? 'Every 4 s = the next 15 minutes of today (06:00 → 19:00 in ~3.5 min). For the demo.'
            : 'A reading every 10 s with the real clock; each 15-minute slot keeps the latest value.'}
        </p>
        <h2>Sunlight &amp; temperature</h2>
        <div className="seg">
          <button className={source === 'weather' ? 'on' : ''} onClick={() => setSource('weather')}>Real weather</button>
          <button className={source === 'manual' ? 'on' : ''} onClick={() => setSource('manual')}>Sliders</button>
        </div>
        {source === 'manual' ? (
          <>
            <label className="field">Sunlight {fmt(manual.ghi * 1000)} W/m²
              <input type="range" min="0" max="1.1" step="0.01" value={manual.ghi} onChange={(e) => setManual((m) => ({ ...m, ghi: +e.target.value }))} />
            </label>
            <label className="field">Air temperature {fmt(manual.amb)} °C
              <input type="range" min="0" max="50" step="1" value={manual.amb} onChange={(e) => setManual((m) => ({ ...m, amb: +e.target.value }))} />
            </label>
          </>
        ) : (
          <p className="muted-text">
            {weather ? 'Open-Meteo weather at the plant location.' : 'No weather (no plant location / offline) – clear-sky curve used.'}
          </p>
        )}
      </section>

      <section className="card device-card">
        <h2>Inject a fault</h2>
        <div className="fault-list">
          {FAULTS.map((f) => (
            <button key={f.id} className={`fault ${fault === f.id ? 'on' : ''}`} onClick={() => setFault((x) => (x === f.id ? null : f.id))}>
              <strong>{f.label}</strong><small>{f.note}</small>
            </button>
          ))}
        </div>
      </section>

      {last && (
        <section className="card device-card">
          <h2>Last reading <small>{new Date(last.ts).toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' })}</small></h2>
          <ul className="device-values">
            <li><Zap size={16} /> AC power <b>{fmt(last.ac_power_kw)} kW</b></li>
            <li><Sun size={16} /> Sunlight <b>{fmt(last.irradiation_kw_m2 * 1000)} W/m²</b></li>
            <li><Thermometer size={16} /> Module / air <b>{fmt(last.module_temp_c, 1)} / {fmt(last.ambient_temp_c, 1)} °C</b></li>
            <li><Cpu size={16} /> Inverters online <b>{last.active_inverters} / {info?.profile.inverters}</b></li>
          </ul>
        </section>
      )}

      {reply && (
        <section className="card device-card">
          <h2>RenewX says</h2>
          <p className="muted-text">Today so far: <b>{fmt(reply.energy_kwh)} kWh</b>, peak {fmt(reply.peak_ac_kw)} kW</p>
          {reply.alarms.length === 0
            ? <p className="muted-text">No alarms today.</p>
            : <ul className="device-alarms">{reply.alarms.map((a) => <li key={a.type + a.explanation} className={a.severity}>{a.explanation}</li>)}</ul>}
        </section>
      )}

      <footer className="device-foot">
        <p>Simulated device: values = real weather × this plant&apos;s own output profile{info && !info.profile.from_data ? ' (assumed – no plant data yet)' : ''}.</p>
        <button className="btn sm" onClick={forget}>Forget this device</button>
      </footer>
    </main>
  )
}
