"""Forecast refresh for one plant: weather → train models → store predictions.

Runs automatically after every upload and when the user presses "Refresh forecast".
  * expected generation for every past reading (needs the plant's sunlight sensor)
  * day-ahead forecast for the next DAYS_AHEAD days (needs latitude/longitude)
      live      – the plant's data is recent: uses Open-Meteo's weather forecast
      simulated – the data is old (e.g. 2020): forecasts the days after it using the weather recorded then
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

from . import analysis, forecasting as fc, store, weather

DAYS_AHEAD = 7
LIVE_WINDOW_DAYS = 3   # data newer than this -> live forecast
EMPTY = pd.DataFrame(columns=["ts", "predicted_kw", "lower_kw", "upper_kw"])


def _bounds(first: date, last: date, tz: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    """UTC instants of local midnight at the start of `first` and the end of `last`."""
    start = pd.Timestamp(first).tz_localize(tz).tz_convert("UTC")
    end = (pd.Timestamp(last) + pd.Timedelta(days=1)).tz_localize(tz).tz_convert("UTC")
    return start, end


def _day_runs(days: list[date], max_gap: int = 3) -> list[tuple[date, date]]:
    """Group sorted days into stretches; a gap of more than `max_gap` days starts a new stretch."""
    runs: list[tuple[date, date]] = []
    for d in days:
        if runs and (d - runs[-1][1]).days <= max_gap:
            runs[-1] = (runs[-1][0], d)
        else:
            runs.append((d, d))
    return runs


def _summary(fitted: fc.Fitted | None) -> dict | None:
    if fitted is None:
        return None
    return {"chosen": fitted.name, "train_days": fitted.train_days, "performance_ratio": round(fitted.pr, 3),
            "candidates": fitted.scores}


def _daily(df: pd.DataFrame, tz: str) -> list[dict]:
    """Hourly forecast -> energy per local day (kWh)."""
    if df.empty:
        return []
    day = (pd.to_datetime(df["ts"], utc=True) - pd.Timedelta(minutes=30)).dt.tz_convert(tz).dt.date
    g = df.assign(day=day).groupby("day")[["predicted_kw", "lower_kw", "upper_kw"]].sum()
    return [{"day": d.isoformat(), "energy_kwh": round(r.predicted_kw, 1), "lower_kwh": round(r.lower_kw, 1),
             "upper_kwh": round(r.upper_kw, 1)} for d, r in g.iterrows()]


def refresh(conn, plant: dict) -> dict:
    pid, tz = plant["id"], plant["timezone"]
    capacity_kwp = plant["capacity_mw"] * 1000
    notes: list[str] = []

    readings = store.fetch_all_readings(conn, pid)
    has_data = not readings.empty
    scale = capacity_kwp if capacity_kwp > 0 else (float(readings["ac_power_kw"].max()) if has_data else 0.0)
    if capacity_kwp <= 0:
        notes.append("Plant capacity is not set; forecasts are scaled to the highest output in the data. "
                     "Set the capacity in Settings for accurate results.")
    if scale <= 0:
        notes.append("Set the plant capacity or upload data to get a forecast.")
        run = {"mode": "none", "notes": notes}
        return {"run_id": store.create_forecast_run(conn, pid, run), **run, "days": []}

    now_utc = pd.Timestamp.now(tz="UTC")
    today = now_utc.tz_convert(tz).date()
    interval_min = analysis.interval_hours(readings["ts"]) * 60 if has_data else 15.0

    # ── 1. expected generation (plant sensor) ───────────────
    expected_fit, expected_rows, usable = None, EMPTY, None
    if has_data:
        usable = fc.usable_rows(readings, store.outage_periods(conn, pid))
        if readings["irradiation_kw_m2"].notna().any():
            expected_fit, expected_rows = fc.fit_expected(readings, fc.healthy_rows(readings, usable), scale, tz)
        else:
            notes.append("The data has no sunlight (irradiation) readings, so expected generation can't be calculated.")

    # ── 2. day-ahead forecast (weather) ─────────────────────
    mode, da_fit, backtest, future = "none", None, EMPTY, EMPTY
    f_start = f_end = None
    lat, lon = plant.get("latitude"), plant.get("longitude")
    if lat is None or lon is None:
        notes.append("Add the plant's latitude and longitude to get day-ahead forecasts.")
    else:
        if has_data:
            local = readings["ts"].dt.tz_convert(tz)
            first_day, last_day = local.min().date(), local.max().date()
            h_start, h_end = _bounds(first_day, last_day, tz)
            # only the stretches of days that have readings (not the gaps between them, e.g. 2020 → 2026)
            for run_start, run_end in _day_runs(sorted(local.dt.date.unique())):
                r_start, r_end = _bounds(run_start, run_end, tz)
                needed = (r_end - r_start) / pd.Timedelta(hours=1)
                if store.weather_hours(conn, pid, r_start.to_pydatetime(), r_end.to_pydatetime()) < 0.95 * needed:
                    w = weather.fetch_hourly(lat, lon, run_start - timedelta(days=1), run_end + timedelta(days=1), today)
                    store.upsert_weather(conn, pid, w[w["ts"] <= now_utc], "open-meteo")
            history = store.fetch_weather(conn, pid, h_start.to_pydatetime(), (h_end + pd.Timedelta(hours=1)).to_pydatetime())
            actuals = fc.hourly_actuals(readings, usable, interval_min)
            da_fit, backtest = fc.fit_day_ahead(actuals, history, scale, tz)
            live = last_day >= today - timedelta(days=LIVE_WINDOW_DAYS)
            start_day = max(last_day + timedelta(days=1), today) if live else last_day + timedelta(days=1)
            if not live:
                notes.append(f"The latest data is from {last_day:%d %b %Y}, so a live forecast isn't possible. "
                             f"The next {DAYS_AHEAD} days are forecast using the weather recorded then (simulated forecast).")
        else:
            da_fit = fc.Fitted(fc.PHYSICS, None, fc.DEFAULT_PR, band=(-0.05, 0.05))
            live, start_day = True, today
            notes.append("No data uploaded yet: the forecast uses a standard physics formula "
                         "(typical performance ratio 0.8). It becomes plant-specific after the first upload.")
        if da_fit.name == fc.PHYSICS and has_data and da_fit.test_mask is None:
            notes.append(f"Less than {fc.MIN_TRAIN_DAYS} days of data: day-ahead forecast uses the physics formula for now.")

        mode = "live" if live else "simulated"
        end_day = start_day + timedelta(days=DAYS_AHEAD - 1)
        f_start, f_end = _bounds(start_day, end_day, tz)
        fw = weather.fetch_hourly(lat, lon, start_day - timedelta(days=1), end_day + timedelta(days=1), today)
        fw = fw[(fw["ts"] > f_start) & (fw["ts"] <= f_end)].reset_index(drop=True)
        store.upsert_weather(conn, pid, fw[fw["ts"] <= now_utc], "open-meteo")
        store.upsert_weather(conn, pid, fw[fw["ts"] > now_utc], "open-meteo-forecast")
        future = fc.predict_day_ahead(da_fit, fw, scale, tz)

    # ── 3. store everything at once ──────────────────────────
    metrics = {k: v for k, v in {"expected": _summary(expected_fit), "day_ahead": _summary(da_fit)}.items() if v}
    run = {
        "mode": mode,
        "expected_model": expected_fit.name if expected_fit else None,
        "day_ahead_model": da_fit.name if da_fit else None,
        "metrics": metrics,
        "train_days": max([f.train_days for f in (expected_fit, da_fit) if f] or [0]),
        "forecast_from": f_start.to_pydatetime() if f_start is not None else None,
        "forecast_to": f_end.to_pydatetime() if f_end is not None else None,
        "notes": notes,
    }
    with conn.transaction():
        # One refresh per plant at a time: a second one waits here (max lock_timeout) instead of
        # interleaving its deletes/inserts with the first.
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (str(pid),))
        run_id = store.create_forecast_run(conn, pid, run)
        store.write_forecasts(conn, pid, run_id, "expected", expected_rows, overwrite=True)
        if da_fit is not None:
            cutoff = readings["ts"].max() if has_data else f_start
            store.delete_future_forecasts(conn, pid, cutoff.to_pydatetime())
            store.write_forecasts(conn, pid, run_id, "day_ahead", backtest, overwrite=False)  # never rewrite the past
            store.write_forecasts(conn, pid, run_id, "day_ahead", future, overwrite=True)
        if not expected_rows.empty:
            store.update_expected_energy(conn, pid, tz, interval_min / 60)

    return {
        "run_id": run_id, **{k: v for k, v in run.items() if k not in ("forecast_from", "forecast_to")},
        "forecast_from": f_start.isoformat() if f_start is not None else None,
        "forecast_to": f_end.isoformat() if f_end is not None else None,
        "days": _daily(future, tz),
    }
