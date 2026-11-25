"""AI Recommendations for one plant: collect module outputs → build + rank → store.

Runs after every upload (last step), after a cleaning analysis and from POST /plants/{id}/recommendations/refresh.
Open recommendations are replaced on each run; approved / dismissed / done ones are kept, and their keys are not
suggested again while the task is open (approved), for 7 days (dismissed) or 7 days (done).
"""
from __future__ import annotations

from datetime import date, timedelta

import pandas as pd
from psycopg.types.json import Jsonb

import logging

from . import assistant, battery, recommendations as rc

log = logging.getLogger(__name__)

ANOMALY_WINDOW_DAYS = 30
SNOOZE_DAYS = 7


def _plant_settings(conn, pid: str) -> dict:
    return conn.execute("select to_jsonb(p) from public.plants p where id = %s", (pid,)).fetchone()[0]


def _latest_cleaning(conn, pid: str) -> dict | None:
    if not conn.execute("select to_regclass('public.cleaning_analyses') is not null").fetchone()[0]:
        return None
    row = conn.execute("select to_jsonb(c) from public.cleaning_analyses c where plant_id = %s "
                       "order by created_at desc limit 1", (pid,)).fetchone()
    return row[0] if row else None


def _anomalies(conn, pid: str, tz: str, since: date) -> list[dict]:
    has_tasks = conn.execute("select to_regclass('public.maintenance_tasks') is not null").fetchone()[0]
    no_task = ("and not exists (select 1 from public.maintenance_tasks t where t.anomaly_id = a.id)" if has_tasks else "")
    rows = conn.execute(
        f"select a.id, a.type, a.severity, a.energy_lost_kwh, (a.ts_start at time zone %s)::date, a.explanation "
        f"from public.anomalies a where a.plant_id = %s and a.status in ('open', 'acknowledged') "
        f"and (a.ts_start at time zone %s)::date >= %s {no_task} order by a.ts_start",
        (tz, pid, tz, since)).fetchall()
    return [{"id": str(i), "type": t, "severity": s, "energy_lost_kwh": float(e or 0), "day": d, "explanation": x}
            for i, t, s, e, d, x in rows]


def _tasks(conn, pid: str) -> list[dict]:
    if not conn.execute("select to_regclass('public.maintenance_tasks') is not null").fetchone()[0]:
        return []
    rows = conn.execute("select id, title, category, priority, status, due_date from public.maintenance_tasks "
                        "where plant_id = %s and status in ('planned', 'in_progress')", (pid,)).fetchall()
    return [{"id": str(i), "title": t, "category": c, "priority": p, "status": s, "due_date": d} for i, t, c, p, s, d in rows]


def _forecast(conn, pid: str, tz: str) -> tuple[list[dict], dict[date, list[float]]]:
    """Per forecast day: energy and average 10–15 h output; plus 24 hourly values per day (for the battery)."""
    run = conn.execute("select forecast_from, forecast_to from public.forecast_runs where plant_id = %s "
                       "order by created_at desc limit 1", (pid,)).fetchone()
    if not run or run[0] is None:
        return [], {}
    rows = conn.execute("select ts, predicted_kw from public.power_forecasts where plant_id = %s and kind = 'day_ahead' "
                        "and ts > %s and ts <= %s order by ts", (pid, run[0], run[1])).fetchall()
    if not rows:
        return [], {}
    df = pd.DataFrame(rows, columns=["ts", "kw"])
    local = (pd.to_datetime(df["ts"], utc=True) - pd.Timedelta(minutes=30)).dt.tz_convert(tz)   # hour-end labels
    df["day"], df["hour"], df["kw"] = local.dt.date, local.dt.hour, df["kw"].astype(float)
    days, hourly = [], {}
    for d, g in df.groupby("day"):
        mid = g[(g["hour"] >= 10) & (g["hour"] < 15)]["kw"]
        days.append({"day": d, "energy_kwh": float(g["kw"].sum()), "midday_kw": float(mid.mean()) if len(mid) else 0.0})
        h = g.groupby("hour")["kw"].mean().reindex(range(24), fill_value=0.0)
        if len(g) >= 20:
            hourly[d] = h.tolist()
    return days, hourly


