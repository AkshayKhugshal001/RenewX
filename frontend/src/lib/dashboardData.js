// Placeholder data source. Every value is zero until the real dataset / tables exist.
// When your tables are ready, replace the body of fetchDashboard() with Supabase queries
// (or a call to the FastAPI backend) that return the same shape.

const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`
const zeroSeries = (labels, keys) => labels.map((label) => ({ label, ...Object.fromEntries(keys.map((k) => [k, 0])) }))

const HOURS = Array.from({ length: 13 }, (_, i) => hourLabel(i + 6)) // 6 AM – 6 PM
const WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH = Array.from({ length: 30 }, (_, i) => String(i + 1))

export const emptyDashboard = () => ({
  kpis: {
    generationKwh: 0,
    netProfit: 0,
    waterLitres: 0,
    carbonKg: 0,
    ecologicalRisk: null, // null = no data yet
    availability: 0,
    deltas: { generation: 0, profit: 0, water: 0, carbon: 0, availability: 0 },
  },
  metrics: { irradiance: 0, moduleTemp: 0, ambientTemp: 0, soilingLoss: 0, inverterEff: 0, alarms: 0 },
  recommendation: null, // { title, gainKwh, gainInr, waterL, impact, confidence }
  losses: [
    { name: 'Soiling', value: 0, color: '#f59e0b' },
    { name: 'Thermal', value: 0, color: '#3b82f6' },
    { name: 'Shading', value: 0, color: '#8b5cf6' },
    { name: 'Inverter', value: 0, color: '#22c55e' },
    { name: 'Other', value: 0, color: '#9ca3af' },
  ],
  power: {
    Today: zeroSeries(HOURS, ['actual', 'forecast']),
    Week: zeroSeries(WEEK, ['actual', 'forecast']),
    Month: zeroSeries(MONTH, ['actual', 'forecast']),
  },
  water: {
    Week: zeroSeries(WEEK, ['litres']),
    Month: zeroSeries(MONTH, ['litres']),
  },
  actions: [], // [{ title, when, status }]
})

export async function fetchDashboard() {
  return emptyDashboard()
}
