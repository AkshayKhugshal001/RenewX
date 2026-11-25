// CSV upload for plant data (historical or daily add-on).
// The file is sent to the RenewX backend (FastAPI), which cleans it, stores the readings in Supabase,
// recalculates daily statistics + alarms for the days it covers, and refreshes the forecast.
import { apiPost } from './api'

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
export function uploadPlantCsv(plantId, file, kind, mode = 'skip') {
  const body = new FormData()
  body.append('file', file)
  body.append('kind', kind)
  body.append('mode', mode)
  return apiPost(`/plants/${plantId}/uploads`, body)
}
