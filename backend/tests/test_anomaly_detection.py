"""ML anomaly detection on synthetic plant data with injected faults.  Run:  .venv\\Scripts\\pytest -q"""
import pandas as pd

from app import anomaly_detection as ad
from app import forecasting as fc

from .test_forecasting import CAP, TZ, synthetic


def run(readings):
    usable = fc.usable_rows(readings, [])
    events, info = ad.detect(readings, usable, fc.healthy_rows(readings, usable), CAP, TZ, tariff_inr_per_kwh=3.0)
    return events, info


def window(readings, day_index, start_h, end_h):
    local = readings["ts"].dt.tz_convert(TZ)
    day = sorted(local.dt.date.unique())[day_index]
    t = local.dt.hour + local.dt.minute / 60
    return (local.dt.date == day) & (t >= start_h) & (t < end_h)


def hits(events, readings, mask):
    ts = readings.loc[mask, "ts"]
    return [e for e in events if ((ts >= pd.Timestamp(e["ts_start"])) & (ts < pd.Timestamp(e["ts_end"]))).any()]


def test_clean_plant_has_no_anomalies():
    readings, _ = synthetic(days=14)
    events, info = run(readings)
    assert info["method"] == "Gradient Boosting (out-of-fold)"
    assert events == []


def test_inverter_fault_is_found_and_diagnosed():
    readings, _ = synthetic(days=14)
    m = window(readings, 8, 10, 12)
    readings.loc[m, "ac_power_kw"] *= 0.8           # DC normal, AC low
    found = hits(run(readings)[0], readings, m)
    assert found and found[0]["type"] == "inverter_fault"
    e = found[0]
    assert e["energy_lost_kwh"] > 0 and e["details"]["acdc"] < e["details"]["acdc_normal"]
    assert e["details"]["revenue_lost_inr"] == round(e["energy_lost_kwh"] * 3.0)


def test_dirty_sunlight_sensor_is_a_sensor_mismatch():
    readings, _ = synthetic(days=14)
    m = window(readings, 6, 9, 12)
    readings.loc[m, "irradiation_kw_m2"] *= 0.7
    found = hits(run(readings)[0], readings, m)
    assert found and found[0]["type"] == "sensor_mismatch"


def test_repeating_morning_dip_is_shading():
    readings, _ = synthetic(days=14)
    m = pd.Series(False, index=readings.index)
    for d in (3, 4, 5, 6):
        w = window(readings, d, 8, 9.5)
        readings.loc[w, ["ac_power_kw", "dc_power_kw"]] *= 0.6
        m |= w
    found = hits(run(readings)[0], readings, m)
    assert len(found) >= 3 and all(e["type"] == "shading" for e in found)


def test_unusable_periods_are_skipped():
    """Periods already explained by rule alarms (e.g. inverter dropout) must not create ML anomalies."""
    readings, _ = synthetic(days=14)
    m = window(readings, 8, 10, 12)
    readings.loc[m, ["ac_power_kw", "dc_power_kw"]] *= 0.5
    start, end = readings.loc[m, "ts"].min(), readings.loc[m, "ts"].max() + pd.Timedelta(minutes=15)
    usable = fc.usable_rows(readings, [(start, end)])
    events, _ = ad.detect(readings, usable, fc.healthy_rows(readings, usable), CAP, TZ)
    assert hits(events, readings, m) == []
