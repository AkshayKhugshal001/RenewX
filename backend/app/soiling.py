"""Soiling (dust) and cooling analysis. Pure functions: daily data in, estimates + recommendation out.

Soiling
  * Cleanliness index per clear day = actual ÷ expected energy (the Expected model already accounts for
    sunlight and temperature, so what's left is mostly dirt, faults and noise).
  * Dust builds up slowly, so between "resets" (rain ≥ RAIN_RESET_MM or a cleaning marked done) the index
    drifts down. The slope (Theil–Sen, robust to outliers) of each such stretch gives the soiling rate.
  * Too little data for a measurement → a typical Indian value (DEFAULT_RATE) is used and labelled "assumed".
  * Current loss = rate × days since the last reset (linear model, capped).
  * Economics: the optimal interval of a linear loss is T* = √(2·C / (r·E·p))
      C cleaning cost ₹, r rate (fraction/day), E expected energy kWh/day, p tariff ₹/kWh.
    Clean when the days since the last reset reach T*; postpone if the forecast shows rain within RAIN_WAIT_DAYS.

Cooling
  * Hotter modules produce less (≈ 0.4 %/°C). Spraying water cools them by ≈ COOL_DELTA_C.
  * Gain = output × 0.4 % × cooling, for readings above COOL_FROM_C; compared with the water cost.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np
import pandas as pd
from sklearn.linear_model import TheilSenRegressor

RAIN_RESET_MM = 5.0         # daily rain that washes the panels (literature: ~5 mm needed)
RAIN_WAIT_DAYS = 3          # forecast rain this soon → wait instead of cleaning
CLEAR_SUN_FRACTION = 0.6    # clear day: insolation ≥ 60 % of a sunny day at that time of year (90th pct of ±15 days)
SEASON_WINDOW_DAYS = 15
MIN_AVAILABILITY = 95.0     # ignore days with outages
MIN_SEGMENT_DAYS = 4        # clear days needed in a stretch to measure a slope
MIN_MEASURED_DAYS = 8       # clear days needed overall for a measured rate
RECENT_DAYS = 60            # dust rates change with the season: prefer stretches from the last 60 days
DEFAULT_RATE_PCT = 0.3      # %/day, typical for dusty Indian sites (assumption, labelled in the UI)
MAX_RATE_PCT = 2.0
MAX_LOSS_PCT = 25.0
LOSS_THRESHOLD_PCT = 5.0    # rule used when costs/tariff are unknown

TEMP_COEFF = 0.004          # output loss per °C
COOL_FROM_C = 45.0          # spray only when modules are hotter than this
COOL_DELTA_C = 8.0          # typical cooling by water spraying (literature 5–10 °C)
COOL_WATER_L_PER_MW_H = 1500.0   # assumption: water sprayed per MW per hour of cooling
WATER_INR_PER_KL = 50.0          # assumption: tanker water cost in India (₹ per 1000 L)


# ─────────────────────────────────────────────────────────────
# Soiling rate
# ─────────────────────────────────────────────────────────────
def cleanliness_index(daily: pd.DataFrame) -> pd.Series:
    """actual ÷ expected energy on clear, fully available days (NaN otherwise)."""
    ins = daily["insolation_kwh_m2"]
    # "sunny" is judged against nearby dates, so a clear November day isn't compared with June
    when = pd.to_datetime(daily["day"])
    sunny = pd.Series([ins[(when - t).abs() <= pd.Timedelta(days=SEASON_WINDOW_DAYS)].quantile(0.9) for t in when],
                      index=daily.index)
    clear = ((ins >= CLEAR_SUN_FRACTION * sunny) & (daily["availability_pct"].fillna(0) >= MIN_AVAILABILITY)
             & (daily["expected_energy_kwh"] > 0) & daily["energy_kwh"].notna())
    return (daily["energy_kwh"] / daily["expected_energy_kwh"]).where(clear)


GAP_RESET_DAYS = 14        # after a long data gap the panel state is unknown → start a new stretch


def reset_days(days: list[date], rain_mm: dict[date, float], cleanings: list[date]) -> dict[date, str]:
    """Days on which the panels became clean: heavy rain, a cleaning, or (unknown state) a long data gap."""
    resets = {d: "rain" for d in days if rain_mm.get(d, 0) >= RAIN_RESET_MM}
    for prev, d in zip(days, days[1:]):
        if (d - prev).days > GAP_RESET_DAYS:
            resets.setdefault(d, "gap")
    for d in cleanings:
        resets[d] = "cleaning"
    return resets


def soiling_rate(daily: pd.DataFrame, resets: dict[date, str]) -> dict:
    """Measured soiling rate (%/day) from the slopes between resets, or the default if not measurable."""
    idx = cleanliness_index(daily)
    seg_id = daily["day"].map(lambda d: d in resets).cumsum()   # a new stretch starts on each reset day
    stretches = []   # (last day, slope, clear days)
    for _, part in daily.assign(index=idx, seg=seg_id).groupby("seg"):
        part = part.dropna(subset=["index"])
        if len(part) < MIN_SEGMENT_DAYS:
            continue
        x = np.array([(d - part["day"].iloc[0]).days for d in part["day"]], dtype=float).reshape(-1, 1)
        model = TheilSenRegressor(random_state=0).fit(x, part["index"].to_numpy())
        stretches.append((part["day"].iloc[-1], float(model.coef_[0]), len(part)))
    as_of = daily["day"].iloc[-1]
    recent = [s for s in stretches if (as_of - s[0]).days <= RECENT_DAYS]
    since = None
    if sum(s[2] for s in recent) >= MIN_MEASURED_DAYS:
        stretches, since = recent, as_of - timedelta(days=RECENT_DAYS)
    slopes, weights = [s[1] for s in stretches], [s[2] for s in stretches]
    used = sum(weights)

    clear_days = int(idx.notna().sum())
    if used >= MIN_MEASURED_DAYS:
        slope = float(np.average(slopes, weights=weights))           # index change per day
        rate = float(np.clip(-slope * 100, 0, MAX_RATE_PCT))
        recovery = _recovery(daily["day"], idx, {d: r for d, r in resets.items() if since is None or d >= since})
        # real dust washes off: output should jump back up after rain/cleaning by roughly the loss built up
        confidence = ("n/a" if rate == 0 or recovery is None
                      else "high" if recovery["observed_pct"] >= 0.5 * rate * recovery["days_before"] else "low")
        return {"rate_pct_per_day": round(rate, 3), "source": "measured", "clear_days": clear_days,
                "days_used": used, "stretches": len(slopes), "raw_slope_pct": round(-slope * 100, 3),
                "recovery": recovery, "confidence": confidence}
    return {"rate_pct_per_day": DEFAULT_RATE_PCT, "source": "assumed", "clear_days": clear_days,
            "days_used": used, "stretches": len(slopes), "raw_slope_pct": None, "recovery": None,
            "confidence": "assumed"}


def _recovery(days: pd.Series, idx: pd.Series, resets: dict[date, str]) -> dict | None:
    """Average jump of the cleanliness index across rain/cleaning resets (3 clear days each side)."""
    jumps, before_days = [], []
    s = pd.Series(idx.to_numpy(), index=list(days)).dropna()
    for d, why in resets.items():
        if why == "gap":
            continue
        before, after = s[s.index < d].tail(3), s[s.index >= d].head(3)
        if len(before) >= 2 and len(after) >= 2:
            prev = [r for r in resets if r < d]
            start = max(prev) if prev else s.index[0]
            jumps.append(float(after.mean() - before.mean()) * 100)
            before_days.append((d - start).days)
    if not jumps:
        return None
    return {"observed_pct": round(float(np.mean(jumps)), 2), "events": len(jumps), "days_before": float(np.mean(before_days))}


def modelled_loss(days: list[date], resets: dict[date, str], rate_pct: float) -> list[float]:
    """Soiling loss % per day: rate × calendar days since the last reset (the first day counts as clean)."""
    out, since, prev = [], 0, None
    for d in days:
        since = 0 if (prev is None or d in resets) else since + (d - prev).days
        out.append(min(MAX_LOSS_PCT, rate_pct * since))
        prev = d
    return out


JUMP_PCT = 3.0              # cleanliness index jumps up by ≥ 3 points → panels were probably cleaned


def detect_jumps(daily: pd.DataFrame, known: dict[date, str]) -> dict[date, str]:
    """Unrecorded cleanings: days where actual ÷ expected jumps up (≥ JUMP_PCT) and stays up.
    Compares the median of the 3 clear days before with the median of that day and the next 2 clear days."""
    s = pd.Series(cleanliness_index(daily).to_numpy(), index=list(daily["day"])).dropna()
    found: dict[date, str] = {}
    for i in range(3, len(s) - 2):
        d = s.index[i]
        if any(abs((d - k).days) <= 1 for k in list(known) + list(found)):
            continue
        before, after = s.iloc[i - 3:i].median(), s.iloc[i:i + 3].median()
        rise = (s.iloc[i] - s.iloc[i - 1]) * 100          # the jump must happen on this very day
        if (after - before) * 100 >= JUMP_PCT and rise >= JUMP_PCT / 2:
            found[d] = "jump"
    return found


def last_reset(days: list[date], resets: dict[date, str], as_of: date) -> tuple[date, str]:
    past = [d for d in resets if d <= as_of]
    return (max(past), resets[max(past)]) if past else (days[0], "start")


# ─────────────────────────────────────────────────────────────
# Cleaning decision
# ─────────────────────────────────────────────────────────────
def cleaning_plan(*, rate_pct: float, days_since_reset: int, as_of: date, energy_kwh_day: float,
                  tariff: float, cleaning_cost_inr: float, forecast: list[dict]) -> dict:
    """forecast: [{day, energy_kwh, rain_mm}] for the days after `as_of`."""
    r = rate_pct / 100
    loss_pct = min(MAX_LOSS_PCT, rate_pct * days_since_reset)
    daily_loss_kwh = r * days_since_reset * energy_kwh_day
    lost_since_kwh = r * energy_kwh_day * days_since_reset * (days_since_reset + 1) / 2
    economic = tariff > 0 and cleaning_cost_inr > 0 and r > 0 and energy_kwh_day > 0
    optimal = math.sqrt(2 * cleaning_cost_inr / (r * energy_kwh_day * tariff)) if economic else None

    rain = next((f for f in forecast[:RAIN_WAIT_DAYS] if f.get("rain_mm", 0) >= RAIN_RESET_MM), None)
    later_rain = next((f for f in forecast if f.get("rain_mm", 0) >= RAIN_RESET_MM), None)

    if r == 0:
        action, due, reason = "not_needed", None, "No measurable soiling in the data."
    elif rain:
        action, due = "wait_rain", rain["day"]
        reason = (f"{rain['rain_mm']:.0f} mm of rain is forecast on {_d(rain['day'])} – it should wash the panels "
                  f"for free, so cleaning now would waste money and water.")
    elif economic:
        if days_since_reset >= optimal:
            action, due = "clean_now", as_of + timedelta(days=1)
            reason = (f"Dust has built up for {days_since_reset} days. The energy lost since the last clean "
                      f"(≈ ₹{lost_since_kwh * tariff:,.0f}) now exceeds the cost of one cleaning (₹{cleaning_cost_inr:,.0f}).")
        else:
            wait = math.ceil(optimal - days_since_reset)
            action, due = "clean_in", as_of + timedelta(days=wait)
            reason = (f"Cleaning pays off every ≈ {optimal:.0f} days at this soiling rate; "
                      f"{days_since_reset} days have passed since the panels were last clean.")
            if later_rain and later_rain["day"] <= due:
                action, due = "wait_rain", later_rain["day"]
                reason += f" Rain is forecast on {_d(later_rain['day'])}, before then."
    else:
        if loss_pct >= LOSS_THRESHOLD_PCT:
            action, due = "clean_now", as_of + timedelta(days=1)
        else:
            action = "clean_in"
            due = as_of + timedelta(days=math.ceil((LOSS_THRESHOLD_PCT - loss_pct) / rate_pct))
        reason = (f"Set the plant's tariff and cleaning cost for a cost-based plan; until then panels are cleaned "
                  f"when the estimated loss reaches {LOSS_THRESHOLD_PCT:.0f} %.")

    projection, since = [], days_since_reset
    for f in forecast:
        since = 0 if f.get("rain_mm", 0) >= RAIN_RESET_MM else since + 1
        lp = min(MAX_LOSS_PCT, rate_pct * since)
        projection.append({"day": f["day"].isoformat(), "loss_pct": round(lp, 2), "rain_mm": round(f.get("rain_mm", 0), 1),
                           "loss_inr": round(lp / 100 * (f.get("energy_kwh") or energy_kwh_day) * tariff)})
    return {
        "action": action, "due": due.isoformat() if due else None, "reason": reason,
        "loss_pct": round(loss_pct, 2), "daily_loss_kwh": round(daily_loss_kwh), "daily_loss_inr": round(daily_loss_kwh * tariff),
        "lost_since_reset_kwh": round(lost_since_kwh), "lost_since_reset_inr": round(lost_since_kwh * tariff),
        "optimal_interval_days": round(optimal, 1) if optimal else None, "projection": projection,
    }


def _d(d: date) -> str:
    return f"{d:%d %b}"


# ─────────────────────────────────────────────────────────────
# Cooling
# ─────────────────────────────────────────────────────────────
def cooling_analysis(readings: pd.DataFrame, capacity_mw: float, tariff: float, tz: str, interval_h: float) -> dict:
    """Would spraying water on hot modules pay off? Uses the given (recent) readings."""
    df = readings.dropna(subset=["module_temp_c", "ac_power_kw"])
    if df.empty or capacity_mw <= 0:
        return {"verdict": "unknown", "reason": "Needs module temperature readings and the plant capacity."}
    local = df["ts"].dt.tz_convert(tz)
    n_days = max(1, local.dt.date.nunique())
    hot = df["module_temp_c"] > COOL_FROM_C
    cooling = np.minimum(COOL_DELTA_C, (df["module_temp_c"] - df["ambient_temp_c"].fillna(df["module_temp_c"] - 20)).clip(lower=0))
    gain_kwh = float((df["ac_power_kw"] * TEMP_COEFF * cooling)[hot].sum() * interval_h) / n_days
    hours = float(hot.sum() * interval_h) / n_days
    water_l = hours * capacity_mw * COOL_WATER_L_PER_MW_H
    water_cost = water_l / 1000 * WATER_INR_PER_KL
    gain_inr = gain_kwh * tariff
    by_hour = local[hot].dt.hour.value_counts()
    common = sorted(by_hour[by_hour >= 0.5 * n_days].index.tolist())
    window = f"{common[0]:02d}:00 – {common[-1] + 1:02d}:00" if common else None
    worth = tariff > 0 and gain_inr > 1.2 * water_cost and hours >= 1
    if hours < 0.25:
        verdict, reason = "not_needed", f"Modules rarely exceed {COOL_FROM_C:.0f} °C, so cooling would gain almost nothing."
    elif worth:
        verdict = "recommended"
        reason = (f"Spraying {window or 'at midday'} would gain ≈ {gain_kwh:,.0f} kWh/day (₹{gain_inr:,.0f}) "
                  f"for ≈ ₹{water_cost:,.0f} of water.")
    else:
        verdict = "not_worth_it"
        reason = (f"Cooling would gain ≈ {gain_kwh:,.0f} kWh/day (₹{gain_inr:,.0f}) but use ≈ {water_l:,.0f} L of water "
                  f"(₹{water_cost:,.0f}) – not worth it; the water is better used for cleaning.")
    return {
        "verdict": verdict, "reason": reason, "days": n_days,
        "hot_hours_per_day": round(hours, 1), "window": window,
        "peak_module_temp_c": round(float(df["module_temp_c"].max()), 1),
        "gain_kwh_per_day": round(gain_kwh), "gain_inr_per_day": round(gain_inr),
        "water_l_per_day": round(water_l), "water_cost_inr_per_day": round(water_cost),
        "assumptions": {"cooling_c": COOL_DELTA_C, "from_c": COOL_FROM_C, "water_l_per_mw_h": COOL_WATER_L_PER_MW_H,
                        "water_inr_per_kl": WATER_INR_PER_KL, "temp_coeff_pct": TEMP_COEFF * 100},
    }
