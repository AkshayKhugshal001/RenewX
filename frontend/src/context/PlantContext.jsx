/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from './AuthContext'
import PlantFormModal from '../components/PlantFormModal'
import UploadDataModal from '../components/UploadDataModal'
import { uploadPlantCsv } from '../lib/plantDataUpload'
import { analyseCleaning, refreshForecast } from '../lib/api'

const PlantContext = createContext(null)

const COLUMNS = '*' // all plant settings (columns are added by the SQL migrations)
const storageKey = (userId) => `renewx:active-plant:${userId}`

// localStorage can throw (private mode, blocked storage) – never let that break the app
const readSaved = (userId) => {
  try { return localStorage.getItem(storageKey(userId)) } catch { return null }
}
const writeSaved = (userId, id) => {
  try { localStorage.setItem(storageKey(userId), id) } catch { /* ignore */ }
}

const optionalNumber = (x) => (x === '' || x === null || x === undefined ? null : Number(x))

const toRow = (v) => ({
  name: v.name.trim(),
  location: v.location?.trim() || null,
  capacity_mw: Number(v.capacity_mw) || 0,
  grid_connected: Boolean(v.grid_connected),
  status: v.status,
  latitude: optionalNumber(v.latitude),
  longitude: optionalNumber(v.longitude),
  tariff_inr_per_kwh: Number(v.tariff_inr_per_kwh) || 0,
  timezone: v.timezone || 'Asia/Kolkata',
  ...(v.battery_capacity_mwh !== undefined && {
    battery_capacity_mwh: Number(v.battery_capacity_mwh) || 0,
    battery_power_mw: Number(v.battery_power_mw) || 0,
  }),
  ...(v.cleaning_cost_inr_per_mw !== undefined && {
    cleaning_cost_inr_per_mw: Number(v.cleaning_cost_inr_per_mw) || 0,
    cleaning_water_l_per_mw: Number(v.cleaning_water_l_per_mw) || 0,
  }),
})

const friendlyError = (error) =>
  error.code === '23505' ? 'You already have a plant with that name.' : error.message

