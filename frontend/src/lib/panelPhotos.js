// Panel photos – prototype of a fixed plant camera.
// A real plant would photograph the same panels every day and compare each capture with a clean reference.
// Here an uploaded (or sample) photo simulates a capture. The backend only analyses (OpenCV); the browser stores
// the photo + analysed overlay in Supabase Storage ("panel-images/<plant_id>/…") and the result in panel_inspections.
import { supabase } from './supabaseClient'
import { apiPost } from './api'

const BUCKET = 'panel-images'
const SAMPLE_DIR = '/samples/panels'

// Sample before/after pairs (frontend/public/samples/panels). Imported last = shown as the latest capture.
export const SAMPLE_PAIRS = [
  { id: 'e', label: 'Sand on panels (illustrative image)' },
  { id: 'c', label: 'Dusty panel row (illustrative image)' },
  { id: 'd', label: 'Bird droppings' },
  { id: 'b', label: 'Single panel – dust patches' },
  { id: 'a', label: 'Rooftop array – dust film' },
]

const b64ToBlob = (b64, type = 'image/jpeg') => {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type })
}

/** All photos of a plant, newest first, with temporary (1 h) links to the images. */
export async function fetchPhotos(plant) {
  if (!plant?.id) return []
  const { data, error } = await supabase.from('panel_inspections').select('*').eq('plant_id', plant.id)
    .order('taken_on', { ascending: false }).order('created_at', { ascending: false }).limit(100)
  if (error) throw error
  const rows = data ?? []
  const paths = rows.flatMap((r) => [r.image_path, r.overlay_path]).filter(Boolean)
  const urls = {}
  if (paths.length) {
    const { data: signed } = await supabase.storage.from(BUCKET).createSignedUrls(paths, 3600)
    for (const s of signed ?? []) if (s.signedUrl) urls[s.path] = s.signedUrl
  }
  return rows.map((r) => ({ ...r, imageUrl: urls[r.image_path], overlayUrl: urls[r.overlay_path] }))
}

/** OpenCV analysis on the backend (optionally against a clean reference photo). */
export function analysePhoto(plantId, image, reference) {
  const body = new FormData()
  body.append('image', image, image.name || 'photo.jpg')
  if (reference) body.append('reference', reference, 'reference.jpg')
  return apiPost(`/plants/${plantId}/panel-photos/analyse`, body)
}

async function downloadPhoto(path) {
  const { data, error } = await supabase.storage.from(BUCKET).download(path)
  if (error) throw new Error(`Could not load the reference photo: ${error.message}`)
  return data
}

async function upload(path, blob) {
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: false })
  if (error) throw new Error(`Photo upload failed: ${error.message}`)
}

/**
 * Analyse + store one photo.
 * @param {{ file: Blob, kind: 'reference'|'inspection', takenOn: string, reference?: object, label?: string }} p
 */
export async function addPhoto(plantId, { file, kind, takenOn, reference, label }) {
  const refBlob = kind === 'inspection' && reference ? await downloadPhoto(reference.image_path) : null
  const res = await analysePhoto(plantId, file, refBlob)
  if (res.error) return { error: res.error }
  const { overlay_jpeg_b64: overlay, ...result } = res.result
  const id = crypto.randomUUID()
  const ext = (file.type || '').includes('png') ? 'png' : (file.type || '').includes('webp') ? 'webp' : 'jpg'
  const imagePath = `${plantId}/${id}.${ext}`
  const overlayPath = `${plantId}/${id}_analysed.jpg`
  try {
    await upload(imagePath, file)
    await upload(overlayPath, b64ToBlob(overlay))
  } catch (e) {
    return { error: e.message }
  }
  const { data, error } = await supabase.from('panel_inspections').insert({
    plant_id: plantId, kind, taken_on: takenOn, image_path: imagePath, overlay_path: overlayPath,
    reference_id: kind === 'inspection' ? reference?.id ?? null : null, label: label || null, result,
  }).select('*').single()
  if (error) {
    await supabase.storage.from(BUCKET).remove([imagePath, overlayPath])
    return { error: error.message }
  }
  return { data }
}

export async function deletePhoto(row) {
  const { error } = await supabase.from('panel_inspections').delete().eq('id', row.id)
  if (error) return { error: error.message }
  await supabase.storage.from(BUCKET).remove([row.image_path, row.overlay_path].filter(Boolean))
  return {}
}

/** Load the sample pairs: clean photo = reference (after the last cleaning), dirty photo = latest capture. */
export async function importSamples(plantId, { referenceDate, captureDate }, onProgress) {
  for (const [i, pair] of SAMPLE_PAIRS.entries()) {
    onProgress?.(`Analysing sample ${i + 1} of ${SAMPLE_PAIRS.length}: ${pair.label}…`)
    const get = async (kind) => {
      const r = await fetch(`${SAMPLE_DIR}/pair_${pair.id}_${kind}.jpg`)
      if (!r.ok) throw new Error('Sample photos not found in the app.')
      return new File([await r.blob()], `pair_${pair.id}_${kind}.jpg`, { type: 'image/jpeg' })
    }
    const ref = await addPhoto(plantId, { file: await get('clean'), kind: 'reference', takenOn: referenceDate, label: `${pair.label} – clean` })
    if (ref.error) return { error: ref.error }
    const cap = await addPhoto(plantId, {
      file: await get('dirty'), kind: 'inspection', takenOn: captureDate, reference: ref.data, label: pair.label,
    })
    if (cap.error) return { error: cap.error }
  }
  return {}
}
