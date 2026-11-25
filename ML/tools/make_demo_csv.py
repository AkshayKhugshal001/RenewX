"""Make demo CSVs for recent days (SYNTHETIC plant data on REAL weather).

The Kaggle data ends in June 2020, so live forecasting can't be shown with it. This script builds a CSV in the
same format as the master datasets for the last N days:
  * weather (sunlight, air temperature) = real Open-Meteo values for the plant's assumed location
  * power = each plant's own 2020 behaviour (median AC output per unit sunlight, temperature effect) + small noise
The output is clearly synthetic – say so in the report.

Usage (from RenewX/):  backend/.venv/Scripts/python ML/tools/make_demo_csv.py [--days 3] [--end 2026-11-24]
Soiling demo:  ... --days 25 --end 2026-11-25 --soiling 0.5 --clean-on 2026-11-12
  dust lowers output by 0.5 %/day; real rain (≥ 5 mm/day) and the cleaning date reset it.
  The sunlight sensor stays clean, so the loss is visible as actual < expected. After uploading, mark a cleaning
  task done on the --clean-on date in Maintenance so RenewX knows about the cleaning.
"""
from __future__ import annotations

import argparse
from datetime import date, timedelta
from pathlib import Path

import httpx
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
PLANTS = {
    "Plant_1": {"master": ROOT / "data" / "Plant_1_Master_Dataset.csv", "lat": 30.3165, "lon": 78.0322, "inverters": 22},
    "Plant_2": {"master": ROOT / "data" / "Plant_2_Master_Dataset (1).csv", "lat": 26.9124, "lon": 75.7873, "inverters": 22},
}
TZ = "Asia/Kolkata"
URL = "https://api.open-meteo.com/v1/forecast"
TEMP_COEF = 0.004  # output drop per °C of module temperature


def plant_profile(master: Path) -> dict:
    """Median AC kW per kW/m² of sunlight at 25 °C module temperature, + module heating per kW/m²."""
    df = pd.read_csv(master, usecols=["AC_POWER", "IRRADIATION", "MODULE_TEMPERATURE", "AMBIENT_TEMPERATURE", "TOTAL_YIELD"])
    sunny = df[(df["IRRADIATION"] > 0.3) & (df["AC_POWER"] > 0)]
    derate = 1 - TEMP_COEF * (sunny["MODULE_TEMPERATURE"] - 25)
    k = float((sunny["AC_POWER"] / (sunny["IRRADIATION"] * derate)).median())
    heat = float(((sunny["MODULE_TEMPERATURE"] - sunny["AMBIENT_TEMPERATURE"]) / sunny["IRRADIATION"]).median())
    return {"k": k, "heat": heat, "total_yield": float(df["TOTAL_YIELD"].max())}


def weather(lat: float, lon: float, start: date, end: date) -> pd.DataFrame:
    params = {"latitude": lat, "longitude": lon, "timezone": TZ, "start_date": start.isoformat(), "end_date": end.isoformat(),
              "minutely_15": "shortwave_radiation,temperature_2m,precipitation"}
    r = httpx.get(URL, params=params, timeout=30)
    r.raise_for_status()
    m = r.json()["minutely_15"]
    # values are averages of the preceding 15 minutes, labelled by the end -> shift to the start like the Kaggle data
    ts = pd.to_datetime(m["time"]) - pd.Timedelta(minutes=15)
    return pd.DataFrame({"ts": ts, "ghi": np.array(m["shortwave_radiation"], dtype=float) / 1000,
                         "amb": np.array(m["temperature_2m"], dtype=float),
                         "rain": np.array([x or 0 for x in m["precipitation"]], dtype=float)})


def soiling_factor(w: pd.DataFrame, rate_pct: float, clean_on: list[date]) -> pd.Series:
    """1 − dust loss per reading: grows by rate_pct per day, reset by ≥ 5 mm rain/day or a cleaning."""
    day = w["ts"].dt.date
    rain = w.groupby(day)["rain"].sum()
    factor, since = {}, 0
    for i, d in enumerate(sorted(rain.index)):
        since = 0 if (i == 0 or rain[d] >= 5 or d in clean_on) else since + 1
        factor[d] = 1 - min(0.25, rate_pct / 100 * since)
    return day.map(factor)


