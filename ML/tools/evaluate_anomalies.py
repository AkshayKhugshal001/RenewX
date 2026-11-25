"""Evaluate anomaly detection by injecting known faults into REAL plant data (no database needed).

The Kaggle data has no fault labels, so we copy the real readings, inject one fault at a known time, run the
detectors and check: was it found (detection rate)? was the cause right (diagnosis accuracy)? did new false
alarms appear elsewhere? Compared: rule-based alarm vs residual detector vs isolation forest vs combined.

Usage (from RenewX/):  backend/.venv/Scripts/python ML/tools/evaluate_anomalies.py [--plant 1] [--days-per-fault 3]
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
from app import analysis, anomaly_detection as ad, forecasting as fc  # noqa: E402
from app.cleaning import clean_csv  # noqa: E402

TZ = "Asia/Kolkata"
CAPACITY_KWP = 36000.0
TARIFF = 3.0
FILES = {1: "Plant_1_Master_Dataset.csv", 2: "Plant_2_Master_Dataset (1).csv"}


def window(df, day, start, end):
    local = df["ts"].dt.tz_convert(TZ)
    t = local.dt.hour + local.dt.minute / 60
    return (local.dt.date == day) & (t >= start) & (t < end)


# fault name -> (expected cause, function(df, days) -> mask of affected rows)
def inverter_fault(df, days):
    m = window(df, days[0], 10, 12)
    df.loc[m, "ac_power_kw"] *= 0.8                      # DC normal, AC low → inverter losing efficiency
    return m


def string_failure(df, days):
    m = window(df, days[0], 11, 14)
    df.loc[m, ["ac_power_kw", "dc_power_kw"]] *= 0.75   # part of the array disconnected
    return m


def overheating(df, days):
    m = window(df, days[0], 11, 14)
    df.loc[m, "module_temp_c"] += 15
    df.loc[m, ["ac_power_kw", "dc_power_kw"]] *= 1 - 0.004 * 15
    return m


def sensor_fault(df, days):
    m = window(df, days[0], 9, 12)
    df.loc[m, "irradiation_kw_m2"] *= 0.7               # dirty sensor under-reads sunlight
    return m


def shading(df, days):
    m = pd.Series(False, index=df.index)
    for d in days[:4]:
        w = window(df, d, 7.5, 9)
        df.loc[w, ["ac_power_kw", "dc_power_kw"]] *= 0.6
        m |= w
    return m


def curtailment(df, days):
    m = window(df, days[0], 10.5, 14.5)
    peak = df.loc[window(df, days[0], 0, 24), "ac_power_kw"].max()
    limit = 0.7 * peak
    over = m & (df["ac_power_kw"] > limit)
    ratio = df.loc[over, "dc_power_kw"] / df.loc[over, "ac_power_kw"]
    df.loc[over, "ac_power_kw"] = limit
    df.loc[over, "dc_power_kw"] = limit * ratio
    return over


FAULTS = {
    "inverter_fault": ("inverter_fault", inverter_fault),
    "string_failure": ("output_drop", string_failure),
    "overheating": ("overheating", overheating),
    "sensor_fault": ("sensor_mismatch", sensor_fault),
    "shading": ("shading", shading),
    "curtailment": ("clipping", curtailment),
}
METHODS = {"Rule-based": None, "Residual only": ("residual",), "Isolation Forest only": ("iforest",),
           "Combined (RenewX)": ("residual", "iforest")}


def load(plant: int) -> pd.DataFrame:
    res = clean_csv((ROOT / "ML" / "data" / FILES[plant]).read_bytes(), TZ)
    return res.readings.sort_values("ts").reset_index(drop=True)


def run_method(df, method):
    outages = [(pd.Timestamp(a["ts_start"]), pd.Timestamp(a["ts_end"]))
               for a in rule_alarms(df) if a["type"] in ("inverter_dropout", "sensor_fault")]
    usable = fc.usable_rows(df, outages)
    if METHODS[method] is None:
        return [{**a, "type": "underperformance"} for a in rule_alarms(df) if a["type"] == "underperformance"]
    events, _ = ad.detect(df, usable, fc.healthy_rows(df, usable), CAPACITY_KWP, TZ, TARIFF, METHODS[method])
    return events


def rule_alarms(df):
    strong = (df["irradiation_kw_m2"] >= 0.2) & (df["ac_power_kw"] > 0)
    ref = float((df.loc[strong, "ac_power_kw"] / df.loc[strong, "irradiation_kw_m2"]).median())
    plant = analysis.PlantInfo(CAPACITY_KWP, TARIFF, TZ)
    return analysis.detect_alarms(df, plant, ref, int(df["active_inverters"].max()))


def overlaps(e, mask, df):
    hit = df.loc[mask, "ts"]
    return bool(((hit >= pd.Timestamp(e["ts_start"])) & (hit < pd.Timestamp(e["ts_end"]))).any())


def same_time(a, b):
    return pd.Timestamp(a["ts_start"]) < pd.Timestamp(b["ts_end"]) and pd.Timestamp(b["ts_start"]) < pd.Timestamp(a["ts_end"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plant", type=int, default=1, choices=[1, 2])
    ap.add_argument("--days-per-fault", type=int, default=3)
    a = ap.parse_args()
    t0 = time.time()
    base = load(a.plant)
    all_days = sorted(base["ts"].dt.tz_convert(TZ).dt.date.unique())[1:-1]
    n_days = len(all_days) + 2
    rng = np.random.default_rng(7)

    background = {m: run_method(base, m) for m in METHODS}
    stats = {m: {"found": 0, "cause": 0, "new_false": 0, "trials": 0} for m in METHODS}
    per_fault = {f: {m: 0 for m in METHODS} for f in FAULTS}

    for fault, (cause, inject) in FAULTS.items():
        for _ in range(a.days_per_fault):
            start = int(rng.integers(0, len(all_days) - 4))
            days = all_days[start:start + 4]
            df = base.copy()
            df["quality_flags"] = df["quality_flags"].apply(list)
            mask = inject(df, days)
            for m in METHODS:
                events = run_method(df, m)
                hits = [e for e in events if overlaps(e, mask, df)]
                s = stats[m]
                s["trials"] += 1
                if hits:
                    s["found"] += 1
                    per_fault[fault][m] += 1
                    if m != "Rule-based" and any(e["type"] == cause for e in hits):
                        s["cause"] += 1
                # new false alarm: not the injected fault and not an event already present in the real data
                s["new_false"] += sum(1 for e in events if not overlaps(e, mask, df)
                                      and not any(same_time(e, b) for b in background[m]))

    print(f"\nPlant {a.plant}: {n_days} days of real data, {len(FAULTS)} fault types × {a.days_per_fault} "
          f"random days = {len(FAULTS) * a.days_per_fault} trials  ({time.time() - t0:.0f} s)\n")
    print(f"{'Method':24}{'Detected':>10}{'Cause right':>13}{'New false alarms':>18}{'Alarms on real data':>21}")
    for m, s in stats.items():
        det = s["found"] / s["trials"]
        cause = "n/a" if m == "Rule-based" else f"{s['cause'] / max(s['found'], 1):.0%}"
        print(f"{m:24}{det:>10.0%}{cause:>13}{s['new_false'] / s['trials']:>18.2f}"
              f"{len(background[m]) / n_days:>15.2f} /day")
    print(f"\n{'Detected per fault':24}" + "".join(f"{m.split(' ')[0]:>12}" for m in METHODS))
    for f, row in per_fault.items():
        print(f"{f:24}" + "".join(f"{row[m]}/{a.days_per_fault:<10}".rjust(12) for m in METHODS))
    print("\nEvents found in the original data (Combined):")
    for e in background["Combined (RenewX)"]:
        print(f"  {pd.Timestamp(e['ts_start']).tz_convert(TZ):%d %b %H:%M}  {e['type']:16} {e['severity']:7} "
              f"{e['energy_lost_kwh']:>8,.0f} kWh  {e['details']['detectors']}")


if __name__ == "__main__":
    main()
