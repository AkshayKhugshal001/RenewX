import { Suspense } from 'react'
import { Outlet } from 'react-router-dom'
import { Plus } from 'lucide-react'
import Sidebar from './sidebar'
import Header from './header'
import { usePlants } from '../../context/PlantContext'
import AssistantChat from '../AssistantChat'

export default function Layout() {
  const { plants, activePlant, loading, loadError, openAddPlant } = usePlants()

  return (
    <div className="app">
      <Sidebar />
      <div className="main">
        <Header />
        <main className="content">
          {loadError && <p className="msg error">Could not load your plants: {loadError}</p>}

          {!loading && !loadError && plants.length === 0 && (
            <div className="card empty-plants">
              <div>
                <h2>Add your first plant</h2>
                <p>Create a plant to start tracking generation, losses and recommendations. You can add as many as you need and switch between them from the plant menu at the top.</p>
              </div>
              <button className="btn primary" onClick={openAddPlant}>
                <Plus size={16} /> Add plant
              </button>
            </div>
          )}

          {/* `plant` is the active plant – pages read it with useOutletContext() */}
          {/* only the page area waits while a page's code downloads – sidebar and header stay */}
          <Suspense fallback={<p className="empty">Loading…</p>}>
            <Outlet context={{ plant: activePlant }} />
          </Suspense>
        </main>
      </div>
      <AssistantChat />
    </div>
  )
}