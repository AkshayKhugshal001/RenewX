import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { PlantProvider } from './context/PlantContext'
import ProtectedRoute from './components/ProtectedRoute'
import PagePlaceholder from './components/PagePlaceholder'
import Layout from './components/layout/layout'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Analytics from './pages/Analytics'
import Anomalies from './pages/Anomalies'
import Optimization from './pages/Optimization'
import Maintenance from './pages/Maintenance'
import Settings from './pages/Settings'

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <PlantProvider>
          <Routes>
            <Route path="/login" element={<Auth />} />

            <Route element={<ProtectedRoute />}>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/plant-overview" element={<PagePlaceholder title="Plant Overview" />} />
                <Route path="/forecasting" element={<Analytics />} />
                <Route path="/recommendations" element={<Optimization />} />
                <Route path="/cleaning-cooling" element={<PagePlaceholder title="Cleaning & Cooling" />} />
                <Route path="/maintenance" element={<Maintenance />} />
                <Route path="/environment" element={<PagePlaceholder title="Environment" />} />
                <Route path="/reports" element={<PagePlaceholder title="Reports" />} />
                <Route path="/anomalies" element={<Anomalies />} />
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