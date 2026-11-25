"""Soiling / cleaning / cooling logic on synthetic data with a known dust rate.  Run:  .venv\\Scripts\\pytest -q"""
from datetime import date, timedelta

import numpy as np
import pandas as pd

from app import soiling

START = date(2026, 10, 1)


def daily(n=30, rate_pct=0.5, rain_on=(14,), seed=1, sunny=True):
    """Expected energy 100 MWh/day; actual drops by `rate_pct` %/day and recovers on rain days."""
    rng = np.random.default_rng(seed)
    days = [START + timedelta(days=i) for i in range(n)]
    since, idx = 0, []
    for i in range(n):
        since = 0 if (i == 0 or i in rain_on) else since + 1
        idx.append(1 - rate_pct / 100 * since + rng.normal(0, 0.003))
    df = pd.DataFrame({"day": days, "expected_energy_kwh": 100000.0, "insolation_kwh_m2": 6.0 if sunny else 2.0,
                       "availability_pct": 100.0})
    df["energy_kwh"] = df["expected_energy_kwh"] * np.array(idx)
    rain = {days[i]: 12.0 for i in rain_on}
    return df, rain


def test_measures_the_soiling_rate_between_rain_events():
    df, rain = daily(rate_pct=0.5)
    resets = soiling.reset_days(list(df["day"]), rain, [])
    rate = soiling.soiling_rate(df, resets)
    assert rate["source"] == "measured" and rate["stretches"] == 2
    assert abs(rate["rate_pct_per_day"] - 0.5) < 0.1


def test_falls_back_to_the_assumed_rate_without_enough_clear_days():
    df, rain = daily(n=6, rain_on=())
    rate = soiling.soiling_rate(df, soiling.reset_days(list(df["day"]), rain, []))
    assert rate["source"] == "assumed" and rate["rate_pct_per_day"] == soiling.DEFAULT_RATE_PCT


def test_cleaning_and_long_gaps_reset_the_loss():
    days = [START, START + timedelta(days=1), START + timedelta(days=2), START + timedelta(days=40), START + timedelta(days=41)]
    resets = soiling.reset_days(days, {}, [START + timedelta(days=2)])
    assert resets[days[2]] == "cleaning" and resets[days[3]] == "gap"
    assert soiling.modelled_loss(days, resets, 0.5) == [0, 0.5, 0, 0, 0.5]
    assert soiling.last_reset(days, resets, days[-1]) == (days[3], "gap")


def plan(**kw):
    args = dict(rate_pct=0.5, days_since_reset=10, as_of=START, energy_kwh_day=100000, tariff=3.0,
                cleaning_cost_inr=216000, forecast=[])
    return soiling.cleaning_plan(**{**args, **kw})


def test_cleaning_decision():
    # optimal interval = sqrt(2·216000 / (0.005·100000·3)) = 16.97 days
    p = plan(days_since_reset=10)
    assert p["optimal_interval_days"] == 17.0 and p["action"] == "clean_in" and p["due"] == "2026-10-08"
    assert plan(days_since_reset=20)["action"] == "clean_now"
    rain = [{"day": START + timedelta(days=2), "energy_kwh": 90000, "rain_mm": 9.0}]
    assert plan(days_since_reset=20, forecast=rain)["action"] == "wait_rain"   # free cleaning in 2 days
    assert plan(rate_pct=0.0)["action"] == "not_needed"
    p = plan(tariff=0, days_since_reset=12)                                     # no economics → 5 % rule
    assert p["action"] == "clean_now" and p["optimal_interval_days"] is None


def test_cooling_is_not_worth_it_when_modules_stay_cool():
    ts = pd.date_range("2026-10-01 06:00", periods=48, freq="15min", tz="Asia/Kolkata").tz_convert("UTC")
    r = pd.DataFrame({"ts": ts, "ac_power_kw": 20000.0, "module_temp_c": 38.0, "ambient_temp_c": 28.0})
    assert soiling.cooling_analysis(r, 36, 3.0, "Asia/Kolkata", 0.25)["verdict"] == "not_needed"
    hot = r.assign(module_temp_c=60.0)
    c = soiling.cooling_analysis(hot, 36, 3.0, "Asia/Kolkata", 0.25)
    assert c["hot_hours_per_day"] == 12 and c["gain_kwh_per_day"] > 0 and c["verdict"] in ("recommended", "not_worth_it")


# ── cleaning decision (all signals combined) ─────────────────────────────
from app import cleaning_decision as cd  # noqa: E402


def decide(**kw):
    p = plan(days_since_reset=kw.pop("days", 14))
    args = dict(plan=p, rate={"rate_pct_per_day": 0.5, "source": "measured", "confidence": "high"},
                days_since_reset=14, as_of=START, trend=None, anomalies=[], camera=None, forecast=[], tariff=3.0)
    return cd.decide(**{**args, **kw})


def test_decision_works_without_a_camera_image():
    d = decide()
    cam = next(e for e in d["evidence"] if e["key"] == "camera")
    assert cam["status"] == "missing" and d["signals_used"] == 50   # rescaled over soiling + anomalies (no trend given)
    assert d["action"] in ("clean_now", "clean_in") and 0 <= d["score"] <= 100


def test_faults_that_cleaning_cannot_fix_lower_the_score():
    base = decide()["score"]
    fault = decide(anomalies=[{"type": "inverter_fault", "energy_lost_kwh": 5000, "day": START}])
    assert fault["score"] < base and "won't fix" in fault["reason"]
    ev = next(e for e in fault["evidence"] if e["key"] == "anomalies")
    assert ev["status"] == "against"
    sensor = decide(anomalies=[{"type": "sensor_mismatch", "energy_lost_kwh": 0, "day": START}])
    assert sensor["side_actions"]                                     # clean the irradiance sensor


def test_dirty_photo_raises_the_score_and_rain_postpones():
    dirty = decide(days=6, camera={"taken_on": START, "soiled_pct": 40, "severity": "heavy"})
    assert dirty["score"] > decide(days=6)["score"] and dirty["signals_used"] == 80
    rain = [{"day": START + timedelta(days=1), "energy_kwh": 90000, "rain_mm": 8.0}]
    assert decide(days=20, forecast=rain)["action"] == "wait_rain"


def test_performance_trend_tells_gradual_from_sudden():
    days = [START + timedelta(days=i) for i in range(10)]
    gradual = cd.performance_trend([(d, 1 - 0.005 * i) for i, d in enumerate(days)])
    sudden = cd.performance_trend([(d, 1.0 if i < 6 else 0.94) for i, d in enumerate(days)])
    assert gradual["drop_pct"] > 2 and not gradual["sudden"]
    assert sudden["sudden"]


def test_unrecorded_cleaning_is_detected_as_a_jump():
    df, _ = daily(rate_pct=0.6, rain_on=(15,))          # a cleaning on day 15 that nobody recorded
    jumps = soiling.detect_jumps(df, {})
    assert list(jumps) == [df["day"][15]]
    assert soiling.detect_jumps(df, {df["day"][15]: "cleaning"}) == {}   # already known → not reported twice
