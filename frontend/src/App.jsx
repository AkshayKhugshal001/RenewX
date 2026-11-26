import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { PlantProvider } from './context/PlantContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/layout/layout'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import PlantOverview from './pages/PlantOverview'
import CleaningCooling from './pages/CleaningCooling'
import Environment from './pages/Environment'
import Reports from './pages/Reports'
import Forecasting from './pages/Forecasting'
import Recommendations from './pages/Recommendations'
import Maintenance from './pages/Maintenance'
import Settings from './pages/Settings'
import Device from './pages/Device'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PlantProvider>
          <Routes>
            <Route path="/login" element={<Auth />} />
            {/* public: the phone authenticates with its device key, not a login */}
            <Route path="/device" element={<Device />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/plant-overview" element={<PlantOverview />} />
                <Route path="/forecasting" element={<Forecasting />} />
                <Route path="/recommendations" element={<Recommendations />} />
                <Route path="/cleaning-cooling" element={<CleaningCooling />} />
                <Route path="/maintenance" element={<Maintenance />} />
                <Route path="/environment" element={<Environment />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/anomalies" element={<Navigate to="/maintenance" replace />} />
                <Route path="/settings" element={<Settings />} />
              </Route>
            </Route>

            <Route path="*" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </PlantProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}