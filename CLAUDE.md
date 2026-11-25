# RenewX

Final-year B.Tech project: solar plant monitoring, analysis and optimization (Predict → Diagnose → Optimize).
Data is entered manually as CSV (no live plant connection). Dataset: Kaggle "Solar Power Generation Data"
(2 plants, 15-min readings, 15 May – 17 Jun 2020); master CSVs live in `ML/data/`.

## Structure
- `frontend/` – React 19 + Vite + React Router + Recharts + lucide-react. Supabase auth + reads (RLS).
  - `supabase/schema.sql` (profiles, plants), `002_data_pipeline.sql` (data tables), `003_forecasting.sql`
    (forecast_runs, power_forecasts), `004_anomalies.sql` (anomaly details + status timestamps), `005_maintenance.sql` (maintenance_tasks), `006_cleaning.sql` (cleaning costs, cleaning_analyses), `007_panel_photos.sql` (storage bucket panel-images +
    panel_inspections), `008_recommendations.sql` (recommendations, battery settings), `009_support_reports.sql` – run in the SQL editor.
  - `src/lib/api.js` – backend calls with the Supabase token. `src/lib/*Data.js` – page queries (read-only).
  - Pages with real data: Dashboard, Plant Overview, Forecasting, Maintenance (tabs "Anomalies" and "Maintenance tasks"), Cleaning & Cooling, AI Recommendations, Environment, Reports.
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

## Anomaly detection (`anomaly_detection.py`, `anomaly_service.py`) – plant-level
Runs after each upload (after the forecast) and via `POST /plants/{id}/anomalies/detect`; stored in `anomalies`
with `source='ml'` next to the rule alarms (kept as the baseline). Re-runs replace only OPEN ML anomalies.
- Expected output is predicted OUT-OF-FOLD (5 folds grouped by day, light HistGradientBoosting) – an in-sample
  model would learn and hide faults. Daylight readings (≥ 0.1 kW/m²) only; rule-explained periods are skipped.
- Detectors: residual (robust z > 4 and output < 90 % or > 120 % of expected) + Isolation Forest (200 trees) on
  actual/expected, AC/DC, module heat beyond sunlight, inverter share; threshold = 99.5th pct of normal readings.
- Events ≥ 30 min; cause rules: sensor_mismatch, inverter_fault, clipping, overheating, shading (same time on
  ≥ 3 days), else output_drop (dropped if small). ML type names differ from rule ones (unique plant+type+ts_start).
- Evaluation: `ML/tools/evaluate_anomalies.py` injects 6 fault types into real data (3 days/fault, 18 trials):
  Plant 1 combined 100 % detected / 83 % right cause / 0.22 new false alarms per trial (rule-based 17 %);
  Plant 2 (noisier, real faults) combined 67 % / 83 % / 1.44 (rule 33 %) – sensor faults missed (0/3). Browser may update only `status`; a trigger sets the times.

## Maintenance tasks (`005_maintenance.sql`, `src/lib/maintenanceData.js`, `pages/MaintenanceTasks.jsx`)
- First table the BROWSER writes (RLS: own plants, all operations). No backend involved.
- `source` = manual | anomaly | schedule | recommendation (AI Recommendations "Approve" will insert tasks with
  `source='recommendation'` + `recommendation_id`). Triggers: creating a task acknowledges its anomaly (so
  re-detection keeps it), marking done sets completed_at, resolves the anomaly and plans the next repeat.
- Before/after: actual ÷ expected energy for ≤ 7 days before vs after completion (≥ 3 days each side).
- Health score 0–100 = output vs expected 40 + availability 30 + open anomalies 20 + overdue tasks 10.

## Cleaning & Cooling (`soiling.py`, `soiling_service.py`, `pages/CleaningCooling.jsx`)
Runs after each upload (after anomalies) and via `POST /plants/{id}/cleaning/analyse`; also re-run when a cleaning
task is marked done or the plant's costs change. Latest result in `cleaning_analyses`; per-day
`daily_summaries.cleanliness_index` / `soiling_loss_pct` (dashboard Soiling Loss + loss pie; water from cleaning tasks).
- Cleanliness index = actual ÷ expected energy on clear days (insolation ≥ 60 % of the 90th pct of ±15 days,
  availability ≥ 95 %). Resets: rain ≥ 5 mm/day, a done cleaning task, or a data gap > 14 days.
