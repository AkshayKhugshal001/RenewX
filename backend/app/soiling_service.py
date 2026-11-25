"""Cleaning & cooling analysis for one plant: load daily data, rain, cleanings, forecast → analyse → store.

Runs after every upload (after the forecast) and from POST /plants/{id}/cleaning/analyse.
"""
from __future__ import annotations

from datetime import timedelta

import pandas as pd
from psycopg.types.json import Jsonb

from . import analysis, cleaning_decision, soiling, store

COOLING_DAYS = 14   # cooling is judged on the most recent two weeks of readings


def _plant_costs(conn, plant_id: str) -> tuple[float, float]:
    """Cleaning cost/water per MW (columns from 006_cleaning.sql; defaults if not there yet)."""
    row = conn.execute("select to_jsonb(p) from public.plants p where id = %s", (plant_id,)).fetchone()[0]
    return float(row.get("cleaning_cost_inr_per_mw") or 6000), float(row.get("cleaning_water_l_per_mw") or 4000)


def _daily(conn, plant_id: str) -> pd.DataFrame:
    cur = conn.execute(
        "select day, energy_kwh, expected_energy_kwh, insolation_kwh_m2, availability_pct "
        "from public.daily_summaries where plant_id = %s order by day", (plant_id,))
    df = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
    for c in df.columns[1:]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def _rain_by_day(conn, plant_id: str, tz: str, sources: tuple[str, ...], start=None, end=None) -> dict:
    """Rain per local day (hourly values are labelled by the END of the hour)."""
    sql = ("select ((ts - interval '30 minutes') at time zone %s)::date, sum(precipitation_mm) "
           "from public.weather_data where plant_id = %s and source = any(%s)")
    args: list = [tz, plant_id, list(sources)]
    if start is not None:
        sql += " and ts > %s and ts <= %s"
        args += [start, end]
    rows = conn.execute(sql + " group by 1", args).fetchall()
    return {d: float(mm or 0) for d, mm in rows}


def _cleanings(conn, plant_id: str, tz: str) -> list:
    if not conn.execute("select to_regclass('public.maintenance_tasks') is not null").fetchone()[0]:
        return []
    rows = conn.execute(
        "select distinct (completed_at at time zone %s)::date from public.maintenance_tasks "
        "where plant_id = %s and status = 'done' and category = 'cleaning' and completed_at is not null",
        (tz, plant_id)).fetchall()
    return [r[0] for r in rows]


def _forecast(conn, plant_id: str, tz: str) -> list[dict]:
    """Day-ahead energy + rain per day of the latest forecast window."""
    run = conn.execute("select forecast_from, forecast_to from public.forecast_runs where plant_id = %s "
                       "order by created_at desc limit 1", (plant_id,)).fetchone()
    if not run or run[0] is None:
        return []
    energy = dict(conn.execute(
        "select ((ts - interval '30 minutes') at time zone %s)::date, sum(predicted_kw) from public.power_forecasts "
        "where plant_id = %s and kind = 'day_ahead' and ts > %s and ts <= %s group by 1",
        (tz, plant_id, run[0], run[1])).fetchall())
    rain = _rain_by_day(conn, plant_id, tz, ("open-meteo", "open-meteo-forecast"), run[0], run[1])
    return [{"day": d, "energy_kwh": float(energy[d] or 0), "rain_mm": rain.get(d, 0.0)} for d in sorted(energy)]


def _anomalies(conn, plant_id: str, tz: str, since) -> list[dict]:
    """Unresolved anomalies starting on/after `since` (local day)."""
    rows = conn.execute(
        "select type, energy_lost_kwh, (ts_start at time zone %s)::date from public.anomalies "
        "where plant_id = %s and status <> 'resolved' and (ts_start at time zone %s)::date >= %s",
        (tz, plant_id, tz, since)).fetchall()
    return [{"type": t, "energy_lost_kwh": float(e or 0), "day": d} for t, e, d in rows]


def _camera(conn, plant_id: str) -> dict | None:
    """Latest analysed panel photo (camera capture / uploaded inspection) – table from the panel-photo step."""
    if not conn.execute("select to_regclass('public.panel_inspections') is not null").fetchone()[0]:
        return None
    row = conn.execute(
        "select taken_on, (result->>'soiled_pct')::float8, result->>'severity' from public.panel_inspections "
        "where plant_id = %s and kind = 'inspection' and result ? 'soiled_pct' "
        "order by taken_on desc, created_at desc limit 1", (plant_id,)).fetchone()
    return {"taken_on": row[0], "soiled_pct": row[1], "severity": row[2]} if row else None