def _blocked_keys(conn, pid: str) -> set[str]:
    rows = conn.execute(
        """select r.key from public.recommendations r
            left join public.maintenance_tasks t on t.id = r.task_id
           where r.plant_id = %s and (
                 (r.status = 'approved' and (t.id is null or t.status in ('planned', 'in_progress')))
              or (r.status in ('dismissed', 'done') and r.updated_at > now() - make_interval(days => %s)))""",
        (pid, SNOOZE_DAYS)).fetchall()
    return {r[0] for r in rows}


def build(conn, plant: dict) -> tuple[list[dict], dict]:
    pid, tz = plant["id"], plant["timezone"]
    tariff, capacity_mw = plant.get("tariff_inr_per_kwh") or 0.0, plant["capacity_mw"]
    settings = _plant_settings(conn, pid)
    last = conn.execute("select max(day) from public.daily_summaries where plant_id = %s", (pid,)).fetchone()[0]
    today = pd.Timestamp.now(tz=tz).date()
    as_of = last or today
    cleaning = _latest_cleaning(conn, pid)
    forecast, hourly = _forecast(conn, pid, tz)

    recs = []
    recs += rc.from_cleaning(cleaning, as_of=as_of, tariff=tariff)
    recs += rc.from_anomalies(_anomalies(conn, pid, tz, as_of - timedelta(days=ANOMALY_WINDOW_DAYS - 1)),
                              as_of=as_of, tariff=tariff, window_days=ANOMALY_WINDOW_DAYS)
    recs += rc.from_tasks(_tasks(conn, pid), forecast, today=today, tariff=tariff)
    recs += rc.from_cooling(((cleaning or {}).get("result") or {}).get("cooling"), as_of=as_of, tariff=tariff)

    cap_mwh = float(settings.get("battery_capacity_mwh") or 0)
    pow_mw = float(settings.get("battery_power_mw") or 0)
    future = sorted(d for d in hourly if d >= today) or sorted(hourly)
    plan_day = future[0] if future else None
    plan = (battery.dispatch(hourly[plan_day], capacity_kwh=cap_mwh * 1000, power_kw=pow_mw * 1000,
                             grid_limit_kw=capacity_mw * 1000 or float("inf"), tariff=tariff) if plan_day else None)
    recs += rc.from_battery(plan, day=plan_day, capacity_mwh=cap_mwh, power_mw=pow_mw)

    blocked = _blocked_keys(conn, pid)
    recs = rc.rank([r for r in recs if r["key"] not in blocked])
    return recs, {"as_of": as_of.isoformat(), "blocked": sorted(blocked), "battery_day": plan_day.isoformat() if plan_day else None}


def run(conn, plant: dict) -> dict:
    recs, info = build(conn, plant)
    pid = plant["id"]
    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"recommendations:{pid}",))
        conn.execute("delete from public.recommendations where plant_id = %s and status = 'open'", (pid,))
        with conn.cursor() as cur:
            cur.executemany(
                """insert into public.recommendations (plant_id, key, type, title, summary, evidence, details, action,
                       gain_kwh, gain_inr, cost_inr, water_l, co2_kg, confidence, priority, value, rank, due_date)
                   values (%(plant_id)s, %(key)s, %(type)s, %(title)s, %(summary)s, %(evidence)s, %(details)s, %(action)s,
                       %(gain_kwh)s, %(gain_inr)s, %(cost_inr)s, %(water_l)s, %(co2_kg)s, %(confidence)s, %(priority)s,
                       %(value)s, %(rank)s, %(due_date)s)""",
                [{**r, "plant_id": pid, "rank": i + 1, "evidence": Jsonb(r["evidence"]), "details": Jsonb(r["details"]),
                  "action": Jsonb(r["action"])} for i, r in enumerate(recs)])
    worded = 0
    try:   # friendlier wording by the LLM (optional; numbers are checked, the template stays as fallback)
        worded = assistant.reword_recommendations(conn, pid)
    except Exception:
        log.warning("LLM wording of recommendations skipped", exc_info=True)
    return {"count": len(recs), "top": recs[0]["title"] if recs else None, "ai_worded": worded, **info}