- Rate = Theil–Sen slope between resets (prefer stretches from the last 60 days); < 8 clear days → assumed
  0.3 %/day. Confidence "high" if the index jumps back after resets by ≥ half the expected loss.
- Economics: T* = √(2C/(r·E·p)) = interval at which cleaning pays off.
- DECISION (`cleaning_decision.py`) combines all signals into a score 0–100: soiling estimate 40 (× confidence),
  performance trend 20 (sudden step = half), anomalies −15…+10 (gradual output drops support; inverter/shading/
  clipping/sensor faults count against – "cleaning won't fix it"; sensor_mismatch → side action "clean the sensor"),
  panel photo 30 (camera/inspection, ≤ 14 days old). Missing signals are left out and the score rescaled, so it
  works without photos. ≥ 70 clean now, 40–69 plan (date from T*), < 40 not needed; rain ≤ 3 days → wait.
- Unrecorded cleanings are detected as jumps (index +3 points, rising that day, staying up 3 clear days).
- Real/demo result: Plant 1 found the unrecorded 12 Nov cleaning (0.33 %/day), Plant 2 0.48 %/day (true 0.5).
- Prototype camera: a real plant would have a fixed camera comparing daily photos with a clean reference; here
  uploading a dated photo simulates a capture (hook `_camera()` in soiling_service reads the latest inspection).

## Panel photos (`panel_vision.py`, `components/PanelCamera.jsx`, `lib/panelPhotos.js`) – OpenCV
- `POST /plants/{id}/panel-photos/analyse` (image + optional reference) is stateless; the BROWSER stores the photo
  and the analysed overlay in Storage (`panel-images/<plant_id>/…`, private, RLS by folder) and the result in
  `panel_inspections` (kind reference | inspection). Saving/deleting re-runs the cleaning analysis.
- Method: panel = areas where ≥ 50 % of nearby pixels are dark/blue cells (sand, sky, frames excluded); grid lines
  removed (morphological top-hat); dirt spots = ≥ 14 L* lighter and ≥ 4 b* yellower than the darkest quarter of
  the panel, or very bright/low-saturation (droppings); dust film = b* shift vs the reference × 1.5 (vs b* 112
  without reference). soiled % = max(spots, film); severity < 6 clean, < 12 light, < 25 moderate; power loss ≈ 0.6 ×.
  Same camera view (SIFT + homography, ≥ 40 inliers) → only NEW dirt is counted.
- Samples: `frontend/public/samples/panels/pair_{a..e}_{clean,dirty}.jpg` ("Import sample photos"). Pairs c and e
  look AI-generated → label as illustrative, not evidence. Clean 3–10 % vs dirty-vs-reference 24–35 % on all 5.
  The sample pairs are NOT from a fixed camera, so they use the statistical comparison (not aligned).
- Cooling: gain = output × 0.4 %/°C × 8 °C when modules > 45 °C vs water (1500 L/MW/h at ₹50/kL) – assumptions.
  Shown for the recent 14 days and the hottest 14 days in the data.
- Real data: Plant 1 no measurable soiling; Plant 2 ≈ 0.8 %/day (high confidence: +11 % after rain in 2020).
  Summer cooling: not worth it (gain ₹11.7k/day vs water ₹15.9k/day for Plant 1).
- Demo: `make_demo_csv.py --soiling 0.5 --clean-on DATE` (synthetic dust on real weather).
- Forecast weather is fetched only for stretches of days with readings (an earlier version fetched 2020→2026).

## AI Recommendations (`recommendations.py`, `recommendation_service.py`, `battery.py`, `pages/Recommendations.jsx`)
Runs last after each upload, after a cleaning analysis and via `POST /plants/{id}/recommendations/refresh`.
- Rule-based decision engine ON TOP of the ML outputs (explainable). Sources: cleaning decision, open anomalies
  without a task (grouped by cause, last 30 days of data), sensor mismatch, overdue tasks, best forecast day for
  planned downtime work, cooling (if recommended), battery what-if. Gains are over the next 30 days.
