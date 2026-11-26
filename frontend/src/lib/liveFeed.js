// Live data feed – owner side (Settings → Data input, dashboard live badge).
//   device_keys: listed/renamed/revoked by the browser (RLS, column grants); CREATED by the backend,
//   which returns the raw key once (only its hash is stored).
import { supabase } from './supabaseClient'
import { apiPostJson } from './api'

const KEY_COLUMNS = 'id, name, key_prefix, created_at, last_seen_at, readings_sent, revoked_at'

export async function listDevices(plantId) {
  const { data, error } = await supabase.from('device_keys').select(KEY_COLUMNS)
    .eq('plant_id', plantId).order('created_at', { ascending: false })
  return { data: data ?? [], error: error?.message }
}

/** @returns {Promise<{ error?: string, result?: { id, name, key, key_prefix } }>} */
export const createDevice = (plantId, name) => apiPostJson(`/plants/${plantId}/devices`, { name })

export async function revokeDevice(id) {
  const { error } = await supabase.from('device_keys').update({ revoked_at: new Date().toISOString() }).eq('id', id)
  return { error: error?.message }
}

/** Link the QR code opens. The key is in the #fragment, which browsers never send to a server or in Referer. */
export const deviceUrl = (key) => `${window.location.origin}/device#k=${encodeURIComponent(key)}`

export const isLocalhost = () => ['localhost', '127.0.0.1'].includes(window.location.hostname)

/** Latest live reading + device activity, for the dashboard badge (cheap: two tiny queries). */
export async function liveStatus(plantId) {
  const [{ data: reading }, { data: devices }] = await Promise.all([
    supabase.from('plant_readings').select('ts').eq('plant_id', plantId).contains('quality_flags', ['live'])
      .order('ts', { ascending: false }).limit(1),
    supabase.from('device_keys').select('last_seen_at').eq('plant_id', plantId).is('revoked_at', null)
      .not('last_seen_at', 'is', null).order('last_seen_at', { ascending: false }).limit(1),
  ])
  return { latestSlot: reading?.[0]?.ts ?? null, lastSeen: devices?.[0]?.last_seen_at ?? null }
}

export function agoText(iso, now = Date.now()) {
  if (!iso) return 'never'
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}
