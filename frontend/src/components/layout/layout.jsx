import { useEffect, useState } from 'react'
import { Outlet } from 'react-router-dom'
import Sidebar from './sidebar'
import Header from './header'
import { supabase } from '../../lib/supabaseClient'
import { useAuth } from '../../context/AuthContext'

export default function Layout() {
  const { user } = useAuth()
  const [plants, setPlants] = useState([])
  const [plantId, setPlantId] = useState(null)

  // RLS guarantees this only returns the logged-in user's own plants
  useEffect(() => {
    if (!user) return
    supabase
      .from('plants')
      .select('id, name, capacity_mw, grid_connected, status')
      .order('created_at')
      .then(({ data }) => {
        setPlants(data ?? [])
        setPlantId((current) => current ?? data?.[0]?.id ?? null)
      })
  }, [user])

  const plant = plants.find((p) => p.id === plantId) ?? null

  return (
    <div className="app">
      <Sidebar plants={plants} plantId={plantId} onPlantChange={setPlantId} />
      <div className="main">
        <Header />
        <main className="content">
          <Outlet context={{ plant }} />
        </main>
      </div>
    </div>
  )
}
