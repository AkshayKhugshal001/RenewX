"""ML anomaly detection for one plant: load readings → detect → store in `anomalies` (source = 'ml').

Runs after every upload (after the forecast refresh) and from POST /plants/{id}/anomalies/detect.
Rule alarms (analysis.py) stay as they are; ML events are stored next to them.
"""
from __future__ import annotations

from collections import Counter

from . import anomaly_detection as ad, forecasting as fc, store


def run(conn, plant: dict) -> dict:
    pid, tz = plant["id"], plant["timezone"]
    readings = store.fetch_all_readings(conn, pid)
    capacity_kwp = plant["capacity_mw"] * 1000
    scale = capacity_kwp if capacity_kwp > 0 else (float(readings["ac_power_kw"].max()) if not readings.empty else 0.0)

    events, info = [], {"method": None, "checked": 0}
    if not readings.empty and scale > 0:
        usable = fc.usable_rows(readings, store.outage_periods(conn, pid))  # rule-explained periods are skipped
        events, info = ad.detect(readings, usable, fc.healthy_rows(readings, usable), scale, tz,
                                 plant.get("tariff_inr_per_kwh", 0.0))

    with conn.transaction():
        conn.execute("select pg_advisory_xact_lock(hashtext(%s))", (f"anomalies:{pid}",))
        store.replace_ml_anomalies(conn, pid, events)

    return {
        "found": len(events),
        "by_type": dict(Counter(e["type"] for e in events)),
        "energy_lost_kwh": round(sum(e["energy_lost_kwh"] or 0 for e in events)),
        "method": info.get("method"),
        "readings_checked": info.get("checked", 0),
    }
