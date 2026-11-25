# RenewX backend (FastAPI)

Receives plant CSV uploads, cleans them, stores readings in Supabase and calculates daily statistics and rule-based alarms.

## Setup (once)
```bash
cd backend
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
copy .env.example .env        # then fill in DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY
```
The database tables come from `frontend/supabase/schema.sql`, `002_data_pipeline.sql` and `003_forecasting.sql`.

## Run
```bash
.venv\Scripts\uvicorn app.main:app --reload      # http://localhost:8000  (API docs: /docs)
.venv\Scripts\python -m pytest -q                # tests (no database needed)
```

## Upload flow — `POST /plants/{plant_id}/uploads`
Form fields: `file` (.csv), `kind` (`historical` | `daily`), `mode` (`skip` | `replace` existing timestamps).
Header: `Authorization: Bearer <Supabase access token>`.

1. Verify the login token and that the plant belongs to the user.
2. `cleaning.py` – match columns, parse timestamps (plant timezone → UTC), combine per-inverter rows,
   fix units (W/m² irradiance, 10× DC), remove impossible values, flag data-quality issues.
3. `store.py` – insert into `plant_readings` (one row per plant + timestamp, so daily uploads append safely).
4. `analysis.py` – recalculate every local day touched by the file from *all* stored readings:
   `daily_summaries` (energy, PR, availability, losses, revenue, CO₂) and rule alarms in `anomalies`
   (underperformance, data gaps, inverter dropout, sensor faults).
5. The result and a report (fixes, warnings) are saved in `data_uploads` and returned.
6. The forecast is refreshed (see below). If that fails, the data stays saved and a warning is returned.

Steps 3–4 run in one transaction: a failed upload stores nothing.

## Forecast — `POST /plants/{plant_id}/forecast/refresh`
`forecast_service.refresh` (also run after each upload):
1. **Expected generation** – model on the plant's own sunlight/temperature readings (15-min).
2. **Day-ahead** – needs latitude/longitude. Fetches Open-Meteo weather (`weather.py`, archive + forecast API),
   trains on past weather vs actual output, predicts the next 7 days (live, or simulated for old data).
3. `forecasting.py` compares Physics baseline / Random Forest / Gradient Boosting on held-out recent days and
   keeps the best. Results: `forecast_runs` (models, scores, notes) and `power_forecasts`.
Weather API failure → HTTP 502 with a readable message.
