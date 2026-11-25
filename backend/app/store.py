"""All SQL used by the upload pipeline."""
from __future__ import annotations

import math
from datetime import datetime

import pandas as pd
import psycopg
from psycopg.types.json import Jsonb

from .cleaning import READING_COLS

CHUNK = 5000


def get_plant(conn: psycopg.Connection, plant_id: str, user_id: str) -> dict | None:
    """The plant, only if it belongs to this user (the backend bypasses RLS, so this check is essential)."""
    row = conn.execute(
        "select id, name, capacity_mw, tariff_inr_per_kwh, timezone, latitude, longitude "
        "from public.plants where id = %s and owner_id = %s",
        (plant_id, user_id),
    ).fetchone()
    if not row:
        return None
    return {"id": str(row[0]), "name": row[1], "capacity_mw": float(row[2] or 0),
            "tariff_inr_per_kwh": float(row[3] or 0), "timezone": row[4] or "Asia/Kolkata",
            "latitude": float(row[5]) if row[5] is not None else None,
            "longitude": float(row[6]) if row[6] is not None else None}


def create_upload(conn, plant_id: str, user_id: str, file_name: str, kind: str, mode: str) -> str:
    row = conn.execute(
        "insert into public.data_uploads (plant_id, user_id, file_name, kind, mode) values (%s, %s, %s, %s, %s) returning id",
        (plant_id, user_id, file_name[:255], kind, mode),
    ).fetchone()
    return str(row[0])


def finish_upload(conn, upload_id: str, status: str, *, counts: dict | None = None,
                  ts_from: datetime | None = None, ts_to: datetime | None = None,
                  report: dict | None = None, error: str | None = None) -> None:
    c = counts or {}
    conn.execute(
        """update public.data_uploads set status = %s, rows_total = %s, rows_inserted = %s, rows_updated = %s,
               rows_skipped = %s, rows_rejected = %s, ts_from = %s, ts_to = %s, report = %s, error = %s,
               finished_at = now()
           where id = %s""",
        (status, c.get("total", 0), c.get("inserted", 0), c.get("updated", 0), c.get("skipped", 0),
         c.get("rejected", 0), ts_from, ts_to, Jsonb(report or {}), error, upload_id),
    )


def _clean_list(series: pd.Series, as_int: bool = False) -> list:
    out = []
    for v in series.tolist():
        if v is None or (isinstance(v, float) and math.isnan(v)):
            out.append(None)
        else:
            out.append(int(round(v)) if as_int else float(v))
    return out


_INSERT = """
insert into public.plant_readings
  (plant_id, upload_id, ts, dc_power_kw, ac_power_kw, daily_yield_kwh, total_yield_kwh, active_inverters,
   ambient_temp_c, module_temp_c, irradiation_kw_m2, quality_flags)
select %(plant)s, %(upload)s, u.r_ts, u.r_dc, u.r_ac, u.r_dy, u.r_ty, u.r_inv, u.r_amb, u.r_mod, u.r_irr,
       coalesce(string_to_array(nullif(u.r_flags, ''), ','), '{}')
from unnest(%(ts)s::timestamptz[], %(dc)s::float8[], %(ac)s::float8[], %(dy)s::float8[], %(ty)s::float8[],
            %(inv)s::int2[], %(amb)s::float8[], %(mod)s::float8[], %(irr)s::float8[], %(flags)s::text[])
     as u(r_ts, r_dc, r_ac, r_dy, r_ty, r_inv, r_amb, r_mod, r_irr, r_flags)
"""
_SKIP = _INSERT + " on conflict (plant_id, ts) do nothing returning true"
_REPLACE = _INSERT + """ on conflict (plant_id, ts) do update set
  dc_power_kw = excluded.dc_power_kw, ac_power_kw = excluded.ac_power_kw,
  daily_yield_kwh = excluded.daily_yield_kwh, total_yield_kwh = excluded.total_yield_kwh,
  active_inverters = excluded.active_inverters, ambient_temp_c = excluded.ambient_temp_c,
  module_temp_c = excluded.module_temp_c, irradiation_kw_m2 = excluded.irradiation_kw_m2,
  quality_flags = excluded.quality_flags, upload_id = excluded.upload_id
returning (xmax = 0)"""


