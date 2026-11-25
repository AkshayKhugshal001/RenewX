---
title: RenewX API
emoji: ☀️
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
short_description: Backend API of RenewX (solar plant monitoring & optimisation)
---

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

## Panel photo check — `POST /plants/{plant_id}/panel-photos/analyse`
Multipart `image` (+ optional `reference`, a clean photo of the same panels). OpenCV (`panel_vision.py`) returns
soiled area %, dust film %, severity, a rough power-loss estimate and an overlay (base64 JPEG). Nothing is stored
by the backend – the browser saves photos in Supabase Storage (`007_panel_photos.sql`).

## AI assistant — `/assistant/*`
Optional. Put `GEMINI_API_KEY` (free, Google AI Studio) in `.env` (see `.env.example`). `GET /assistant/status`,
`POST /assistant/chat` {plant_id, messages}, `POST /assistant/issue-draft`. The assistant's knowledge is in
`app/knowledge/app_guide.md` and `project_guide.md` – update them when features change.

## Environment and reports
`GET /plants/{plant_id}/environment` – CO₂ avoided, equivalents, water, ecological indicator, daily conditions.
`GET /plants/{plant_id}/reports/pdf?start=YYYY-MM-DD&end=YYYY-MM-DD&kind=performance|maintenance&ai_summary=true`
– A4 PDF (reportlab), max one year.

## Deploying on Hugging Face Spaces (free)
The block at the top of this README configures the Space (Docker, port 7860). `Dockerfile` builds the image.
Push only this folder to the Space (from the repository root):
`git push hf $(git subtree split --prefix backend main):main --force`
Set the secrets in the Space settings: DATABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, GEMINI_API_KEY and
FRONTEND_ORIGINS (the Vercel address, e.g. https://your-app.vercel.app). Health check: `<space-url>/health`.
