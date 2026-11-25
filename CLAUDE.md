# RenewX

Final-year B.Tech project: solar plant monitoring, analysis and optimization (Predict → Diagnose → Optimize).
Data is entered manually as CSV (no live plant connection). Dataset: Kaggle "Solar Power Generation Data"
(2 plants, 15-min readings, 15 May – 17 Jun 2020); master CSVs live in `ML/data/`.

## Structure
- `frontend/` – React 19 + Vite + React Router + Recharts + lucide-react. Supabase auth + reads (RLS).
  - `supabase/schema.sql` (profiles, plants), `002_data_pipeline.sql` (data tables), `003_forecasting.sql`
    (forecast_runs, power_forecasts) – run in the SQL editor (all three have been run).
  - `src/lib/api.js` – backend calls with the Supabase token. `src/lib/*Data.js` – page queries (read-only).
  - Pages with real data: Dashboard, Plant Overview, Forecasting. Others are placeholders.
- `backend/` – FastAPI + pandas + psycopg. See `backend/README.md`. Run: `.venv\Scripts\uvicorn app.main:app --reload`.
- `ML/` – datasets. Forecasting ML lives in `backend/app/forecasting.py` (trained per plant on upload).

## Data flow
Upload dialog → `POST /plants/{id}/uploads` (Supabase token) → backend checks ownership → `cleaning.py` →
`plant_readings` (PK plant_id+ts: daily files append, overlaps skipped or replaced) → `analysis.py` recalculates
every local day the file touches from all stored readings → `daily_summaries` + rule alarms in `anomalies` →
report in `data_uploads` → forecast refresh (below). Pages read these tables directly from Supabase.

## Forecasting (`forecasting.py`, `forecast_service.py`, `weather.py`)
Two forecasts, refreshed after every upload, when location/capacity changes, or via `POST /plants/{id}/forecast/refresh`:
- **Expected** (15-min, plant's own irradiation/temperature sensor) → `power_forecasts kind='expected'` and
  `daily_summaries.expected_energy_kwh`. Expected − actual = hidden loss. Shown as the dashboard's "Expected" line.
- **Day-ahead** (hourly, Open-Meteo weather) for the next 7 days → `kind='day_ahead'`. Needs latitude/longitude.
- Method: target normalised per kWp; physics baseline vs RandomForest vs HistGradientBoosting tested on the last
  ~20 % of days; lowest RMSE wins and is refitted on all data; band = 10th/90th percentile of test errors.
  < 5 days of data → physics only; no data → physics with PR 0.8.
- Mode `live` if data is ≤ 3 days old (uses forecast weather), else `simulated` (forecasts the 7 days after the
  data using archive weather — the case for the 2020 Kaggle data). Past day-ahead values are never overwritten,
  so accuracy can be measured as new days arrive.
- Plant location: place search in the plant form (Open-Meteo geocoding, browser-side) fills lat/lon/timezone.
  Demo plants use assumed locations: Plant 1 = Dehradun (30.3165, 78.0322), Plant 2 = Jaipur (26.9124, 75.7873).
  Because the locations are assumed, day-ahead accuracy is modest (R² ≈ 0.5–0.8) — state this in the report.
- A refresh takes ~25–45 s (weather download + training).
- Live demo data: `ML/tools/make_demo_csv.py` writes SYNTHETIC recent-day CSVs to `ML/data/recent/`
  (real Open-Meteo weather at the assumed locations × each plant's 2020 output-per-sunlight). Label as synthetic.

## Decisions
- Browser only READS data tables (RLS, select-only grants); the backend WRITES via a direct DB connection.
  Always check plant ownership in the backend, because it bypasses RLS.
- Every backend DB session sets `lock_timeout = 30s` and `idle_in_transaction_session_timeout = 2min`;
  forecast writes take a per-plant advisory lock. (A stuck refresh once blocked uploads for 20+ min.)
- Timestamps stored in UTC; naive CSV times are in the plant's `timezone` (default Asia/Kolkata).
- Energy = Σ AC power × interval (yield columns are unreliable in the Kaggle data, especially Plant 2).
- Plant 1's DC power is 10× too high in the source data; `cleaning.py` detects (AC/DC ≈ 0.1) and fixes it.
- Plant capacities are not published; both Kaggle plants use an estimated 36 MW (gives PR ≈ 0.81 for Plant 1).
- Dashboard "Today" = latest day with data. "CO₂ Avoided" uses ≈0.71 kg/kWh (Indian grid, approx.).
- Weather: Open-Meteo (free, no key) into `weather_data` (`source` = 'open-meteo' recorded, 'open-meteo-forecast').
- Anomaly ML not started: alarms are rule-based (underperformance vs the plant's median output per unit sunlight,
  data gaps, inverter dropout, sensor faults). ML anomalies will share the `anomalies` table (`source = 'ml'`).

## Working agreement
Understand → plan → discuss → implement → verify → document. No new dependencies without discussing.
Don't rebuild working components. Never commit `.env` files.