def insert_readings(conn, plant_id: str, upload_id: str, df: pd.DataFrame, mode: str) -> dict:
    """Bulk insert. mode='skip' keeps existing rows; mode='replace' overwrites them."""
    inserted = updated = 0
    for start in range(0, len(df), CHUNK):
        part = df.iloc[start:start + CHUNK]
        params = {
            "plant": plant_id, "upload": upload_id,
            "ts": [t.to_pydatetime() for t in part["ts"]],
            "dc": _clean_list(part["dc_power_kw"]), "ac": _clean_list(part["ac_power_kw"]),
            "dy": _clean_list(part["daily_yield_kwh"]), "ty": _clean_list(part["total_yield_kwh"]),
            "inv": _clean_list(part["active_inverters"], as_int=True),
            "amb": _clean_list(part["ambient_temp_c"]), "mod": _clean_list(part["module_temp_c"]),
            "irr": _clean_list(part["irradiation_kw_m2"]),
            "flags": [",".join(f) for f in part["quality_flags"]],
        }
        rows = conn.execute(_SKIP if mode == "skip" else _REPLACE, params).fetchall()
        if mode == "skip":
            inserted += len(rows)
        else:
            new = sum(1 for r in rows if r[0])
            inserted += new
            updated += len(rows) - new
    return {"inserted": inserted, "updated": updated, "skipped": len(df) - inserted - updated}


def fetch_readings(conn, plant_id: str, start: datetime, end: datetime) -> pd.DataFrame:
    cur = conn.execute(
        f"select ts, {', '.join(READING_COLS)} from public.plant_readings "
        "where plant_id = %s and ts >= %s and ts < %s order by ts",
        (plant_id, start, end),
    )
    df = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    for col in READING_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def plant_reference(conn, plant_id: str) -> tuple[float | None, int | None]:
    """Normal AC output per unit of strong sunlight (median), and the most inverters ever reported."""
    row = conn.execute(
        """select
             (select percentile_cont(0.5) within group (order by ac_power_kw / irradiation_kw_m2)
                from public.plant_readings
               where plant_id = %(p)s and irradiation_kw_m2 >= 0.2 and ac_power_kw > 0),
             (select max(active_inverters) from public.plant_readings where plant_id = %(p)s)""",
        {"p": plant_id},
    ).fetchone()
    return (float(row[0]) if row[0] is not None else None, int(row[1]) if row[1] is not None else None)


def replace_rule_alarms(conn, plant_id: str, upload_id: str, start: datetime, end: datetime, alarms: list[dict]) -> None:
    """Recompute rule alarms for the window. Alarms the user already acknowledged/resolved are kept."""
    conn.execute(
        "delete from public.anomalies where plant_id = %s and source = 'rule' and status = 'open' "
        "and ts_start >= %s and ts_start < %s",
        (plant_id, start, end),
    )
    if not alarms:
        return
    with conn.cursor() as cur:
        cur.executemany(
            """insert into public.anomalies (plant_id, upload_id, source, type, severity, ts_start, ts_end, score,
                   expected_kw, actual_kw, energy_lost_kwh, explanation)
               values (%(plant_id)s, %(upload_id)s, 'rule', %(type)s, %(severity)s, %(ts_start)s, %(ts_end)s, %(score)s,
                   %(expected_kw)s, %(actual_kw)s, %(energy_lost_kwh)s, %(explanation)s)
               on conflict (plant_id, type, ts_start) do nothing""",
            [{**a, "plant_id": plant_id, "upload_id": upload_id} for a in alarms],
        )


_SUMMARY_COLS = [
    "energy_kwh", "dc_energy_kwh", "peak_ac_kw", "insolation_kwh_m2", "specific_yield_kwh_kwp",
    "performance_ratio", "availability_pct", "inverter_eff_pct", "avg_ambient_temp_c", "avg_module_temp_c",
    "max_module_temp_c", "thermal_loss_kwh", "inverter_loss_kwh", "revenue_inr", "co2_avoided_kg",
    "readings_count", "data_completeness_pct", "alarm_count",
]


