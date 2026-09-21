import { Outlet } from 'react-router-dom'
import { Plus } from 'lucide-react'
import Sidebar from './sidebar'
import Header from './header'
import { usePlants } from '../../context/PlantContext'

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
                <p>Create a plant to start tracking generation, losses and recommendations. You can add as many as you need and switch between them from the sidebar.</p>
              </div>
              <button className="btn primary" onClick={openAddPlant}>
                <Plus size={16} /> Add plant
              </button>
            </div>
          )}

          {/* `plant` is the active plant – pages read it with useOutletContext() */}
          <Outlet context={{ plant: activePlant }} />
        </main>
      </div>
    </div>
  )
}