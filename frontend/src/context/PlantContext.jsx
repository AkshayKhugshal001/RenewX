/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from './AuthContext'
import PlantFormModal from '../components/PlantFormModal'

const PlantContext = createContext(null)

const COLUMNS = 'id, name, location, capacity_mw, grid_connected, status, created_at'
const storageKey = (userId) => `renewx:active-plant:${userId}`

// localStorage can throw (private mode, blocked storage) – never let that break the app
const readSaved = (userId) => {
  try { return localStorage.getItem(storageKey(userId)) } catch { return null }
}
const writeSaved = (userId, id) => {
  try { localStorage.setItem(storageKey(userId), id) } catch { /* ignore */ }
}

const toRow = (v) => ({
  name: v.name.trim(),
  location: v.location?.trim() || null,
  capacity_mw: Number(v.capacity_mw) || 0,
  grid_connected: Boolean(v.grid_connected),
  status: v.status,
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
    async (values) => {
      const { data, error } = await supabase
        .from('plants')
        .insert({ ...toRow(values), owner_id: userId })
        .select(COLUMNS)
        .single()
      if (error) return { error: friendlyError(error) }
      setPlants((prev) => [...prev, data])
      selectPlant(data.id) // jump straight to the plant that was just created
      return { data }
    },
    [userId, selectPlant],
  )

  const updatePlant = useCallback(async (id, values) => {
    const { data, error } = await supabase
      .from('plants')
      .update(toRow(values))
      .eq('id', id)
      .select(COLUMNS)
      .single()
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
      openAddPlant: () => setModal({ plant: null }),
      openEditPlant: (plant) => setModal({ plant }),
    }),
    [list, activePlant, loading, loadError, selectPlant, addPlant, updatePlant, deletePlant],
  )

  return (
    <PlantContext.Provider value={value}>
      {children}
      {modal && (
        <PlantFormModal
          plant={modal.plant}
          onClose={() => setModal(null)}
          onSubmit={(values) => (modal.plant ? updatePlant(modal.plant.id, values) : addPlant(values))}
        />
      )}
    </PlantContext.Provider>
  )
}

export function usePlants() {
  const ctx = useContext(PlantContext)
  if (!ctx) throw new Error('usePlants must be used inside <PlantProvider>')
  return ctx
}