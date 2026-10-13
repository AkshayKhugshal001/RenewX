// CSV upload for plant data (historical or daily add-on).
//
// Right now this only checks the file and hands it over. Parsing + saving to Supabase
// (and the table that stores it) will be added later – replace the body of
// uploadPlantCsv() and keep the same signature, so no UI code has to change.

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
 * @returns {Promise<{ error?: string, message?: string }>}
 */
// eslint-disable-next-line no-unused-vars
export async function uploadPlantCsv(plantId, file, kind) {
  // TODO: parse the CSV and save the rows for this plant (table not created yet).
  return { message: 'File accepted. Saving is not connected yet, so nothing has been stored.' }
}
