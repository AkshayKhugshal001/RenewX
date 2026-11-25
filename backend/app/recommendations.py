"""AI Recommendations: turn the outputs of every module into ranked, explainable actions. Pure functions.

Sources: cleaning decision, open anomalies (grouped by cause), sensor issues, open tasks (overdue / best day from
the forecast), cooling, battery dispatch what-if. Every recommendation has the same shape:
  key (stable id for de-duplication), type, title, summary, evidence[], gains over the next 30 days
  (kWh, ₹, CO₂), cost (₹, water), confidence 0–100, priority, due date and the action "Approve" performs:
    create_task – new maintenance task (template)   reschedule – move an existing task   open_task – go to a task
Ranking: value = (gain ₹ − cost ₹) × confidence, with overdue work and high priority first.
The numbers come from the models; an LLM may later rewrite `summary` in friendlier words, never the numbers.
"""
from __future__ import annotations

from datetime import date, timedelta

CO2_KG_PER_KWH = 0.71
HORIZON_DAYS = 30
DOWNTIME_HOURS = 4                     # assumed midday downtime for repair/inspection/cleaning work
TASK_COST = {"repair": 15000, "inspection": 3000, "calibration": 2000, "cleaning": None, "other": 0}
PRIORITY_ORDER = {"high": 0, "medium": 1, "low": 2}

ANOMALY_ACTIONS = {
    # cause: (category, title, what to check)
    "inverter_fault": ("repair", "Inspect and repair inverters", "inverter logs, cooling fans, derating settings and AC/DC efficiency"),
    "inverter_dropout": ("repair", "Fix inverters that stop reporting", "inverter trips, communication cables and the data logger"),
    "overheating": ("inspection", "Check module ventilation and hot spots", "airflow under the modules, hot spots (thermal camera) and the cooling schedule"),
    "shading": ("inspection", "Remove the cause of shading", "trees, poles, buildings or neighbouring rows shading the panels at the same hour"),
    "clipping": ("inspection", "Check inverter power limits / grid curtailment", "inverter export limits and grid curtailment instructions"),
    "output_drop": ("inspection", "Inspect strings, connectors and breakers", "string currents, connectors, fuses and breakers"),
    "underperformance": ("inspection", "Inspect strings, connectors and breakers", "string currents, connectors, fuses and breakers"),
    "sensor_fault": ("calibration", "Repair the irradiation sensor", "the irradiation sensor, its cable and data logger channel"),
    "data_gap": ("inspection", "Fix missing data (logger / communication)", "the data logger, network and power supply"),
}
LABEL = {"inverter_fault": "inverter fault", "inverter_dropout": "inverters not reporting", "overheating": "overheating",
         "shading": "shading", "clipping": "clipping", "output_drop": "output drop", "underperformance": "underperformance",
         "sensor_fault": "sensor fault", "data_gap": "data gap", "sensor_mismatch": "sunlight-sensor mismatch"}


def _rec(key, type_, title, summary, *, evidence, gain_kwh=0.0, tariff=0.0, cost=0.0, water=0.0, confidence=50,
         priority="medium", due=None, action=None, extra=None):
    gain_inr = gain_kwh * tariff
    return {
        "key": key, "type": type_, "title": title, "summary": summary, "evidence": evidence,
        "gain_kwh": round(gain_kwh), "gain_inr": round(gain_inr), "cost_inr": round(cost or 0), "water_l": round(water or 0),
        "co2_kg": round(gain_kwh * CO2_KG_PER_KWH), "confidence": int(max(0, min(100, confidence))), "priority": priority,
        "due_date": due.isoformat() if isinstance(due, date) else due, "action": action or {"kind": "none"},
        "details": extra or {},
    }


def _task(title, category, priority, due, cost, notes):
    return {"kind": "create_task", "task": {"title": title, "category": category, "priority": priority,
                                            "due_date": due.isoformat() if due else None, "est_cost_inr": cost, "notes": notes}}


