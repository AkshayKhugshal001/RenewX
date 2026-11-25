"""Daily statistics and rule-based alarms calculated from plant readings (no ML yet).

All functions are pure (DataFrame in, dicts out) so they are easy to test.
Power is in kW, energy in kWh, irradiation in kW/m², so insolation (kWh/m²) = Σ irradiation × hours.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import pandas as pd

DAYLIGHT_KW_M2 = 0.05          # enough sun that the plant should be producing
STRONG_SUN_KW_M2 = 0.2         # sunlight level used to judge performance
UNDERPERFORMANCE_LIMIT = 0.6   # output below 60 % of the plant's normal output for that sunlight
MIN_UNDERPERFORMANCE_MIN = 60  # ...for at least one hour
GAP_MIN = 60                   # missing data for more than one hour
TEMP_COEFF_PER_C = 0.004       # typical crystalline-silicon power loss per °C above 25 °C
STC_TEMP_C = 25.0
CO2_KG_PER_KWH = 0.71          # approx. Indian grid emission factor (CEA CO2 baseline); configurable later


@dataclass
class PlantInfo:
    capacity_kwp: float
    tariff_inr_per_kwh: float
    timezone: str


def interval_hours(ts: pd.Series) -> float:
    """Typical gap between readings in hours (15-minute data -> 0.25)."""
    diffs = ts.sort_values().diff().dt.total_seconds().dropna()
    diffs = diffs[diffs > 0]
    minutes = diffs.median() / 60 if len(diffs) else 15.0
    return float(min(max(minutes, 1.0), 60.0)) / 60


def _num(x) -> float | None:
    """NaN/inf -> None so it is stored as NULL."""
    if x is None:
        return None
    x = float(x)
    return None if math.isnan(x) or math.isinf(x) else x


def _sun_up(df: pd.DataFrame) -> pd.Series:
    """Daylight rows: by irradiation when available, otherwise 'the plant is producing'."""
    irr = df["irradiation_kw_m2"]
    return (irr >= DAYLIGHT_KW_M2).where(irr.notna(), df["ac_power_kw"] > 0).astype(bool)


# ─────────────────────────────────────────────────────────────
# Daily summaries
# ─────────────────────────────────────────────────────────────
def daily_summaries(readings: pd.DataFrame, plant: PlantInfo, alarm_counts: dict[date, int]) -> list[dict]:
    if readings.empty:
        return []
    step_h = interval_hours(readings["ts"])
    expected_rows = 24 / step_h
    df = readings.copy()
    df["day"] = df["ts"].dt.tz_convert(plant.timezone).dt.date
    cap = plant.capacity_kwp

    rows = []
    for day, g in df.groupby("day"):
        ac, dc, irr, mod = g["ac_power_kw"], g["dc_power_kw"], g["irradiation_kw_m2"], g["module_temp_c"]
        sun = _sun_up(g)

        energy = ac.fillna(0).sum() * step_h
        both = ac.notna() & dc.notna() & (dc > 0)
        ac_both, dc_both = ac[both].sum(), dc[both].sum()
        insolation = irr.fillna(0).sum() * step_h if irr.notna().any() else None

        # energy the panels would have produced at 25 °C, minus what they actually produced
        heat_loss = ((mod - STC_TEMP_C).clip(lower=0) * TEMP_COEFF_PER_C).clip(upper=0.5)
        thermal = (ac * heat_loss / (1 - heat_loss)).fillna(0).sum() * step_h if mod.notna().any() else None

        rows.append({
            "day": day,
            "energy_kwh": _num(energy),
            "dc_energy_kwh": _num(dc.fillna(0).sum() * step_h) if dc.notna().any() else None,
            "peak_ac_kw": _num(ac.max()),
            "insolation_kwh_m2": _num(insolation),
            "specific_yield_kwh_kwp": _num(energy / cap) if cap > 0 else None,
            "performance_ratio": _num(energy / (insolation * cap)) if cap > 0 and insolation else None,
            "availability_pct": _num(100 * (ac[sun] > 0).mean()) if sun.any() else None,
            "inverter_eff_pct": _num(100 * ac_both / dc_both) if dc_both > 0 else None,
            "avg_ambient_temp_c": _num(g["ambient_temp_c"].mean()),
            "avg_module_temp_c": _num(mod[sun].mean() if sun.any() else mod.mean()),
            "max_module_temp_c": _num(mod.max()),
            "thermal_loss_kwh": _num(thermal),
            "inverter_loss_kwh": _num(max(0.0, (dc_both - ac_both) * step_h)) if dc_both > 0 else None,
            "revenue_inr": _num(energy * plant.tariff_inr_per_kwh),
            "co2_avoided_kg": _num(energy * CO2_KG_PER_KWH),
            "readings_count": int(len(g)),
            "data_completeness_pct": _num(min(100.0, 100 * len(g) / expected_rows)),
            "alarm_count": int(alarm_counts.get(day, 0)),
        })
    return rows


# ─────────────────────────────────────────────────────────────
# Rule-based alarms
# ─────────────────────────────────────────────────────────────
def _runs(mask: pd.Series, ts: pd.Series, step_min: float) -> list[list[int]]:
    """Positions of consecutive True rows (next reading at most 1.5 intervals later)."""
    runs: list[list[int]] = []
    current: list[int] = []
    prev = None
    for i, (on, t) in enumerate(zip(mask.to_numpy(), ts)):
        if on and current and (t - prev).total_seconds() / 60 <= 1.5 * step_min:
            current.append(i)
        else:
            if current:
                runs.append(current)
            current = [i] if on else []
        prev = t
    if current:
        runs.append(current)
    return runs


def _fmt_duration(minutes: float) -> str:
    h, m = divmod(int(round(minutes)), 60)
    return f"{h} h {m} min" if h and m else f"{h} h" if h else f"{m} min"


def _alarm(type_, severity, start, end, explanation, **values) -> dict:
    return {
        "type": type_, "severity": severity, "ts_start": start.to_pydatetime(), "ts_end": end.to_pydatetime(),
        "explanation": explanation,
        "score": _num(values.get("score")), "expected_kw": _num(values.get("expected_kw")),
        "actual_kw": _num(values.get("actual_kw")), "energy_lost_kwh": _num(values.get("energy_lost_kwh")),
    }


def detect_alarms(readings: pd.DataFrame, plant: PlantInfo, reference_kw_per_kw_m2: float | None,
                  max_inverters: int | None) -> list[dict]:
    """
    reference_kw_per_kw_m2: the plant's normal AC output per unit of sunlight (median over all its data).
    max_inverters: most inverters the plant has ever reported.
    """
    if readings.empty:
        return []
    df = readings.sort_values("ts").reset_index(drop=True)
    step_h = interval_hours(df["ts"])
    step_min = step_h * 60
    step = pd.Timedelta(minutes=step_min)
    ac, irr = df["ac_power_kw"], df["irradiation_kw_m2"]
    sun = _sun_up(df)
    local = lambda t: t.tz_convert(plant.timezone).strftime("%d %b %H:%M")  # noqa: E731
    alarms: list[dict] = []

    # 1. Underperformance: low output for the amount of sunlight, for at least an hour
    if reference_kw_per_kw_m2 and irr.notna().any():
        expected = irr * reference_kw_per_kw_m2
        mask = (irr >= STRONG_SUN_KW_M2) & (ac < UNDERPERFORMANCE_LIMIT * expected)
        for run in _runs(mask, df["ts"], step_min):
            if len(run) * step_min < MIN_UNDERPERFORMANCE_MIN:
                continue
            exp, act = expected.iloc[run], ac.iloc[run]
            ratio = act.sum() / exp.sum()
            lost = (exp - act).clip(lower=0).sum() * step_h
            start, end = df["ts"].iloc[run[0]], df["ts"].iloc[run[-1]] + step
            alarms.append(_alarm(
                "underperformance", "high" if ratio < 0.3 else "medium" if ratio < 0.5 else "low", start, end,
                f"Output was {ratio:.0%} of normal for the available sunlight for {_fmt_duration(len(run) * step_min)} "
                f"({local(start)} – {local(end)}), about {lost:,.0f} kWh lost.",
                score=1 - ratio, expected_kw=exp.mean(), actual_kw=act.mean(), energy_lost_kwh=lost,
            ))

    # 2. Data gaps longer than an hour
    diffs = df["ts"].diff()
    for i in diffs.index[diffs > pd.Timedelta(minutes=GAP_MIN)]:
        start, end = df["ts"].iloc[i - 1] + step, df["ts"].iloc[i]
        hours = pd.date_range(start, end, freq=step).tz_convert(plant.timezone).hour
        daytime = bool(((hours >= 7) & (hours < 17)).any())
        alarms.append(_alarm(
            "data_gap", "medium" if daytime else "low", start, end,
            f"No readings for {_fmt_duration((end - start).total_seconds() / 60)} ({local(start)} – {local(end)})."
            + (" Generation during this period is unknown." if daytime else ""),
        ))

    # 3. Inverters not reporting during daylight
    inv = df["active_inverters"]
    if max_inverters and inv.notna().any():
        mask = sun & (inv < max_inverters)
        for run in _runs(mask, df["ts"], step_min):
            if len(run) < 2:
                continue
            fewest = int(inv.iloc[run].min())
            missing = (max_inverters - fewest) / max_inverters
            start, end = df["ts"].iloc[run[0]], df["ts"].iloc[run[-1]] + step
            alarms.append(_alarm(
                "inverter_dropout", "high" if missing >= 0.25 else "medium" if missing >= 0.1 else "low", start, end,
                f"Only {fewest} of {max_inverters} inverters reported data ({local(start)} – {local(end)}).",
                score=missing, actual_kw=ac.iloc[run].mean(),
            ))

    # 4. Weather sensor fault: plant producing but no sunlight reading
    if irr.notna().any():
        mask = (ac > 0.05 * ac.max()) & (irr.isna() | (irr <= 0))
        for run in _runs(mask, df["ts"], step_min):
            if len(run) < 2:
                continue
            start, end = df["ts"].iloc[run[0]], df["ts"].iloc[run[-1]] + step
            alarms.append(_alarm(
                "sensor_fault", "low", start, end,
                f"The plant was generating but the irradiation sensor read zero or nothing "
                f"({local(start)} – {local(end)}).",
            ))

    return alarms


def alarm_counts_by_day(alarms: list[dict], timezone: str) -> dict[date, int]:
    counts: dict[date, int] = {}
    for a in alarms:
        day = pd.Timestamp(a["ts_start"]).tz_convert(timezone).date()
        counts[day] = counts.get(day, 0) + 1
    return counts