- Rank: priority, then value = (gain ₹ − cost ₹) × confidence. Open ones are replaced each run; approved (task
  open) / dismissed (7 d) / done (7 d) keys are not suggested again.
- Approve (browser): create_task (task source='recommendation', recommendation_id, linked both ways) |
  reschedule | open_task | none (accept). Task done → recommendation done (trigger); history shows predicted vs
  measured gain (before/after check). Browser may update only status / task_id / dismiss_reason.
- Battery what-if: LP (scipy linprog/HiGHS) on tomorrow's hourly forecast; 10 MWh / 5 MW default (plants
  columns), 90 % round trip, ToD tariff (09–17 × 0.8, 18–22 × 1.2), charges from PV only, curtails above the grid limit.
- Dashboard "AI Recommendation" card = top open recommendation (Approve / View Details).

## LLM assistant (`llm.py`, `assistant.py`, `knowledge/*.md`, `components/AssistantChat.jsx`)
- Provider layer over plain HTTPS (no SDK): Gemini free tier (`GEMINI_MODEL=gemini-flash-latest`, falls back to
  `GEMINI_FALLBACK_MODEL=gemini-flash-lite-latest` on 429/5xx/404); `LLM_PROVIDER=groq` switches to Groq.
  Key only in backend/.env. gemini-2.5-flash is not available to new users (checked 2026-11-26). Default/fallback
  order was swapped to Flash-Lite first (see Environment & Reports section).
- The LLM EXPLAINS ONLY: (1) `ai_summary` of open recommendations after each rebuild – rejected if it contains any
  number not in the source data (`assistant.grounded`); (2) "Ask RenewX" floating chat on every page:
  `POST /assistant/chat` with app guide + project guide (knowledge/*.md, keep them updated when features change!)
  + `plant_snapshot()` of the selected plant; off-topic declined; (3) `POST /assistant/issue-draft` → user edits →
  browser inserts into `support_reports` (team reads them in the Supabase Table Editor).
- No user names/e-mails are sent to the LLM. Rate limit per user: 8/min, 80/day (in memory). Replies ≈ 10–15 s.


## Environment & Reports (`environment.py`, `reports.py`, `report_pdf.py`, `pages/Environment.jsx`, `pages/Reports.jsx`)
- Computed on the backend so the page, dashboard "Ecological Risk" card and PDFs share the numbers:
  GET /plants/{id}/environment, GET /plants/{id}/reports/pdf?start&end&kind=performance|maintenance&ai_summary.
- Equivalents are annual (trees absorbing / cars emitting for one year); factors listed in environment.py.
  Ecological indicator: water L/MWh over the last 90 days of data (< 50 low, ≥ 150 high, > 4 cleanings/month +1).
- PDF: reportlab platypus + built-in bar chart; standard fonts → ₹→"Rs", CO₂→"CO2", dashes → "-".
  AI executive summary optional, number-guarded; ≈ 4 s without AI, ≈ 7 s with.
- Gemini default is now `gemini-flash-lite-latest` (2–6 s, no "thinking"); `gemini-flash-latest` was often 503 or
  > 60 s on the free tier (it thinks even with thinkingBudget 0) → only the fallback.

## Deployment
- Frontend: Vercel (auto-deploys from GitHub; set `VITE_API_URL` to the backend URL in Vercel env vars).
- Backend: Render free web service via Blueprint `render.yaml` (repo root; native Python 3.11, rootDir backend,
  uvicorn on $PORT, health /health, secrets `sync: false`). 512 MB RAM is enough (measured ~195 MB idle, ~320 MB
  peak); sleeps after 15 min idle (~30–60 s cold start). Hugging Face Docker/Gradio Spaces now require PRO (only
  Static is free) – not used. Vercel ruled out (libraries ≈ 534 MB, ~1 min uploads). `backend/Dockerfile` kept for
  any Docker host (listens on $PORT, default 7860).

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
