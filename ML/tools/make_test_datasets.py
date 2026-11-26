"""Two-month TEST datasets for the team (SYNTHETIC plant data on REAL weather, with labelled faults).

  Dehradun plant = Kaggle Plant 1 behaviour at Dehradun (30.3165, 78.0322)
  Jaipur plant   = Kaggle Plant 2 behaviour at Jaipur   (26.9124, 75.7873)

Same method and CSV format as make_demo_csv.py (real Open-Meteo sunlight/temperature × each plant's 2020 output per
unit of sunlight, sensor noise, dust that builds up and is reset by rain or cleaning). On top, known faults are
injected at known times so testers can check that RenewX finds them. The ground truth is written to
<out>/fault_log.csv. Readings stop at the current time (no future data).

Usage (from RenewX/):  backend/.venv/Scripts/python ML/tools/make_test_datasets.py [--end 2026-11-26] [--days 61]
"""
from __future__ import annotations

import argparse
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_demo_csv as demo  # noqa: E402

OUT = demo.ROOT / "data" / "test"

# name -> (Kaggle profile, file prefix, dust %/day, cleanings: [(date, recorded?)], day offset for faults)
SITES = {
    "Dehradun": ("Plant_1", "RenewX_Dehradun_Plant", 0.4, [("2026-10-20", True), ("2026-11-12", False)], 0),
    "Jaipur": ("Plant_2", "RenewX_Jaipur_Plant", 0.6, [("2026-10-25", True), ("2026-11-15", False)], 2),
}

# (day number from the start, fault, local start hour, end hour, what RenewX should report)
FAULTS = [
    (6, "inverter_dropout", 10.0, 12.5, "Rule alarm: Inverter dropout (5 of 22 inverters offline)"),
    (12, "overheating", 11.0, 14.0, "ML anomaly: Overheating (modules +15 °C)"),
    (18, "shading", 7.5, 9.0, "ML anomaly: Shading – or Output drop – in the same morning window (4 days in a row)"),
    (25, "data_gap", 11.0, 13.0, "Rule alarm: Data gap (2 h of readings missing)"),
    (31, "inverter_fault", 10.0, 12.0, "ML anomaly: Inverter fault (AC 20 % low, DC normal)"),
    (38, "sensor_mismatch", 9.0, 12.0, "ML anomaly: Sensor mismatch (sunlight sensor reads 30 % low)"),
    (44, "string_failure", 11.0, 14.0, "ML anomaly: Output drop (25 % of the array disconnected)"),
    (48, "sensor_fault", 12.0, 13.5, "Rule alarm: Sensor fault (sunlight sensor reads 0 while producing)"),
    (53, "underperformance", 10.0, 13.0, "Rule alarm: Underperformance (output 40 % of normal)"),
    (57, "clipping", 10.5, 14.5, "ML anomaly: Clipping or Output drop (output capped at 70 % of the day's peak)"),
]


def window(df: pd.DataFrame, day: date, start_h: float, end_h: float) -> pd.Series:
    ts = pd.to_datetime(df["DATE_TIME"])
    t = ts.dt.hour + ts.dt.minute / 60
    return (ts.dt.date == day) & (t >= start_h) & (t < end_h)


def inject(df: pd.DataFrame, fault: str, day: date, s: float, e: float, inverters: int) -> pd.DataFrame:
    m = window(df, day, s, e)
    power = ["AC_POWER", "DC_POWER"]
    if fault == "inverter_dropout":
        off = 5
        df.loc[m, power] *= (inverters - off) / inverters
        df.loc[m, "active_inverters"] = inverters - off
    elif fault == "overheating":
        df.loc[m, "MODULE_TEMPERATURE"] += 15
        df.loc[m, power] *= 1 - demo.TEMP_COEF * 15
    elif fault == "shading":
        for k in range(4):
            mk = window(df, day + timedelta(days=k), s, e)
            df.loc[mk, power] *= 0.6
    elif fault == "data_gap":
        df = df[~m]
    elif fault == "inverter_fault":
        df.loc[m, "AC_POWER"] *= 0.8
    elif fault == "sensor_mismatch":
        df.loc[m, "IRRADIATION"] *= 0.7
    elif fault == "string_failure":
        df.loc[m, power] *= 0.75
    elif fault == "sensor_fault":
        df.loc[m, "IRRADIATION"] = 0.0
    elif fault == "underperformance":
        df.loc[m, power] *= 0.4
    elif fault == "clipping":
        limit = 0.7 * df.loc[window(df, day, 0, 24), "AC_POWER"].max()
        over = m & (df["AC_POWER"] > limit)
        ratio = df.loc[over, "DC_POWER"] / df.loc[over, "AC_POWER"]
        df.loc[over, "AC_POWER"] = limit
        df.loc[over, "DC_POWER"] = limit * ratio
    return df


