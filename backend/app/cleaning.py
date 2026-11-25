"""Turn an uploaded CSV into clean, plant-level readings (one row per timestamp).

Accepts:
  * the RenewX "master" format (plant totals + weather columns), and
  * raw per-inverter files like the Kaggle generation data (rows are summed per timestamp).
Column names are matched case-insensitively against ALIASES.
"""
from __future__ import annotations

import io
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

POWER_COLS = ["dc_power_kw", "ac_power_kw"]
YIELD_COLS = ["daily_yield_kwh", "total_yield_kwh"]
WEATHER_COLS = ["ambient_temp_c", "module_temp_c", "irradiation_kw_m2"]
READING_COLS = POWER_COLS + YIELD_COLS + ["active_inverters"] + WEATHER_COLS

# target column -> accepted CSV header names (after normalising: lowercase, non-alphanumerics -> "_")
ALIASES: dict[str, list[str]] = {
    "ts": ["date_time", "datetime", "timestamp", "time_stamp", "date_and_time", "ts"],
    "source_key": ["source_key", "inverter_id", "inverter_key", "inverter"],
    "dc_power_kw": ["dc_power", "dc_power_kw", "dc_kw"],
    "ac_power_kw": ["ac_power", "ac_power_kw", "ac_kw"],
    "daily_yield_kwh": ["daily_yield", "daily_yield_kwh"],
    "total_yield_kwh": ["total_yield", "total_yield_kwh"],
    "active_inverters": ["active_inverters", "inverters_active", "inverter_count"],
    "ambient_temp_c": ["ambient_temperature", "ambient_temp", "ambient_temp_c"],
    "module_temp_c": ["module_temperature", "module_temp", "module_temp_c"],
    "irradiation_kw_m2": ["irradiation", "irradiance", "irradiation_kw_m2", "irradiance_kw_m2", "irradiance_w_m2", "ghi"],
}

TS_FORMATS = [
    "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M",
    "%d-%m-%Y %H:%M", "%d-%m-%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y %H:%M:%S",
    "%Y/%m/%d %H:%M:%S", "%Y/%m/%d %H:%M",
]

# Values outside these ranges are treated as sensor errors (set to missing)
SENSOR_LIMITS = {"ambient_temp_c": (-30, 60), "module_temp_c": (-30, 100), "irradiation_kw_m2": (0, 1.6)}


class CsvError(ValueError):
    """A problem with the file that the user has to fix. The message is shown in the UI."""


@dataclass
class CleanResult:
    readings: pd.DataFrame          # columns: ts (UTC) + READING_COLS + quality_flags (list[str])
    rows_total: int
    rows_rejected: int
    interval_minutes: float
    column_mapping: dict[str, str]
    timestamp_format: str
    per_inverter: bool
    warnings: list[str] = field(default_factory=list)
    fixes: list[str] = field(default_factory=list)


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(name).strip().lower()).strip("_")


def _read(data: bytes) -> pd.DataFrame:
    if not data.strip():
        raise CsvError("The file is empty.")
    for encoding in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(io.BytesIO(data), dtype=str, encoding=encoding, skipinitialspace=True)
        except UnicodeDecodeError:
            continue
        except pd.errors.EmptyDataError:
            raise CsvError("The file has no rows.")
        except pd.errors.ParserError as e:
            raise CsvError(f"This doesn't look like a valid CSV file ({e}).")
    raise CsvError("Could not read the file. Save it as a UTF-8 CSV and try again.")


def _map_columns(df: pd.DataFrame) -> dict[str, str]:
    by_norm: dict[str, str] = {}
    for col in df.columns:
        by_norm.setdefault(_norm(col), col)
    mapping = {}
    for target, names in ALIASES.items():
        for n in names:
            if n in by_norm:
                mapping[target] = by_norm[n]
                break
    if "ts" not in mapping:
        raise CsvError("No timestamp column found. Name it DATE_TIME (or timestamp / datetime).")
    if "ac_power_kw" not in mapping:
        raise CsvError("No AC power column found. Name it AC_POWER (values in kW).")
    return mapping


