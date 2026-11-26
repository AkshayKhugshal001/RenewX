import { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { PlantProvider } from './context/PlantContext'
import ProtectedRoute from './components/ProtectedRoute'
import Layout from './components/layout/layout'
import Auth from './pages/Auth'
import ResetPassword from './pages/ResetPassword'

// Each page is its own file download, so the first visit only loads what it needs.
// After start-up the other pages are fetched in the background (preloadPages), so switching stays instant.
const pages = {
  Dashboard: () => import('./pages/Dashboard'),
  PlantOverview: () => import('./pages/PlantOverview'),
  Forecasting: () => import('./pages/Forecasting'),
  Recommendations: () => import('./pages/Recommendations'),
  CleaningCooling: () => import('./pages/CleaningCooling'),
  Maintenance: () => import('./pages/Maintenance'),
  Environment: () => import('./pages/Environment'),
  Reports: () => import('./pages/Reports'),
  Settings: () => import('./pages/Settings'),
  Device: () => import('./pages/Device'),
}
const Dashboard = lazy(pages.Dashboard)
const PlantOverview = lazy(pages.PlantOverview)
const Forecasting = lazy(pages.Forecasting)
const Recommendations = lazy(pages.Recommendations)
const CleaningCooling = lazy(pages.CleaningCooling)
const Maintenance = lazy(pages.Maintenance)
const Environment = lazy(pages.Environment)
const Reports = lazy(pages.Reports)
const Settings = lazy(pages.Settings)
const Device = lazy(pages.Device)

function preloadPages() {
  const run = () => Object.entries(pages).forEach(([name, load]) => name !== 'Device' && load().catch(() => {}))
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 4000 })
  else setTimeout(run, 2000)
}

const fallback = <p className="splash">Loading…</p>

export default function App() {
  useEffect(() => {
    if (!['/device', '/reset-password'].includes(window.location.pathname)) preloadPages() // the phone page doesn't need the dashboard
  }, [])

  return (
    <BrowserRouter>
      <AuthProvider>
        <PlantProvider>
          <Suspense fallback={fallback}>
            <Routes>
              <Route path="/login" element={<Auth />} />
              <Route path="/reset-password" element={<ResetPassword />} />
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
          </Suspense>
        </PlantProvider>
      </AuthProvider>
    </BrowserRouter>
  )
}