def upsert_summaries(conn, plant_id: str, rows: list[dict]) -> None:
    if not rows:
        return
    cols = ", ".join(_SUMMARY_COLS)
    values = ", ".join(f"%({c})s" for c in _SUMMARY_COLS)
    updates = ", ".join(f"{c} = excluded.{c}" for c in _SUMMARY_COLS)
    with conn.cursor() as cur:
        cur.executemany(
            f"""insert into public.daily_summaries (plant_id, day, {cols}) values (%(plant_id)s, %(day)s, {values})
                on conflict (plant_id, day) do update set {updates}, computed_at = now()""",
            [{**r, "plant_id": plant_id} for r in rows],
        )


# ─────────────────────────────────────────────────────────────
# Forecasting
# ─────────────────────────────────────────────────────────────
def fetch_all_readings(conn, plant_id: str) -> pd.DataFrame:
    cur = conn.execute(
        f"select ts, {', '.join(READING_COLS)}, quality_flags from public.plant_readings "
        "where plant_id = %s order by ts",
        (plant_id,),
    )
    df = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    for col in READING_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["quality_flags"] = df["quality_flags"].apply(lambda f: list(f or []))
    return df


def outage_periods(conn, plant_id: str) -> list[tuple]:
    """Alarm periods that are data problems rather than plant behaviour."""
    rows = conn.execute(
        "select ts_start, ts_end from public.anomalies where plant_id = %s "
        "and type in ('inverter_dropout', 'sensor_fault')",
        (plant_id,),
    ).fetchall()
    return [(pd.Timestamp(a), pd.Timestamp(b)) for a, b in rows]


WEATHER_COLS = ["ghi_w_m2", "temp_c", "cloud_cover_pct", "precipitation_mm", "humidity_pct", "wind_speed_ms"]


def weather_hours(conn, plant_id: str, start: datetime, end: datetime, source: str = "open-meteo") -> int:
    return conn.execute(
        "select count(*) from public.weather_data where plant_id = %s and source = %s and ts >= %s and ts < %s",
        (plant_id, source, start, end),
    ).fetchone()[0]


def upsert_weather(conn, plant_id: str, df: pd.DataFrame, source: str) -> int:
    if df.empty:
        return 0
    cols = ", ".join(WEATHER_COLS)
    conn.execute(
        f"""insert into public.weather_data (plant_id, source, ts, {cols})
            select %(p)s, %(s)s, u.ts, u.c0, u.c1, u.c2, u.c3, u.c4, u.c5
            from unnest(%(ts)s::timestamptz[], %(c0)s::float8[], %(c1)s::float8[], %(c2)s::float8[],
                        %(c3)s::float8[], %(c4)s::float8[], %(c5)s::float8[]) as u(ts, c0, c1, c2, c3, c4, c5)
            on conflict (plant_id, source, ts) do update set
              {", ".join(f"{c} = excluded.{c}" for c in WEATHER_COLS)}, fetched_at = now()""",
        {"p": plant_id, "s": source, "ts": [t.to_pydatetime() for t in df["ts"]],
         **{f"c{i}": _clean_list(df[c]) for i, c in enumerate(WEATHER_COLS)}},
    )
    return len(df)


def fetch_weather(conn, plant_id: str, start: datetime, end: datetime, source: str = "open-meteo") -> pd.DataFrame:
    cur = conn.execute(
        f"select ts, {', '.join(WEATHER_COLS)} from public.weather_data "
        "where plant_id = %s and source = %s and ts >= %s and ts < %s order by ts",
        (plant_id, source, start, end),
    )
    df = pd.DataFrame(cur.fetchall(), columns=[d.name for d in cur.description])
    df["ts"] = pd.to_datetime(df["ts"], utc=True)
    for col in WEATHER_COLS:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df


