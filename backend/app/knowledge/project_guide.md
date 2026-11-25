# RenewX – project guide for teammates (for the assistant)

Use this to answer questions about how RenewX is built. For details beyond this guide, point to the file named
below rather than guessing.

## Tech stack (and why)
- Frontend: React 19 + Vite, React Router 7, Recharts (charts), lucide-react (icons). Plain CSS in
  `frontend/src/index.css`. Talks to Supabase directly for login and READ-ONLY data queries.
- Backend: Python FastAPI (`backend/app/`), pandas, psycopg 3 (direct Postgres connection), httpx,
  scikit-learn (forecasting + Isolation Forest), scipy (linear programming), OpenCV (panel photos), reportlab (PDF).
  Does all heavy work and all writes of computed data.
- Database/auth/storage: Supabase (Postgres with Row Level Security, Supabase Auth, Supabase Storage).
- Weather: Open-Meteo (free, no key) – geocoding, history archive and forecast.
- LLM: Google Gemini free tier (switchable to Groq) – only for this chat and recommendation wording.
- Why: free/low-cost services, Python for the ML, React for the existing UI; no extra frameworks.

## Architecture and data flow
Browser (React) → Supabase Auth login → reads tables with the user's token (RLS: only own plants).
Upload: browser → `POST /plants/{id}/uploads` (FastAPI, verifies the Supabase token and plant ownership) →
`cleaning.py` (column matching, timestamps → UTC, unit fixes, quality flags) → `plant_readings` →
`analysis.py` (daily_summaries + rule alarms in `anomalies`) → `forecast_service.py` → `anomaly_service.py` →
`soiling_service.py` → `recommendation_service.py`. Every step after the readings is wrapped so a failure never
loses the uploaded data.
Security model: the browser can only read data tables (select-only grants), except tables users manage
themselves (plants, maintenance_tasks, panel_inspections, support_reports; recommendation/anomaly status).
The backend writes through a direct DB connection that bypasses RLS, so it always checks plant ownership.
Secrets live only in `backend/.env` and `frontend/.env` (never committed).

## Database tables (SQL in `frontend/supabase/`, run in order)
schema.sql: profiles, plants. 002: data_uploads, plant_readings (PK plant_id+ts), daily_summaries, anomalies,
weather_data. 003: forecast_runs, power_forecasts. 004: anomaly details/status times. 005: maintenance_tasks.
006: cleaning costs, cleaning_analyses. 007: panel_inspections + storage bucket panel-images.
008: recommendations, battery settings. 009: support_reports.

## Modules and methods
- Forecasting (`forecasting.py`, `forecast_service.py`, `weather.py`): two forecasts. Expected generation
  (15-min, from the plant's own sunlight sensor) and day-ahead (hourly, from Open-Meteo weather, 7 days).
  Targets normalised per kWp; Physics baseline vs Random Forest vs HistGradientBoosting tested on the last ~20 %
  of days, lowest RMSE wins; likely range = 10th/90th percentile of test errors. < 5 days → physics only.
- Anomaly detection (`anomaly_detection.py`): out-of-fold expected output (each day predicted by a model that
  never saw it) + residual detector (robust z > 4) + Isolation Forest (200 trees) on actual/expected, AC/DC,
  module heat beyond sunlight, inverter share. Events ≥ 30 min, cause rules (inverter fault, overheating,
  shading, clipping, sensor mismatch, output drop). Evaluation by injecting faults into real data
  (`ML/tools/evaluate_anomalies.py`): Plant 1 100 % detected vs 17 % for the rule baseline.
- Soiling & cleaning (`soiling.py`, `cleaning_decision.py`): cleanliness index = actual ÷ expected on clear
  days; Theil–Sen slope between resets (rain ≥ 5 mm, cleaning, detected jump) = soiling rate; optimal cleaning
  interval T* = √(2·cost / (rate·energy·tariff)); cleaning score combines soiling, performance trend, anomalies,
  panel photo, rain. Cooling = gain from 8 °C cooler modules vs water cost.
- Panel photos (`panel_vision.py`, OpenCV): panel area by density of dark/blue cells, grid lines removed by
  morphology, dirt = lighter + browner than clean cells, dust film = colour shift (b*) vs a clean reference;
  same camera view aligned with SIFT + homography. Prototype of a fixed plant camera.
- AI Recommendations (`recommendations.py`, `recommendation_service.py`, `battery.py`): rule-based engine on
  top of the ML outputs; ranked by (gain − cost) × confidence; Approve creates a maintenance task. Battery
  what-if = linear programme (scipy HiGHS) on tomorrow's forecast with a time-of-day tariff.
- Environment (`environment.py`): CO₂ = 0.71 kg/kWh, trees 21 kg CO₂/year, cars 1.8 t/year, coal 0.6 kg/kWh, homes
  100 kWh/month; ecological indicator from water per MWh. Endpoint GET /plants/{id}/environment.
- Reports (`reports.py` data, `report_pdf.py` rendering with reportlab): GET /plants/{id}/reports/pdf?start&end&kind
  &ai_summary – the AI summary is rejected if it contains numbers not in the report.
- Assistant (`assistant.py`, `llm.py`, `knowledge/*.md`): this chat. Gets these guides + a snapshot of the
  selected plant; answers only from them.

## Data
Kaggle "Solar Power Generation Data" (2 plants in India, 15-min, 15 May – 17 Jun 2020), master CSVs in
`ML/data/`. Assumed locations: Plant 1 Dehradun, Plant 2 Jaipur; capacity assumed 36 MW each. Plant 1's DC
power is 10× too high in the source (auto-fixed). Recent Nov 2026 days are SYNTHETIC demo data made by
`ML/tools/make_demo_csv.py` (real weather, simulated output, optional dust).

## Running it
Backend: `cd backend`, `python -m venv .venv`, `.venv\Scripts\pip install -r requirements.txt`, copy
`.env.example` to `.env` and fill it, `.venv\Scripts\uvicorn app.main:app --reload` (API docs at /docs).
Tests: `.venv\Scripts\python -m pytest -q`. Frontend: `cd frontend`, `npm install`, `npm run dev`.

## Known limitations (be honest in the viva)
Prototype with manual CSV uploads; assumed plant locations and capacities; only 34 days of real data;
anomaly detection is plant-level (per-inverter is a planned extra); no real fault labels (injected faults);
sample panel photos are few and some are illustrative; battery is simulated; the LLM only explains.