def from_cleaning(cl: dict | None, *, as_of: date, tariff: float) -> list[dict]:
    if not cl:
        return []
    r = cl.get("result") or {}
    d, plan, cleaning = r.get("decision") or {}, r.get("plan") or {}, r.get("cleaning") or {}
    action, energy_day = cl.get("action"), r.get("energy_kwh_day") or 0
    reason = d.get("reason") or plan.get("reason") or ""
    loss = (cl.get("loss_pct") or 0) / 100
    ev = [e["text"] for e in d.get("evidence", []) if e.get("status") in ("supports", "against")][:4]
    cost, water = cleaning.get("cost_inr", 0), cleaning.get("water_l", 0)
    due = date.fromisoformat(cl["due_date"]) if cl.get("due_date") else as_of + timedelta(days=1)
    if action in ("clean_now", "clean_in"):
        gain = loss * energy_day * HORIZON_DAYS          # the current soiling loss avoided for the next 30 days
        return [_rec("cleaning", "cleaning", "Clean the panels" + (" now" if action == "clean_now" else f" around {due:%d %b}"),
                     reason, evidence=ev, gain_kwh=gain, tariff=tariff, cost=cost, water=water,
                     confidence=d.get("score", 50), priority="high" if action == "clean_now" else "medium", due=due,
                     action=_task("Module cleaning (whole plant)", "cleaning", "high" if action == "clean_now" else "medium",
                                  due, cost, reason),
                     extra={"cleaning_score": d.get("score"), "loss_pct": cl.get("loss_pct")})]
    if action == "wait_rain":
        return [_rec("cleaning_wait", "cleaning", f"Postpone cleaning – rain expected {due:%d %b}",
                     reason, evidence=ev, gain_kwh=0, tariff=tariff, cost=-cost, water=-water,
                     confidence=d.get("score", 50), priority="low", due=due,
                     extra={"saved_inr": cost, "saved_water_l": water})]
    return []


def from_anomalies(anomalies: list[dict], *, as_of: date, tariff: float, window_days: int) -> list[dict]:
    """anomalies: open/acknowledged, without a task, in the last `window_days` of data."""
    out, groups = [], {}
    for a in anomalies:
        groups.setdefault(a["type"], []).append(a)
    for cause, items in groups.items():
        if cause == "sensor_mismatch":
            days = sorted({a["day"] for a in items})
            out.append(_rec("sensor_mismatch", "sensor", "Clean / calibrate the irradiation sensor",
                            "The sunlight sensor reads lower than the plant's output shows. Every estimate (expected output, "
                            "soiling, anomalies) depends on it, so this cheap fix improves the whole analysis.",
                            evidence=[f"Detected on {len(days)} day(s), last on {days[-1]:%d %b}."], confidence=70,
                            cost=TASK_COST["calibration"], priority="medium", due=as_of + timedelta(days=3),
                            action=_task("Clean and calibrate the irradiation sensor", "calibration", "medium",
                                         as_of + timedelta(days=3), TASK_COST["calibration"], "Sunlight-sensor mismatch anomalies.")))
            continue
        if cause not in ANOMALY_ACTIONS:
            continue
        category, title, check = ANOMALY_ACTIONS[cause]
        lost = sum(a.get("energy_lost_kwh") or 0 for a in items)
        days = sorted({a["day"] for a in items})
        high = sum(a["severity"] == "high" for a in items)
        per_day = lost / max(window_days, 1)
        gain = per_day * HORIZON_DAYS * 0.8                       # assume the fix removes ~80 % of the loss
        confidence = min(90, 40 + 10 * len(days) + 10 * high)
        priority = "high" if high or lost * tariff > 20000 else "medium" if len(days) >= 2 else "low"
        due = as_of + timedelta(days={"high": 1, "medium": 3, "low": 7}[priority])
        cost = TASK_COST[category] or 0
        out.append(_rec(f"anomaly:{cause}", "anomaly", title,
                        f"{len(items)} {LABEL[cause]} event(s) on {len(days)} day(s) cost ≈ {lost:,.0f} kWh"
                        + (f" (₹{lost * tariff:,.0f})" if tariff else "") + f". Check {check}.",
                        evidence=[f"{a['day']:%d %b}: {a.get('explanation') or LABEL[cause]}" for a in items[:3]],
                        gain_kwh=gain, tariff=tariff, cost=cost, confidence=confidence, priority=priority, due=due,
                        action=_task(f"{title} ({LABEL[cause]})", category, priority, due, cost,
                                     f"{len(items)} event(s), ≈ {lost:,.0f} kWh lost. Check {check}."),
                        extra={"events": len(items), "days": len(days), "lost_kwh": round(lost), "anomaly_ids": [a["id"] for a in items]}))
    return out