def build(name: str, cfg: dict, start: date, end: date, rng: np.random.Generator,
          soiling_pct: float = 0.0, clean_on: list[date] | None = None) -> pd.DataFrame:
    prof = plant_profile(cfg["master"])
    w = weather(cfg["lat"], cfg["lon"], start, end + timedelta(days=1))  # +1: last slot is labelled 00:00 next day
    w = w[(w["ts"].dt.date >= start) & (w["ts"].dt.date <= end)].reset_index(drop=True)
    g = w["ghi"].clip(lower=0).fillna(0)
    sensor_g = (g * rng.normal(1, 0.02, len(g))).clip(lower=0)               # irradiation sensor noise
    module = w["amb"] + prof["heat"] * g + rng.normal(0, 0.5, len(g))
    ac = prof["k"] * g * (1 - TEMP_COEF * (module - 25)) * rng.normal(1, 0.03, len(g))
    ac = ac.where(g > 0.005, 0).clip(lower=0)
    if soiling_pct:
        ac = ac * soiling_factor(w, soiling_pct, clean_on or [])
    dc = ac / 0.975
    day = w["ts"].dt.date
    daily_yield = (ac * 0.25).groupby(day).cumsum()
    total = prof["total_yield"] + (ac * 0.25).cumsum()
    out = pd.DataFrame({
        "plant_id": name,
        "DATE_TIME": w["ts"].dt.strftime("%Y-%m-%d %H:%M:%S"),
        "DC_POWER": dc.round(3), "AC_POWER": ac.round(3),
        "DAILY_YIELD": daily_yield.round(3), "TOTAL_YIELD": total.round(1),
        "active_inverters": cfg["inverters"],
        "AMBIENT_TEMPERATURE": w["amb"].round(3), "MODULE_TEMPERATURE": module.round(3),
        "IRRADIATION": sensor_g.round(5),
    })
    out["module_ambient_temp_delta"] = (out["MODULE_TEMPERATURE"] - out["AMBIENT_TEMPERATURE"]).round(3)
    out["ac_dc_ratio"] = np.where(out["DC_POWER"] > 0, (out["AC_POWER"] / out["DC_POWER"]).round(4), np.nan)
    out["ac_power_per_irradiance"] = np.where(out["IRRADIATION"] > 0, (out["AC_POWER"] / out["IRRADIATION"]).round(2), np.nan)
    out["missing_weather"] = False
    out["zero_generation"] = out["AC_POWER"] == 0
    out["date"] = w["ts"].dt.strftime("%Y-%m-%d")
    out["hour"], out["minute"], out["day_of_week"] = w["ts"].dt.hour, w["ts"].dt.minute, w["ts"].dt.dayofweek
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=3)
    ap.add_argument("--end", type=date.fromisoformat, default=date.today() - timedelta(days=1))
    ap.add_argument("--soiling", type=float, default=0.0, help="dust loss in %% per day (e.g. 0.5)")
    ap.add_argument("--clean-on", type=date.fromisoformat, action="append", default=[], help="cleaning date(s)")
    a = ap.parse_args()
    start = a.end - timedelta(days=a.days - 1)
    out_dir = ROOT / "data" / "recent"
    out_dir.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(42)
    for name, cfg in PLANTS.items():
        df = build(name, cfg, start, a.end, rng, a.soiling, a.clean_on)
        path = out_dir / f"{name}_{start}_to_{a.end}.csv"
        df.to_csv(path, index=False)
        daily = (df["AC_POWER"].astype(float) * 0.25).groupby(df["date"]).sum() / 1000
        print(f"{path.name}: {len(df)} rows, MWh/day {daily.round(1).to_dict()}, "
              f"peak sun {df['IRRADIATION'].max():.2f} kW/m²")


if __name__ == "__main__":
    main()
