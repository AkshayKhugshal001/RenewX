// CSV upload for plant data (historical or daily add-on).
// The file is sent to the RenewX backend (FastAPI), which cleans it, stores the readings in Supabase,
// recalculates daily statistics + alarms for the days it covers, and refreshes the forecast.
import { API_URL, apiPost } from './api'

export const MAX_CSV_MB = 50

export function validateCsvFile(file) {
  if (!file) return 'Please choose a CSV file.'
  const isCsv = /\.csv$/i.test(file.name) || ['text/csv', 'application/vnd.ms-excel'].includes(file.type)
  if (!isCsv) return 'Only .csv files are supported.'
  if (file.size === 0) return 'That file is empty.'
  if (file.size > MAX_CSV_MB * 1024 * 1024) return `File is too large (max ${MAX_CSV_MB} MB).`
  return ''
}

export const formatSize = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

/**
 * @param {string} plantId
 * @param {File}   file
 * @param {'historical' | 'daily'} kind
 * @param {'skip' | 'replace'} mode  what to do with timestamps that are already stored
 * @returns {Promise<{ error?: string, result?: object }>}  result = the backend's upload report
 */
export async function uploadPlantCsv(plantId, file, kind, mode = 'skip') {
  const send = () => {
    const body = new FormData()
    body.append('file', file)
    body.append('kind', kind)
    body.append('mode', mode)
    return apiPost(`/plants/${plantId}/uploads`, body)
  }

  // An unstable connection can drop a large upload before it reaches the server. Such a failure comes back
  // within seconds, so it is retried (up to 3 tries). A failure after a long wait may mean the server was still
  // processing the file, so that one is NOT retried. Retrying is safe anyway: rows that already exist are skipped
  // (or replaced with the same values).
  let res, slow = false
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    res = await send()
    slow = Date.now() - started > 30000
    if (!res.network || slow) break
    if (attempt < 3) await sleep(attempt * 3000)
  }
  if (!res.network) return res
  if (slow) {
    return {
      error: 'The connection was lost while the server was processing the file. It has probably been saved – '
        + 'wait a minute and reload the page before uploading again.',
    }
  }

  // Tell "your connection dropped" apart from "the server is down/asleep"
  if (await serverAwake()) {
    return {
      error: 'Your internet connection dropped while sending the file (tried 3 times). The RenewX server is running – '
        + 'check your connection (or switch network) and try again.',
    }
  }
  return {
    error: 'The RenewX server is not responding. The free server may still be waking up (about 1 minute) – try again shortly.',
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function serverAwake() {
  try {
    const r = await fetch(`${API_URL}/health`, { cache: 'no-store' })
    return r.ok
  } catch {
    return false
  }
}