def run(conn, plant: dict) -> dict:
    pid, tz = plant["id"], plant["timezone"]
    capacity_mw, tariff = plant["capacity_mw"], plant.get("tariff_inr_per_kwh", 0.0)
    cost_per_mw, water_per_mw = _plant_costs(conn, pid)
    daily = _daily(conn, pid)
    if daily.empty or not (daily["expected_energy_kwh"] > 0).any():
        return {"action": None, "note": "Needs uploaded data and an expected-generation model first."}

    days = list(daily["day"])
    as_of = days[-1]
    rain = _rain_by_day(conn, pid, tz, ("open-meteo",))
    resets = soiling.reset_days(days, rain, _cleanings(conn, pid, tz))
    resets.update(soiling.detect_jumps(daily, resets))   # cleanings nobody recorded show up as jumps in output
    rate = soiling.soiling_rate(daily, resets)
    losses = soiling.modelled_loss(days, resets, rate["rate_pct_per_day"])
    index = soiling.cleanliness_index(daily)
    reset_day, reset_reason = soiling.last_reset(days, resets, as_of)
    since = (as_of - reset_day).days

    forecast = [f for f in _forecast(conn, pid, tz) if f["day"] > as_of]
    recent = daily.loc[daily["expected_energy_kwh"] > 0, "expected_energy_kwh"].tail(14)
    energy_day = (sum(f["energy_kwh"] for f in forecast) / len(forecast)) if forecast else float(recent.median())
    cleaning_cost = cost_per_mw * capacity_mw
    plan = soiling.cleaning_plan(rate_pct=rate["rate_pct_per_day"], days_since_reset=since, as_of=as_of,
                                 energy_kwh_day=energy_day, tariff=tariff, cleaning_cost_inr=cleaning_cost,
                                 forecast=forecast)

    # combine every signal into the cleaning decision
    since_reset = [(d, None if pd.isna(v) else float(v)) for d, v in zip(days, index) if d >= reset_day]
    decision = cleaning_decision.decide(
        plan=plan, rate=rate, days_since_reset=since, as_of=as_of,
        trend=cleaning_decision.performance_trend([x for x in since_reset if x[1] is not None]),
        anomalies=_anomalies(conn, pid, tz, as_of - timedelta(days=13)), camera=_camera(conn, pid),
        forecast=forecast, tariff=tariff)

    readings = store.fetch_all_readings(conn, pid)
    step_h = analysis.interval_hours(readings["ts"]) if len(readings) > 1 else 0.25
    recent_r = readings[readings["ts"] >= pd.Timestamp(as_of - timedelta(days=COOLING_DAYS - 1)).tz_localize(tz)]
    cooling = soiling.cooling_analysis(recent_r, capacity_mw, tariff, tz, step_h)
    # the same question for the hottest two weeks in the data (summer case)
    local_day = readings["ts"].dt.tz_convert(tz).dt.date
    hottest = readings.groupby(local_day)["module_temp_c"].max().nlargest(COOLING_DAYS).index
    peak = soiling.cooling_analysis(readings[local_day.isin(hottest)], capacity_mw, tariff, tz, step_h)
    peak["period"] = f"{min(hottest):%d %b %Y} – {max(hottest):%d %b %Y}" if len(hottest) else None
    cooling["peak"] = peak

    result = {
        "rate": rate, "plan": plan, "decision": decision, "cooling": cooling,
        "cleaning": {"cost_inr": round(cleaning_cost), "water_l": round(water_per_mw * capacity_mw),
                     "cost_per_mw": cost_per_mw, "water_per_mw": water_per_mw},
        "energy_kwh_day": round(energy_day),
        "resets": [{"day": d.isoformat(), "reason": r} for d, r in sorted(resets.items())][-20:],
    }
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"cleaning:{pid}",))
        conn.execute(
            """update public.daily_summaries s set cleanliness_index = u.idx, soiling_loss_pct = u.loss
               from unnest(%s::date[], %s::float8[], %s::float8[]) as u(day, idx, loss)
               where s.plant_id = %s and s.day = u.day""",
            (days, [None if pd.isna(v) else round(float(v), 4) for v in index], [round(v, 3) for v in losses], pid))
        conn.execute(
            """insert into public.cleaning_analyses (plant_id, as_of, rate_pct_per_day, rate_source, days_since_reset,
                   last_reset, last_reset_reason, action, due_date, loss_pct, daily_loss_inr, cleaning_cost_inr,
                   optimal_interval_days, result)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (pid, as_of, rate["rate_pct_per_day"], rate["source"], since, reset_day, reset_reason, decision["action"],
             decision["due"], plan["loss_pct"], plan["daily_loss_inr"], cleaning_cost, plan["optimal_interval_days"],
             Jsonb(result)))
    return {"action": decision["action"], "due": decision["due"], "score": decision["score"], "loss_pct": plan["loss_pct"],
            "rate_pct_per_day": rate["rate_pct_per_day"], "rate_source": rate["source"], "cooling": cooling["verdict"]}
