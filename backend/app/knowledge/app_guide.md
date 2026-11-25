# RenewX – user guide (for the assistant)

RenewX is a solar plant monitoring, analysis and optimisation web app built as a final-year B.Tech (CSE, AI & DS)
project at Graphic Era Hill University (team CSE27-413). Framework: Predict → Diagnose → Optimize.
It is a prototype: plant data is uploaded as CSV files (there is no live connection to a plant).

## Getting started
- Sign up / sign in. Add a plant (top bar → plant menu → "Add plant"): name, location (type a town and pick it –
  latitude, longitude and timezone fill in automatically), capacity in MW, tariff (₹/kWh), cleaning cost/water per MW,
  battery what-if size. Capacity and tariff are needed for performance ratio and money values.
- Upload data: Dashboard → "Upload data" (or when adding a plant). CSV with 15-minute (or other interval) readings:
  timestamp, AC power, DC power, irradiation, module and ambient temperature, optional yields and active inverters.
  Column names are matched automatically (e.g. DATE_TIME, AC_POWER, IRRADIATION). Choose "Daily / recent data"
  for new days; tick "Replace readings" only to overwrite times already stored. Max 50 MB.
- After an upload RenewX automatically: cleans the data, calculates daily statistics and rule alarms, refreshes the
  forecast, runs ML anomaly detection, the cleaning & cooling analysis and rebuilds the AI recommendations
  (takes up to about a minute).

## Pages
- Dashboard – latest day with data: generation, revenue, CO₂ avoided, availability, power curve (actual vs
  expected), key metrics, loss analysis, water used for cleaning, top AI recommendation, upcoming tasks.
- Plant Overview – plant profile, lifetime totals, daily energy and performance ratio (PR), best/worst days,
  losses, alarms by type, upload history.
- Forecasting – 7-day day-ahead forecast (energy per day with a likely range, hourly curve, cloud and rain),
  recent days actual vs expected vs forecast, model comparison. "Live" when the data is recent, "Simulated" when
  the data is old (then the 7 days after the data are forecast with the weather recorded then).
- Maintenance → Anomalies tab – rule alarms and ML anomalies (cause, severity, energy and ₹ lost, explanation,
  day chart). Acknowledge / resolve, "Create task".
- Maintenance → Maintenance tasks tab – plan work (category, priority, due date, repeat, cost), Start / Done,
  plant health score (0–100), standard preventive schedule, before/after effect of finished work.
- Cleaning & Cooling – cleaning recommendation with a cleaning score and the evidence behind it, soiling loss and
  rate, cost of dirt per day, cleanliness chart, 7-day projection with rain, panel camera (photos), cooling verdict.
- AI Recommendations – ranked actions with gain, cost, water, CO₂, confidence; Approve (creates or moves a
  maintenance task) or Dismiss; history with predicted vs measured result; battery what-if chart.
- Environment – CO₂ avoided with equivalents (trees / cars for a year, homes powered, coal not burned), water used
  for cleaning and per MWh, water saved by waiting for rain, ecological indicator (Low/Medium/High from water per MWh:
  < 50 low, ≥ 150 high, raised by > 4 cleanings a month), daily sunlight, rain and temperatures.
- Reports – choose Performance or Maintenance report, a month or custom dates, optional AI executive summary, then
  "Download PDF" (A4 PDF with KPIs, daily energy chart, losses, forecast accuracy, anomalies, maintenance, cleaning,
  recommendations, environmental impact).
- Settings – three sections: Plants (add/edit/upload/delete), Appearance (Light / Dark / System theme, saved per
  device), Account (display name, change password, sign out).
- Every morning (≈ 06:00 IST) forecasts, cleaning analyses and recommendations refresh automatically for all plants
  with a location, using the new weather forecast (no upload needed).

## Key terms
- Performance ratio (PR): actual energy ÷ energy the installed capacity would give with the measured sunlight.
  ~0.75–0.85 is good.
- Expected output: what the plant should produce for the measured sunlight and temperature (ML model trained on
  the plant's own healthy data). Actual below expected = loss (dust, faults, outages).
- Day-ahead forecast: predicted output for the next days from a weather forecast (Open-Meteo).
- Anomaly severity: high / medium / low by the energy lost relative to a normal day.
- Soiling rate: % of output lost to dust per day; reset by rain ≥ 5 mm or a cleaning.
- Cleaning score (0–100): ≥ 70 clean now, 40–69 plan a cleaning, < 40 not needed; rain in the next 3 days →
  wait for rain. Signals: soiling estimate, performance trend, anomalies, panel photo (left out if missing).
- Plant health score (0–100): output vs expected 40 + availability 30 + open anomalies 20 + overdue tasks 10.
- Confidence of a recommendation: how sure the model is (0–100 %). Gains are for the next 30 days.

## Common problems
- "Could not reach the RenewX backend": the FastAPI backend is not running (start it with uvicorn) or
  VITE_API_URL is wrong.
- Upload rejected: check that the file is a CSV with a timestamp column and AC power; dates must be readable.
- No performance ratio / money values: set plant capacity and tariff in "Edit plant".
- No day-ahead forecast: set the plant location (latitude/longitude) in "Edit plant", then "Refresh forecast".
- Forecast says "Simulated": the uploaded data is older than 3 days – upload recent data for a live forecast.
- Panel photos fail to save: the 007 SQL (storage bucket) must be run; photos max 6 MB, JPG/PNG/WebP.
- Something else broken: use "Report an issue" in this chat – the team will see it.
