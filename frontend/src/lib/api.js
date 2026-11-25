// Calls to the RenewX backend (FastAPI) with the user's Supabase login token.
import { supabase } from './supabaseClient'

export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:8000').replace(/\/$/, '')

/** @returns {Promise<{ error?: string, result?: any }>} */
export async function apiPost(path, body) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { error: 'Your session has expired. Please sign in again.' }

  let res
  try {
    res = await fetch(`${API_URL}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body })
  } catch {
    return { error: `Could not reach the RenewX backend at ${API_URL}. Make sure it is running.` }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return { error: typeof json.detail === 'string' ? json.detail : 'The request could not be processed.' }
  return { result: json }
}

export const refreshForecast = (plantId) => apiPost(`/plants/${plantId}/forecast/refresh`)
export const analyseCleaning = (plantId) => apiPost(`/plants/${plantId}/cleaning/analyse`)

async function authHeader() {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  return token ? { Authorization: `Bearer ${token}` } : null
}

/** @returns {Promise<{ error?: string, result?: any }>} */
export async function apiGet(path) {
  const headers = await authHeader()
  if (!headers) return { error: 'Your session has expired. Please sign in again.' }
  let res
  try {
    res = await fetch(`${API_URL}${path}`, { headers })
  } catch {
    return { error: `Could not reach the RenewX backend at ${API_URL}. Make sure it is running.` }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return { error: typeof json.detail === 'string' ? json.detail : 'The request could not be processed.' }
  return { result: json }
}

/** Download a file (e.g. a PDF report) from the backend and save it under `filename`. */
export async function apiDownload(path, filename) {
  const headers = await authHeader()
  if (!headers) return { error: 'Your session has expired. Please sign in again.' }
  let res
  try {
    res = await fetch(`${API_URL}${path}`, { headers })
  } catch {
    return { error: `Could not reach the RenewX backend at ${API_URL}. Make sure it is running.` }
  }
  if (!res.ok) {
    const json = await res.json().catch(() => ({}))
    return { error: typeof json.detail === 'string' ? json.detail : 'The report could not be created.' }
  }
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return {}
}