def refresh_derived(df: pd.DataFrame, total_start: float) -> pd.DataFrame:
    """Recompute the columns that depend on power/temperature after faults were injected."""
    df = df.copy()
    # an occasional missing weather value from the API would leave a reading without power – fill short gaps
    cols = ["AC_POWER", "DC_POWER", "AMBIENT_TEMPERATURE", "MODULE_TEMPERATURE", "IRRADIATION"]
    df[cols] = df[cols].astype(float).interpolate(limit=2, limit_direction="both")
    energy = df["AC_POWER"].astype(float) * 0.25
    df["DAILY_YIELD"] = energy.groupby(df["date"]).cumsum().round(3)
    df["TOTAL_YIELD"] = (total_start + energy.cumsum()).round(1)
    for c in ["AC_POWER", "DC_POWER"]:
        df[c] = df[c].astype(float).round(3)
    df["module_ambient_temp_delta"] = (df["MODULE_TEMPERATURE"] - df["AMBIENT_TEMPERATURE"]).round(3)
    df["ac_dc_ratio"] = np.where(df["DC_POWER"] > 0, (df["AC_POWER"] / df["DC_POWER"]).round(4), np.nan)
    df["ac_power_per_irradiance"] = np.where(df["IRRADIATION"] > 0, (df["AC_POWER"] / df["IRRADIATION"]).round(2), np.nan)
    df["zero_generation"] = df["AC_POWER"] == 0
    return df


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--end", type=date.fromisoformat, default=date.today())
    ap.add_argument("--days", type=int, default=61)
    a = ap.parse_args()
    start = a.end - timedelta(days=a.days - 1)
    now_ist = pd.Timestamp.now(tz=demo.TZ).tz_localize(None)
    OUT.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(2026)
    log = []

    for site, (profile, prefix, dust, cleanings, offset) in SITES.items():
        cfg = demo.PLANTS[profile]
        clean_dates = [date.fromisoformat(d) for d, _ in cleanings]
        df = demo.build(profile, cfg, start, a.end, rng, dust, clean_dates)
        total_start = float(df["TOTAL_YIELD"].iloc[0]) - float(df["AC_POWER"].iloc[0]) * 0.25
        df["plant_id"] = f"{site}_Plant"

        for n, fault, s, e, expect in FAULTS:
            day = start + timedelta(days=n + offset)
            if day > a.end:
                continue
            df = inject(df, fault, day, s, e, cfg["inverters"])
            span = f"{day} – {day + timedelta(days=3)}" if fault == "shading" else str(day)
            log.append({"plant": f"{site}_Plant", "date": span, "local_time": f"{int(s):02d}:{int(s % 1 * 60):02d}–{int(e):02d}:{int(e % 1 * 60):02d}",
                        "fault": fault, "renewx_should_show": expect})
        for d, recorded in cleanings:
            log.append({"plant": f"{site}_Plant", "date": d, "local_time": "whole day", "fault": "cleaning",
                        "renewx_should_show": "Panels cleaned – add a DONE cleaning task on this date in Maintenance"
                        if recorded else "Unrecorded cleaning – Cleaning & Cooling should detect the jump by itself"})
        log.append({"plant": f"{site}_Plant", "date": f"{start} – {a.end}", "local_time": "", "fault": "soiling",
                    "renewx_should_show": f"Dust build-up ≈ {dust} %/day, reset by rain ≥ 5 mm/day and cleanings"})

        df = df[pd.to_datetime(df["DATE_TIME"]) <= now_ist]          # nothing from the future
        df = refresh_derived(df, total_start).reset_index(drop=True)
        last = pd.to_datetime(df["DATE_TIME"]).max()
        path = OUT / f"{prefix}_{start}_to_{last.date()}.csv"
        df.to_csv(path, index=False)
        daily = (df["AC_POWER"] * 0.25).groupby(df["date"]).sum() / 1000
        print(f"{path.name}: {len(df)} rows, {df['date'].nunique()} days, last reading {last}, "
              f"MWh/day median {daily.median():.1f} (min {daily.min():.1f}, max {daily.max():.1f})")

    pd.DataFrame(log).to_csv(OUT / "fault_log.csv", index=False)
    print(f"fault_log.csv: {len(log)} entries")


if __name__ == "__main__":
    main()
