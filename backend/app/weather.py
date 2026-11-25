"""Hourly weather from Open-Meteo (free, no API key).

* Archive API  – recorded (reanalysis) weather, available with a delay of a few days.
* Forecast API – recent days and up to 16 days ahead.
Times are requested in UTC. Each hourly value is the average of the PRECEDING hour
(e.g. 10:00 = 09:00–10:00), which is how plant readings are grouped too.
"""
from __future__ import annotations

from datetime import date, timedelta

import httpx
import pandas as pd

ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_DELAY_DAYS = 6      # archive data is complete up to about this many days ago
MAX_FORECAST_DAYS = 15

VARIABLES = {  # Open-Meteo name -> weather_data column
    "shortwave_radiation": "ghi_w_m2",
    "temperature_2m": "temp_c",
    "cloud_cover": "cloud_cover_pct",
    "precipitation": "precipitation_mm",
    "relative_humidity_2m": "humidity_pct",
    "wind_speed_10m": "wind_speed_ms",
}
COLUMNS = list(VARIABLES.values())


class WeatherError(Exception):
    """Weather service unreachable or returned an error."""


def _get(url: str, lat: float, lon: float, start: date, end: date) -> pd.DataFrame:
    params = {
        "latitude": lat, "longitude": lon, "hourly": ",".join(VARIABLES), "timezone": "GMT",
        "wind_speed_unit": "ms", "start_date": start.isoformat(), "end_date": end.isoformat(),
    }
    try:
        res = httpx.get(url, params=params, timeout=30)
    except httpx.HTTPError as e:
        raise WeatherError(f"Could not reach the weather service ({e.__class__.__name__}).")
    if res.status_code != 200:
        reason = res.json().get("reason", res.text[:200]) if res.headers.get("content-type", "").startswith("application/json") else res.text[:200]
        raise WeatherError(f"Weather service error: {reason}")
    hourly = res.json().get("hourly", {})
    df = pd.DataFrame({VARIABLES.get(k, k): v for k, v in hourly.items()})
    if df.empty:
        return pd.DataFrame(columns=["ts", *COLUMNS])
    df["ts"] = pd.to_datetime(df.pop("time"), utc=True)
    return df[["ts", *COLUMNS]]


def fetch_hourly(lat: float, lon: float, start: date, end: date, today: date) -> pd.DataFrame:
    """Hourly weather (UTC) for whole UTC days start..end, choosing archive or forecast API per period."""
    end = min(end, today + timedelta(days=MAX_FORECAST_DAYS))
    if start > end:
        return pd.DataFrame(columns=["ts", *COLUMNS])
    cutoff = today - timedelta(days=ARCHIVE_DELAY_DAYS)
    parts = []
    if start <= cutoff:
        parts.append(_get(ARCHIVE_URL, lat, lon, start, min(end, cutoff)))
    if end > cutoff:
        parts.append(_get(FORECAST_URL, lat, lon, max(start, cutoff + timedelta(days=1)), end))
    df = pd.concat(parts, ignore_index=True).drop_duplicates("ts", keep="last")
    return df.dropna(subset=["ghi_w_m2", "temp_c"], how="all").sort_values("ts").reset_index(drop=True)