export function PlantProvider({ children }) {
  const { user } = useAuth()
  const userId = user?.id ?? null

  const [plants, setPlants] = useState([])
  const [selectedId, setSelectedId] = useState(null)
  const [loadedFor, setLoadedFor] = useState(null) // which user the `plants` state belongs to
  const [loadError, setLoadError] = useState('')
  const [modal, setModal] = useState(null) // null | { plant: null (add) | plantRow (edit) }
  const [uploadFor, setUploadFor] = useState(null) // null | plantRow whose data is being uploaded
  const [dataVersion, setDataVersion] = useState(0) // bumped after every successful upload -> pages refetch
  const notifyDataChanged = useCallback(() => setDataVersion((v) => v + 1), [])
  // New forecast in the background (e.g. after the location or capacity changed); pages refetch when done
  const refreshInBackground = useCallback(
    (id) => refreshForecast(id).then((res) => !res.error && notifyDataChanged()),
    [notifyDataChanged],
  )

  // Load this user's plants (RLS also guarantees only their own rows come back)
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    supabase
      .from('plants')
      .select(COLUMNS)
      .eq('owner_id', userId)
      .order('created_at')
      .then(({ data, error }) => {
        if (cancelled) return
        setLoadError(error?.message ?? '')
        setPlants(data ?? [])
        setSelectedId(readSaved(userId)) // restore last-used plant
        setLoadedFor(userId)
      })
    return () => { cancelled = true }
  }, [userId])

  // Derived state: never show another user's plants, and always fall back to a valid plant
  const list = useMemo(() => (loadedFor === userId ? plants : []), [loadedFor, userId, plants])
  const loading = Boolean(userId) && loadedFor !== userId
  const activePlant = list.find((p) => p.id === selectedId) ?? list[0] ?? null

  const selectPlant = useCallback(
    (id) => {
      setSelectedId(id)
      if (userId && id) writeSaved(userId, id)
    },
    [userId],
  )

  const addPlant = useCallback(
    async (values, csvFile) => {
      const { data, error } = await supabase
        .from('plants')
        .insert({ ...toRow(values), owner_id: userId })
        .select(COLUMNS)
        .single()
      if (error) return { error: friendlyError(error) }
      setPlants((prev) => [...prev, data])
      selectPlant(data.id) // jump straight to the plant that was just created

      // Optional historical CSV. The plant already exists, so a failed upload must not undo it.
      if (csvFile) {
        const res = await uploadPlantCsv(data.id, csvFile, 'historical')
        if (res.error) return { data, uploadError: res.error }
        notifyDataChanged() // the upload already refreshed the forecast
      } else if (data.latitude != null && data.capacity_mw > 0) {
        refreshInBackground(data.id) // a new plant gets a physics-based forecast straight away
      }
      return { data }
    },
    [userId, selectPlant, notifyDataChanged, refreshInBackground],
  )

  const updatePlant = useCallback(
    async (id, values) => {
      const before = plants.find((p) => p.id === id)
      const { data, error } = await supabase
        .from('plants')
        .update(toRow(values))
        .eq('id', id)
        .select(COLUMNS)
        .single()
      if (error) return { error: friendlyError(error) }
      setPlants((prev) => prev.map((p) => (p.id === id ? data : p)))
      const changed = ['latitude', 'longitude', 'capacity_mw', 'timezone'].some((k) => String(before?.[k]) !== String(data[k]))
      if (changed && data.latitude != null) refreshInBackground(id) // forecasts depend on these
      const costs = ['cleaning_cost_inr_per_mw', 'cleaning_water_l_per_mw', 'tariff_inr_per_kwh', 'battery_capacity_mwh', 'battery_power_mw']
        .some((k) => String(before?.[k]) !== String(data[k]))
      if (costs && !changed) analyseCleaning(id).then((res) => !res.error && notifyDataChanged())
      return { data }
    },
    [plants, refreshInBackground, notifyDataChanged],
  )

  // 'manual' (CSV uploads) | 'live' (devices may send readings to /ingest) – column from 010_live_feed.sql
  const setDataMode = useCallback(async (id, mode) => {
    const { data, error } = await supabase.from('plants').update({ data_mode: mode }).eq('id', id).select(COLUMNS).single()
    if (error) return { error: friendlyError(error) }
    setPlants((prev) => prev.map((p) => (p.id === id ? data : p)))
    return { data }
  }, [])

  const deletePlant = useCallback(async (id) => {
    const { error } = await supabase.from('plants').delete().eq('id', id)
    if (error) return { error: friendlyError(error) }
    // if the deleted plant was active, `activePlant` automatically falls back to the first remaining one
    setPlants((prev) => prev.filter((p) => p.id !== id))
    return {}
  }, [])

  const value = useMemo(
    () => ({
      plants: list,
      activePlant,
      loading,
      loadError,
      selectPlant,
      addPlant,
      updatePlant,
      deletePlant,
      setDataMode,
      openAddPlant: () => setModal({ plant: null }),
      openEditPlant: (plant) => setModal({ plant }),
      openUploadData: (plant) => setUploadFor(plant),
      dataVersion,
      notifyDataChanged,
    }),
    [list, activePlant, loading, loadError, selectPlant, addPlant, updatePlant, deletePlant, setDataMode, dataVersion, notifyDataChanged],
  )

  return (
    <PlantContext.Provider value={value}>
      {children}
      {modal && (
        <PlantFormModal
          plant={modal.plant}
          onClose={() => setModal(null)}
          onSubmit={(values, csvFile) => (modal.plant ? updatePlant(modal.plant.id, values) : addPlant(values, csvFile))}
        />
      )}
      {uploadFor && (
        <UploadDataModal plant={uploadFor} onClose={() => setUploadFor(null)} onUploaded={notifyDataChanged} />
      )}
    </PlantContext.Provider>
  )
}

export function usePlants() {
  const ctx = useContext(PlantContext)
  if (!ctx) throw new Error('usePlants must be used inside <PlantProvider>')
  return ctx
}