def _parse_timestamps(text: pd.Series, timezone: str) -> tuple[pd.Series, str]:
    """Pick the format that parses the most rows; naive times are in the plant's timezone. Returns UTC."""
    s = text.astype("string").str.strip()
    present = int(s.notna().sum())
    best, best_fmt, best_n = None, "", -1
    for fmt in TS_FORMATS:
        parsed = pd.to_datetime(s, format=fmt, errors="coerce")
        n = int(parsed.notna().sum())
        if n > best_n:
            best, best_fmt, best_n = parsed, fmt, n
        if n == present:
            break

    if best_n < 0.9 * present:
        # e.g. "2020-05-15T06:00:00+05:30" – timestamps that carry their own timezone
        aware = pd.to_datetime(s, format="ISO8601", errors="coerce", utc=True)
        if int(aware.notna().sum()) > best_n:
            return aware.dt.floor("min"), "ISO 8601 (with timezone)"

    local = best.dt.tz_localize(timezone, ambiguous="NaT", nonexistent="NaT")
    return local.dt.tz_convert("UTC").dt.floor("min"), best_fmt


def clean_csv(data: bytes, timezone: str) -> CleanResult:
    raw = _read(data)
    rows_total = len(raw)
    if rows_total == 0:
        raise CsvError("The file has a header row but no data.")
    mapping = _map_columns(raw)
    warnings: list[str] = []
    fixes: list[str] = []

    # ── 1. timestamps + numbers ──────────────────────────────
    df = pd.DataFrame(index=raw.index)
    df["ts"], ts_format = _parse_timestamps(raw[mapping["ts"]], timezone)

    non_numeric = 0
    for col in READING_COLS:
        if col in mapping:
            text = raw[mapping[col]]
            values = pd.to_numeric(text, errors="coerce")
            non_numeric += int((values.isna() & text.notna() & (text.str.strip() != "")).sum())
            df[col] = values
        else:
            df[col] = np.nan
    if "source_key" in mapping:
        df["source_key"] = raw[mapping["source_key"]].str.strip()

    bad_ts = df["ts"].isna()
    no_ac = df["ac_power_kw"].isna() & ~bad_ts
    rows_rejected = int(bad_ts.sum() + no_ac.sum())
    if bad_ts.any():
        warnings.append(f"{int(bad_ts.sum())} row(s) had an unreadable timestamp and were skipped.")
    if no_ac.any():
        warnings.append(f"{int(no_ac.sum())} row(s) had no AC power value and were skipped.")
    if non_numeric:
        warnings.append(f"{non_numeric} cell(s) were not numbers and were treated as missing.")
    df = df[~bad_ts & ~no_ac]
    if df.empty:
        raise CsvError("No usable rows: every row is missing a valid timestamp or AC power value.")

    # ── 2. one row per timestamp ─────────────────────────────
    per_inverter = "source_key" in df and df["ts"].duplicated().any() and df["source_key"].nunique() > 1
    if per_inverter:
        before = len(df)
        inverters = df["source_key"].nunique()
        df = df.drop_duplicates(["ts", "source_key"], keep="last")
        g = df.groupby("ts")
        out = g[POWER_COLS + YIELD_COLS].sum(min_count=1)
        out[WEATHER_COLS] = g[WEATHER_COLS].mean()
        out["active_inverters"] = g["source_key"].nunique()
        df = out.reset_index()
        fixes.append(f"Combined {before:,} rows from {inverters} inverters into {len(df):,} plant-level readings.")
    else:
        dup = df["ts"].duplicated(keep="last")
        if dup.any():
            warnings.append(f"{int(dup.sum())} duplicate timestamp(s) in the file; the last value was kept.")
            df = df[~dup]
        df = df.drop(columns="source_key", errors="ignore")

    df = df.sort_values("ts").reset_index(drop=True)
    flags: dict[str, pd.Series] = {}

    # ── 3. units ─────────────────────────────────────────────
    if df["irradiation_kw_m2"].max(skipna=True) > 2:
        df["irradiation_kw_m2"] = df["irradiation_kw_m2"] / 1000
        fixes.append("Irradiation looked like W/m², so it was converted to kW/m².")

    ac, dc = df["ac_power_kw"], df["dc_power_kw"]
    daytime = (ac > 0) & (dc > 0) & (ac > 0.05 * ac.max())
    if daytime.sum() >= 10:
        ratio = float((ac[daytime] / dc[daytime]).median())
        if 0.07 <= ratio <= 0.13:
            df["dc_power_kw"] = dc / 10
            fixes.append(
                f"DC power was about 10× AC power (median AC/DC ratio {ratio:.3f}), "
                "a known unit error in this data, so DC values were divided by 10."
            )
        elif ratio < 0.5 or ratio > 1.05:
            warnings.append(f"Unusual AC/DC ratio ({ratio:.2f}). Please check the DC and AC power units.")

    # ── 4. invalid values ────────────────────────────────────
    negative = df[POWER_COLS] < 0
    if negative.values.any():
        df[POWER_COLS] = df[POWER_COLS].clip(lower=0)
        flags["negative_power_clipped"] = negative.any(axis=1)

    df["irradiation_kw_m2"] = df["irradiation_kw_m2"].mask(df["irradiation_kw_m2"].between(-0.01, 0), 0.0)
    out_of_range = pd.Series(False, index=df.index)
    for col, (lo, hi) in SENSOR_LIMITS.items():
        bad = df[col].notna() & ((df[col] < lo) | (df[col] > hi))
        df.loc[bad, col] = np.nan
        out_of_range |= bad
    if out_of_range.any():
        flags["sensor_out_of_range"] = out_of_range
        warnings.append(f"{int(out_of_range.sum())} reading(s) had impossible weather values, which were removed.")

    dc = df["dc_power_kw"]
    ac_above_dc = (dc > 0) & (df["ac_power_kw"] > dc * 1.02) & (df["ac_power_kw"] > 1)
    if ac_above_dc.any():
        flags["ac_above_dc"] = ac_above_dc

    # ── 5. data-quality flags ────────────────────────────────
    has_weather = any(c in mapping for c in WEATHER_COLS)
    if has_weather:
        missing_weather = df[WEATHER_COLS].isna().all(axis=1)
        if missing_weather.any():
            flags["missing_weather"] = missing_weather
    else:
        warnings.append(
            "No weather columns (IRRADIATION, MODULE_TEMPERATURE, AMBIENT_TEMPERATURE) were found. "
            "Performance ratio and loss analysis need them."
        )

    inv = df["active_inverters"]
    if inv.notna().any():
        flags["low_inverters"] = inv < 0.8 * inv.max()

    names = list(flags)
    if names:
        matrix = pd.DataFrame(flags).fillna(False).to_numpy()
        df["quality_flags"] = [[n for n, on in zip(names, row) if on] for row in matrix]
    else:
        df["quality_flags"] = [[] for _ in range(len(df))]

    # ── 6. reading interval ──────────────────────────────────
    gaps = df["ts"].diff().dt.total_seconds().div(60)
    gaps = gaps[gaps > 0]
    interval = float(gaps.median()) if len(gaps) else 15.0
    if not 1 <= interval <= 60:
        warnings.append(f"Readings are {interval:.0f} minutes apart; 15-minute data is expected.")

    return CleanResult(
        readings=df[["ts", *READING_COLS, "quality_flags"]],
        rows_total=rows_total,
        rows_rejected=rows_rejected,
        interval_minutes=interval,
        column_mapping={k: v for k, v in mapping.items()},
        timestamp_format=ts_format,
        per_inverter=bool(per_inverter),
        warnings=warnings,
        fixes=fixes,
    )