def create_forecast_run(conn, plant_id: str, run: dict) -> str:
    row = conn.execute(
        """insert into public.forecast_runs (plant_id, mode, expected_model, day_ahead_model, metrics, train_days,
               forecast_from, forecast_to, notes)
           values (%s, %s, %s, %s, %s, %s, %s, %s, %s) returning id""",
        (plant_id, run["mode"], run.get("expected_model"), run.get("day_ahead_model"), Jsonb(run.get("metrics", {})),
         run.get("train_days", 0), run.get("forecast_from"), run.get("forecast_to"), Jsonb(run.get("notes", []))),
    ).fetchone()
    return str(row[0])


def write_forecasts(conn, plant_id: str, run_id: str, kind: str, df: pd.DataFrame, overwrite: bool) -> int:
    """overwrite=False keeps existing values (an issued forecast for a past hour is never changed)."""
    if df.empty:
        return 0
    conflict = ("do update set predicted_kw = excluded.predicted_kw, lower_kw = excluded.lower_kw, "
                "upper_kw = excluded.upper_kw, run_id = excluded.run_id, issued_at = now()") if overwrite else "do nothing"
    for start in range(0, len(df), CHUNK):
        part = df.iloc[start:start + CHUNK]
        conn.execute(
            f"""insert into public.power_forecasts (plant_id, kind, ts, predicted_kw, lower_kw, upper_kw, run_id)
                select %(p)s, %(k)s, u.ts, u.pred, u.lo, u.hi, %(r)s
                from unnest(%(ts)s::timestamptz[], %(pred)s::float8[], %(lo)s::float8[], %(hi)s::float8[])
                     as u(ts, pred, lo, hi)
                on conflict (plant_id, kind, ts) {conflict}""",
            {"p": plant_id, "k": kind, "r": run_id, "ts": [pd.Timestamp(t).to_pydatetime() for t in part["ts"]],
             "pred": _clean_list(part["predicted_kw"]), "lo": _clean_list(part["lower_kw"]),
             "hi": _clean_list(part["upper_kw"])},
        )
    return len(df)


def delete_future_forecasts(conn, plant_id: str, after: datetime) -> None:
    """Future day-ahead values from older runs are replaced by the new run."""
    conn.execute("delete from public.power_forecasts where plant_id = %s and kind = 'day_ahead' and ts > %s",
                 (plant_id, after))


def update_expected_energy(conn, plant_id: str, tz: str, interval_h: float) -> None:
    conn.execute(
        """update public.daily_summaries s set expected_energy_kwh = x.e
           from (select (ts at time zone %(tz)s)::date as d, sum(predicted_kw) * %(h)s as e
                   from public.power_forecasts where plant_id = %(p)s and kind = 'expected' group by 1) x
           where s.plant_id = %(p)s and s.day = x.d""",
        {"p": plant_id, "tz": tz, "h": interval_h},
    )


# ─────────────────────────────────────────────────────────────
# ML anomalies
# ─────────────────────────────────────────────────────────────
def replace_ml_anomalies(conn, plant_id: str, events: list[dict]) -> int:
    """Re-detection replaces OPEN ML anomalies; ones the user acknowledged/resolved are kept
    (the same event found again then hits the unique key and is skipped)."""
    conn.execute("delete from public.anomalies where plant_id = %s and source = 'ml' and status = 'open'", (plant_id,))
    if not events:
        return 0
    with conn.cursor() as cur:
        cur.executemany(
            """insert into public.anomalies (plant_id, source, type, severity, ts_start, ts_end, score,
                   expected_kw, actual_kw, energy_lost_kwh, explanation, details)
               values (%(plant_id)s, 'ml', %(type)s, %(severity)s, %(ts_start)s, %(ts_end)s, %(score)s,
                   %(expected_kw)s, %(actual_kw)s, %(energy_lost_kwh)s, %(explanation)s, %(details)s)
               on conflict (plant_id, type, ts_start) do nothing""",
            [{**e, "plant_id": plant_id, "details": Jsonb(e.get("details", {}))} for e in events],
        )
    return len(events)
