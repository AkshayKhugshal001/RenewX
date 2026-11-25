"""Battery what-if and recommendation building on synthetic inputs. Run with pytest."""
from datetime import date, timedelta

import numpy as np

from app import battery
from app import recommendations as rc

DAY = date(2026, 11, 26)
SOLAR = [0, 0, 0, 0, 0, 0, 500, 4000, 10000, 16000, 20000, 22000, 22000, 20000, 16000, 10000, 4000, 500, 0, 0, 0, 0, 0, 0]


def plan(**kw):
    args = dict(capacity_kwh=10000, power_kw=5000, grid_limit_kw=36000, tariff=3.0)
    return battery.dispatch(SOLAR, **{**args, **kw})


def test_battery_shifts_solar_to_the_evening_peak():
    p = plan()
    assert p["gain_inr"] > 0 and p["shifted_kwh"] > 0
    charged = [h["hour"] for h in p["hours"] if h["charge_kw"] > 1]
    used = [h["hour"] for h in p["hours"] if h["discharge_kw"] > 1]
    assert min(charged) >= 9 and max(charged) < 17 and set(used) <= set(range(18, 22))   # cheap in, peak out
    assert max(h["soc_kwh"] for h in p["hours"]) <= 10000 + 1 and p["hours"][-1]["soc_kwh"] < 1
    # energy balance with 90 % round trip
    assert abs(p["shifted_kwh"] - 0.9 * p["stored_kwh"]) <= 2


def test_battery_respects_the_grid_limit_and_bad_inputs():
    p = plan(grid_limit_kw=18000)                     # midday output above the export limit
    assert p is not None and all(h["export_kw"] <= 18000 + 1 for h in p["hours"])
    assert p["gain_inr"] > plan()["gain_inr"]          # storing would-be-curtailed energy is worth more
    assert plan(capacity_kwh=0) is None and plan(tariff=0) is None


def anomaly(type_, day, kwh=3000, severity="medium"):
    return {"id": f"{type_}-{day}", "type": type_, "severity": severity, "energy_lost_kwh": kwh, "day": day, "explanation": "x"}


def test_anomalies_are_grouped_by_cause_with_a_task_template():
    recs = rc.from_anomalies([anomaly("inverter_fault", DAY - timedelta(days=i), severity="high") for i in range(3)]
                             + [anomaly("sensor_mismatch", DAY)], as_of=DAY, tariff=3.0, window_days=30)
    inv = next(r for r in recs if r["key"] == "anomaly:inverter_fault")
    assert inv["priority"] == "high" and inv["action"]["kind"] == "create_task"
    assert inv["action"]["task"]["category"] == "repair" and inv["gain_kwh"] == round(9000 / 30 * 30 * 0.8)
    assert inv["co2_kg"] == round(inv["gain_kwh"] * 0.71)
    assert any(r["key"] == "sensor_mismatch" for r in recs)


def test_overdue_tasks_and_best_day_scheduling():
    forecast = [{"day": DAY + timedelta(days=i), "energy_kwh": 1e5, "midday_kw": kw} for i, kw in enumerate([20000, 21000, 8000, 19000])]
    tasks = [{"id": "t1", "title": "Inverter check", "category": "repair", "priority": "medium", "status": "planned", "due_date": DAY + timedelta(days=1)},
             {"id": "t2", "title": "Old task", "category": "inspection", "priority": "low", "status": "planned", "due_date": DAY - timedelta(days=3)}]
    recs = rc.from_tasks(tasks, forecast, today=DAY, tariff=3.0)
    assert any(r["key"] == "overdue:t2" and r["action"]["kind"] == "open_task" for r in recs)
    move = next(r for r in recs if r["key"] == "reschedule:t1")
    assert move["action"] == {"kind": "reschedule", "task_id": "t1", "due_date": (DAY + timedelta(days=2)).isoformat()}
    assert move["gain_kwh"] == (21000 - 8000) * rc.DOWNTIME_HOURS


def test_cleaning_recommendation_and_ranking():
    cl = {"action": "clean_now", "due_date": DAY.isoformat(), "loss_pct": 6.0,
          "result": {"energy_kwh_day": 100000, "cleaning": {"cost_inr": 216000, "water_l": 144000},
                     "decision": {"score": 80, "reason": "Dirty.", "evidence": [{"status": "supports", "text": "Soiling 6 %"}]}}}
    clean = rc.from_cleaning(cl, as_of=DAY, tariff=3.0)[0]
    assert clean["gain_kwh"] == 6 / 100 * 100000 * 30 and clean["water_l"] == 144000 and clean["priority"] == "high"
    wait = rc.from_cleaning({**cl, "action": "wait_rain"}, as_of=DAY, tariff=3.0)[0]
    assert wait["key"] == "cleaning_wait" and wait["action"]["kind"] == "none"
    ranked = rc.rank([clean, *rc.from_battery(plan(), day=DAY, capacity_mwh=10, power_mw=5)])
    assert ranked[0]["key"] == "cleaning" and all("value" in r for r in ranked)
    assert np.isfinite([r["value"] for r in ranked]).all()


# ── environment equivalents and the PDF renderer ─────────────────────────
from app import environment, report_pdf  # noqa: E402


def test_environment_equivalents_and_indicator():
    e = environment.equivalents(100000, 30)          # 100 MWh in 30 days
    assert e["co2_kg"] == 71000 and e["trees"] == round(71000 / 21) and e["homes"] == 1000
    assert environment.indicator(2000, 100000, 1, 30)["level"] == "Low"        # 20 L/MWh
    assert environment.indicator(10000, 100000, 1, 30)["level"] == "Medium"    # 100 L/MWh
    assert environment.indicator(2000, 100000, 6, 30)["level"] == "Medium"     # frequent cleaning raises it


def test_pdf_renders_and_handles_unicode():
    assert report_pdf.txt("₹ 1,000 ≈ CO₂ – done") == "Rs  1,000 ~ CO2 - done"
    data = {"kind": "performance", "generated": "now", "plant": {"name": "Test – plant", "capacity_mw": 36, "tariff": 3,
            "timezone": "Asia/Kolkata"}, "start": DAY, "end": DAY, "daily": [], "environment": {}}
    assert report_pdf.render(data)[:5] == b"%PDF-"