def from_tasks(tasks: list[dict], forecast: list[dict], *, today: date, tariff: float) -> list[dict]:
    """Overdue tasks, and the best forecast day for planned work that needs downtime."""
    out = []
    for t in tasks:
        due = t.get("due_date")
        if due and due < today:
            late = (today - due).days
            out.append(_rec(f"overdue:{t['id']}", "reminder", f"Overdue: {t['title']}",
                            f"This task was due {late} day(s) ago ({due:%d %b}).", evidence=[], confidence=95,
                            priority="high" if t.get("priority") == "high" or late > 7 else "medium", due=today,
                            action={"kind": "open_task", "task_id": t["id"]}))
    days = [f for f in forecast if f["day"] >= today][:7]
    if len(days) < 3:
        return out
    best = min(days, key=lambda f: f["midday_kw"])
    for t in tasks:
        due = t.get("due_date")
        if t.get("category") not in ("repair", "inspection", "cleaning") or t.get("status") != "planned" or not due:
            continue
        if not (today <= due <= today + timedelta(days=7)) or due == best["day"]:
            continue
        on_due = next((f for f in days if f["day"] == due), None)
        if not on_due:
            continue
        saved = (on_due["midday_kw"] - best["midday_kw"]) * DOWNTIME_HOURS
        if saved * tariff < 1000:
            continue
        out.append(_rec(f"reschedule:{t['id']}", "schedule", f"Do “{t['title']}” on {best['day']:%a %d %b}",
                        f"That day has the lowest forecast generation this week, so {DOWNTIME_HOURS} h of downtime loses "
                        f"≈ {saved:,.0f} kWh less than on {due:%d %b}.",
                        evidence=[f"Forecast midday output {best['midday_kw'] / 1000:,.1f} MW on {best['day']:%d %b} vs "
                                  f"{on_due['midday_kw'] / 1000:,.1f} MW on {due:%d %b}."],
                        gain_kwh=saved, tariff=tariff, confidence=65, priority="low", due=best["day"],
                        action={"kind": "reschedule", "task_id": t["id"], "due_date": best["day"].isoformat()}))
    return out


def from_cooling(cooling: dict | None, *, as_of: date, tariff: float) -> list[dict]:
    if not cooling or cooling.get("verdict") != "recommended":
        return []
    gain = cooling["gain_kwh_per_day"] * HORIZON_DAYS
    return [_rec("cooling", "cooling", f"Spray-cool the modules {cooling.get('window') or 'at midday'}",
                 cooling.get("reason", ""), evidence=[], gain_kwh=gain, tariff=tariff,
                 cost=cooling["water_cost_inr_per_day"] * HORIZON_DAYS, water=cooling["water_l_per_day"] * HORIZON_DAYS,
                 confidence=55, priority="low", due=as_of + timedelta(days=1),
                 action=_task("Start daily module cooling", "other", "low", as_of + timedelta(days=1), None, cooling.get("reason", "")))]


def from_battery(plan: dict | None, *, day: date | None, capacity_mwh: float, power_mw: float) -> list[dict]:
    if not plan or plan["gain_inr"] <= 0 or not day:
        return []
    charge = [h["hour"] for h in plan["hours"] if h["charge_kw"] > 1]
    out_h = [h["hour"] for h in plan["hours"] if h["discharge_kw"] > 1]
    when = (f"store solar {min(charge):02d}:00–{max(charge) + 1:02d}:00 and export {min(out_h):02d}:00–{max(out_h) + 1:02d}:00"
            if charge and out_h else "shift solar energy to the evening peak")
    month = plan["gain_inr"] * HORIZON_DAYS
    rec = _rec("battery", "battery", f"Battery what-if: {when}",
               f"With a {capacity_mwh:g} MWh / {power_mw:g} MW battery, shifting ≈ {plan['shifted_kwh'] / 1000:,.1f} MWh to the "
               f"evening peak would earn ≈ ₹{plan['gain_inr']:,.0f} more on {day:%d %b} (≈ ₹{month:,.0f}/month if days are similar). "
               "Simulated – the plant has no battery; it shows what storage would be worth under a time-of-day tariff.",
               evidence=[f"Revenue {day:%d %b}: ₹{plan['revenue_without_inr']:,.0f} without vs ₹{plan['revenue_with_inr']:,.0f} with battery.",
                         f"≈ {plan['losses_kwh']:,.0f} kWh lost in charging/discharging (90 % round trip)."],
               confidence=45, priority="low", due=day, action={"kind": "none"}, extra={"day": day.isoformat(), "plan": plan})
    rec["gain_inr"] = round(month)          # value over 30 days (energy is shifted, not gained)
    return [rec]


def rank(recs: list[dict]) -> list[dict]:
    for r in recs:
        r["value"] = round((r["gain_inr"] - max(r["cost_inr"], 0)) * r["confidence"] / 100)
    return sorted(recs, key=lambda r: (PRIORITY_ORDER[r["priority"]], r["type"] != "reminder", -r["value"]))
