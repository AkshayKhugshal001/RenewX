"""Cleaning decision: combine every available signal into one score (0–100), a decision and the evidence.

Signals (points; a missing signal is left out and the score is rescaled over the ones available):
  soiling     0…40  modelled soiling loss vs the loss at which cleaning pays off (× confidence of the rate)
  performance 0…20  drop of actual ÷ expected since the panels were last clean (a sudden step counts half)
  anomalies −15…10  gradual multi-day output drops support cleaning; faults cleaning can't fix count against
  camera      0…30  soiled area % from the latest panel photo (camera / uploaded inspection)
Rain forecast within RAIN_WAIT_DAYS postpones any cleaning. Pure function – no database access.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from .soiling import LOSS_THRESHOLD_PCT, RAIN_RESET_MM, RAIN_WAIT_DAYS

CLEAN_NOW_SCORE = 70
PLAN_SCORE = 40
CAMERA_MAX_AGE_DAYS = 14
HEAVY_SOILED_AREA_PCT = 30.0         # a photo with ≥ 30 % of the panel area soiled counts as fully dirty
CONFIDENCE_FACTOR = {"high": 1.0, "n/a": 1.0, "assumed": 0.6, "low": 0.5}

NOT_FIXED_BY_CLEANING = {
    "inverter_fault": "inverter fault", "inverter_dropout": "inverters not reporting", "clipping": "clipping/curtailment",
    "shading": "shading", "sensor_fault": "sensor fault", "overheating": "overheating", "data_gap": "missing data",
}
SOILING_LIKE = {"output_drop", "underperformance"}


def _ev(key, label, status, points, max_points, text):
    return {"key": key, "label": label, "status": status, "points": round(points, 1), "max": max_points, "text": text}


def performance_trend(index: list[tuple[date, float]]) -> dict | None:
    """index = [(day, actual/expected)] on clear days since the last reset."""
    vals = [v for _, v in index if v is not None]
    if len(vals) < 4:
        return None
    best = max(sorted(vals[i:i + 3])[1] for i in range(len(vals) - 2))   # best 3-day median
    recent = sorted(vals[-7:])[len(vals[-7:]) // 2]                        # median of the last 7 clear days
    drop = max(0.0, (best - recent) * 100)
    steps = [vals[i] - vals[i + 1] for i in range(len(vals) - 1)]
    sudden = drop > 1 and max(steps) * 100 > 0.6 * drop                    # most of the drop happened in one day
    return {"best_pct": round(best * 100, 1), "recent_pct": round(recent * 100, 1), "drop_pct": round(drop, 2), "sudden": sudden}


def decide(*, plan: dict, rate: dict, days_since_reset: int, as_of: date, trend: dict | None,
           anomalies: list[dict], camera: dict | None, forecast: list[dict], tariff: float) -> dict:
    evidence, side_actions = [], []
    rate_pct = rate["rate_pct_per_day"]
    loss = plan["loss_pct"]
    optimal = plan.get("optimal_interval_days")
    pay_loss = rate_pct * optimal if optimal else LOSS_THRESHOLD_PCT       # loss % at which cleaning pays off

    # 1. soiling estimate
    conf = rate.get("confidence", "assumed")
    pts = 40 * min(1.0, loss / pay_loss if pay_loss > 0 else 0) * CONFIDENCE_FACTOR.get(conf, 0.6)
    src = "assumed typical rate" if rate["source"] == "assumed" else f"measured, {conf} confidence"
    evidence.append(_ev("soiling", "Soiling estimate", "supports" if pts >= 10 else "neutral", pts, 40,
                        f"{rate_pct:.2f} %/day ({src}) × {days_since_reset} days since last clean → ≈ {loss:.1f} % loss "
                        f"(cleaning pays off at ≈ {pay_loss:.1f} %)."))
    available = 40

    # 2. performance trend
    if trend:
        p = 20 * min(1.0, trend["drop_pct"] / max(pay_loss, 3.0)) * (0.5 if trend["sudden"] else 1.0)
        txt = (f"Output vs expected fell from {trend['best_pct']:.1f} % to {trend['recent_pct']:.1f} % since the last clean"
               + (" – mostly in one day, which looks more like a fault than dust." if trend["sudden"] else
                  " – a gradual decline, typical of dust." if trend["drop_pct"] >= 1 else "."))
        evidence.append(_ev("performance", "Performance trend", "supports" if p >= 5 else "neutral", p, 20, txt))
        available += 20
    else:
        evidence.append(_ev("performance", "Performance trend", "missing", 0, 20,
                            "Not enough clear days since the last clean to see a trend."))

    # 3. anomalies (last 14 days of data, not resolved)
    soil_like = [a for a in anomalies if a["type"] in SOILING_LIKE]
    soil_days = {a["day"] for a in soil_like}
    other = [a for a in anomalies if a["type"] in NOT_FIXED_BY_CLEANING]
    other_kwh = sum(a.get("energy_lost_kwh") or 0 for a in other)
    soil_kwh = sum(a.get("energy_lost_kwh") or 0 for a in soil_like)
    a_pts = (10 if len(soil_days) >= 3 else 5 if len(soil_days) == 2 else 0)
    if other:
        share = other_kwh / (other_kwh + soil_kwh) if (other_kwh + soil_kwh) > 0 else 1.0
        a_pts -= 15 * share
    if not anomalies:
        evidence.append(_ev("anomalies", "Anomalies", "neutral", 0, 10, "No open anomalies in the last 14 days."))
    else:
        parts = []
        if soil_like:
            parts.append(f"{len(soil_days)} day(s) with unexplained output drops (≈ {soil_kwh:,.0f} kWh) – consistent with dust")
        if other:
            names = sorted({NOT_FIXED_BY_CLEANING[a['type']] for a in other})
            parts.append(f"≈ {other_kwh:,.0f} kWh lost to {', '.join(names)} – cleaning won't fix that, check it first")
        evidence.append(_ev("anomalies", "Anomalies", "supports" if a_pts > 0 else "against" if a_pts < 0 else "neutral",
                            a_pts, 10, "; ".join(parts) + "."))
    available += 10
    if any(a["type"] == "sensor_mismatch" for a in anomalies):
        side_actions.append("The irradiation sensor reads too low – clean or check it (cheap, and it makes the "
                            "soiling estimate more reliable).")

    # 4. camera / panel photo
    cam_ok = camera and (as_of - camera["taken_on"]).days <= CAMERA_MAX_AGE_DAYS and camera["taken_on"] <= as_of + timedelta(days=1)
    if cam_ok:
        c = 30 * min(1.0, camera["soiled_pct"] / HEAVY_SOILED_AREA_PCT)
        evidence.append(_ev("camera", "Panel photo", "supports" if c >= 8 else "neutral", c, 30,
                            f"Photo of {camera['taken_on']:%d %b}: {camera['soiled_pct']:.0f} % of the panel area soiled "
                            f"({camera.get('severity', '')})."))
        available += 30
    else:
        evidence.append(_ev("camera", "Panel photo", "missing", 0, 30,
                            "No recent camera image – decided from the data signals only." if not camera else
                            f"Latest photo ({camera['taken_on']:%d %b}) is too old to use."))

    points = sum(e["points"] for e in evidence)
    score = round(max(0.0, min(100.0, points / available * 100)))

    # 5. rain and decision
    rain = next((f for f in forecast[:RAIN_WAIT_DAYS] if f.get("rain_mm", 0) >= RAIN_RESET_MM), None)
    if rain:
        evidence.append(_ev("rain", "Rain forecast", "against", 0, 0,
                            f"{rain['rain_mm']:.0f} mm forecast on {rain['day']:%d %b} – it should wash the panels for free."))
    else:
        evidence.append(_ev("rain", "Rain forecast", "neutral", 0, 0,
                            "No heavy rain in the forecast window." if forecast else "No weather forecast (set the location)."))

    if rain and score >= PLAN_SCORE:
        action, due = "wait_rain", rain["day"]
        reason = f"Cleaning would be justified (score {score}), but rain is forecast on {rain['day']:%d %b}."
    elif score >= CLEAN_NOW_SCORE:
        action, due = "clean_now", as_of + timedelta(days=1)
        reason = f"Strong evidence of dirty panels (score {score}/100)."
    elif score >= PLAN_SCORE:
        wait = max(1, math.ceil(optimal - days_since_reset)) if optimal else 3
        action, due = "clean_in", as_of + timedelta(days=wait)
        reason = f"Moderate evidence (score {score}/100) – plan a cleaning; it pays off around {due:%d %b}."
    else:
        action, due = "not_needed", None
        reason = f"Little evidence of soiling (score {score}/100) – no cleaning needed for now."
    if other and action != "wait_rain":
        reason += " Part of the lost output comes from faults that cleaning won't fix."

    # economics in money, for the banner
    if plan.get("daily_loss_inr") and tariff and action != "not_needed":
        reason += f" Dirt currently costs ≈ ₹{plan['daily_loss_inr']:,.0f}/day."
    elif action == "not_needed" and rate.get("confidence") in ("low", "assumed") and loss >= 1:
        reason += " The soiling estimate is uncertain – a panel photo would settle it."
    return {"score": score, "action": action, "due": due.isoformat() if due else None, "reason": reason,
            "evidence": evidence, "side_actions": side_actions, "signals_used": available}
