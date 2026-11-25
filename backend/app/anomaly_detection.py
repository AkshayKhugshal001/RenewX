"""ML anomaly detection for one plant (plant-level). Pure functions: readings in, anomaly events out.

1. Honest expected output: every day is predicted by a model trained on the OTHER days (5-fold, grouped by
   day). A model that has seen a fault while training would partly learn it and hide it.
2. Two detectors on 15-min daylight readings:
     residual         – output far below (or above) the expected value (robust z-score)
     isolation forest – unusual COMBINATION of: actual/expected, inverter efficiency (AC/DC),
                        module heating beyond what the sunlight explains, share of inverters reporting
3. Flagged readings are grouped into events (≥ 30 min); each event gets a likely cause (rules on its pattern),
   energy and money lost, a severity and a plain-English explanation.

Readings already explained by rule alarms (inverter dropout, sensor fault, data gaps, bad rows) are excluded
by the caller through `usable`.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, IsolationForest
from sklearn.model_selection import GroupKFold

from . import forecasting as fc
from .analysis import _fmt_duration, _runs, interval_hours

MIN_SUN_KW_M2 = 0.1       # only judge readings with real sunlight (dawn/dusk values are too noisy)
MIN_EVENT_MIN = 30        # an event must last at least 30 minutes
RESIDUAL_Z = 4.0          # residual detector: more than 4 robust standard deviations from normal …
LOW_RATIO = 0.9           # … and output below 90 % of expected (or above 120 % → sensor mismatch)
HIGH_RATIO = 1.2         # (1.1 flagged harmless wobbles that came and went with tiny model changes)
IF_TREES = 200
IF_QUANTILE = 0.995       # isolation forest flags readings stranger than 99.5 % of normal readings
MIN_IF_ROWS = 200         # fewer normal readings than this → isolation forest is skipped
MIN_LOSS_CAPACITY_H = 0.005  # an unexplained output drop must lose ≥ 0.5 % of capacity × 1 h (180 kWh at 36 MW)
CAUSE_Z = 4.0             # a feature is "clearly abnormal" beyond 4 robust standard deviations
SHADING_DAYS = 3          # same time-of-day dip on ≥ 3 days → shading
SHADING_WINDOW_MIN = 45
SHADING_MAX_MIN = 180

ML_TYPES = ("output_drop", "inverter_fault", "overheating", "shading", "clipping", "sensor_mismatch")
DEFAULT_DETECTORS = ("residual", "iforest")


def _robust(x: pd.Series) -> tuple[float, float]:
    """Median and robust standard deviation (1.4826 × MAD), never zero."""
    x = x.dropna()
    if x.empty:
        return 0.0, 1.0
    med = float(x.median())
    sd = float(1.4826 * (x - med).abs().median())
    return med, max(sd, 1e-6)


def oof_expected(readings: pd.DataFrame, healthy: pd.Series, scale_kw: float, tz: str) -> tuple[pd.DataFrame, str]:
    """Expected AC kW for every reading with a sunlight value, each day predicted without seeing that day."""
    rows, X, sun, mod = fc.expected_inputs(readings, tz)
    y = rows["ac_power_kw"].to_numpy() / scale_kw
    ok = (healthy.loc[rows.index] & rows["ac_power_kw"].notna()).to_numpy() & (sun > 0)  # night is always 0
    day = rows["ts"].dt.tz_convert(tz).dt.date.to_numpy()
    n_days = len(pd.unique(day[ok])) if ok.any() else 0
    pred = np.zeros(len(rows))

    if n_days < fc.MIN_TRAIN_DAYS or ok.sum() < 50:
        pr = fc.fit_pr(sun[ok], mod[ok], y[ok]) if ok.any() else fc.DEFAULT_PR
        pred = fc._physics(sun, mod, pr)
        method = "Physics baseline"
    else:
        for train, test in GroupKFold(n_splits=min(5, n_days)).split(X, groups=day):
            train = train[ok[train]]
            # lighter than the forecast model: same accuracy here (tested), ~4× faster for 5 fits
            model = HistGradientBoostingRegressor(max_iter=120, learning_rate=0.1, max_leaf_nodes=15, random_state=42)
            model.fit(X.iloc[train], y[train])
            pred[test] = np.clip(model.predict(X.iloc[test]), 0, None)
        method = "Gradient Boosting (out-of-fold)"
    out = rows.copy()
    out["expected_kw"] = np.where(sun > 0, pred, 0.0) * scale_kw
    return out, method


def _features(df: pd.DataFrame, normal: pd.Series, max_inverters: float) -> pd.DataFrame:
    sun = df["irradiation_kw_m2"]
    strong = normal & (sun >= 0.3)
    heat = ((df["module_temp_c"] - df["ambient_temp_c"]) / sun)[strong]
    heat_per_sun = float(heat.median()) if heat.notna().any() else 25.0
    f = pd.DataFrame(index=df.index)
    f["ratio"] = (df["ac_power_kw"] / df["expected_kw"]).clip(0, 3)
    f["acdc"] = (df["ac_power_kw"] / df["dc_power_kw"]).where(df["dc_power_kw"] > 0)
    f["temp_excess"] = df["module_temp_c"] - df["ambient_temp_c"] - heat_per_sun * sun
    f["inverters"] = (df["active_inverters"] / max_inverters) if max_inverters else 1.0
    f["residual"] = df["ac_power_kw"] - df["expected_kw"]
    return f


def detect(readings: pd.DataFrame, usable: pd.Series, healthy: pd.Series, scale_kw: float, tz: str,
           tariff_inr_per_kwh: float = 0.0, detectors: tuple[str, ...] = DEFAULT_DETECTORS) -> tuple[list[dict], dict]:
    """Returns (events, info). Events use the `anomalies` table's columns (+ `details`)."""
    if readings.empty or readings["irradiation_kw_m2"].notna().sum() < 20:
        return [], {"method": None, "checked": 0}

    order = readings.sort_values("ts").index
    readings = readings.loc[order].reset_index(drop=True)
    usable, healthy = usable.loc[order].reset_index(drop=True), healthy.loc[order].reset_index(drop=True)
    df, method = oof_expected(readings, healthy, scale_kw, tz)
    df = df.reset_index().rename(columns={"index": "row"})
    step_h = interval_hours(readings["ts"])
    step_min = step_h * 60
    max_inv = float(readings["active_inverters"].max() or 0)

    day = ((df["irradiation_kw_m2"] >= MIN_SUN_KW_M2) & df["ac_power_kw"].notna() & (df["expected_kw"] > 0)
           & usable.loc[df["row"]].to_numpy())
    normal = day & healthy.loc[df["row"]].to_numpy()
    f = _features(df, normal, max_inv)

    # what "normal" looks like for this plant
    res_med, res_sd = _robust(f["residual"][normal])
    acdc_med, acdc_sd = _robust(f["acdc"][normal])
    te_med, te_sd = _robust(f["temp_excess"][normal])
    ac_p99 = float(df["ac_power_kw"][normal].quantile(0.99)) if normal.any() else scale_kw

    flags = pd.DataFrame(False, index=df.index, columns=["residual", "iforest"])
    if "residual" in detectors:
        z = (f["residual"] - res_med) / res_sd
        flags["residual"] = day & (((z < -RESIDUAL_Z) & (f["ratio"] < LOW_RATIO)) |
                                   ((z > RESIDUAL_Z) & (f["ratio"] > HIGH_RATIO)))

    if_rank = pd.Series(np.nan, index=df.index)
    if "iforest" in detectors and normal.sum() >= MIN_IF_ROWS:
        cols = ["ratio", "acdc", "temp_excess", "inverters"]
        Z = f[cols].copy()
        for c in cols:
            med, sd = _robust(f[c][normal])
            Z[c] = ((Z[c].fillna(med) - med) / sd).clip(-50, 50)
        forest = IsolationForest(n_estimators=IF_TREES, random_state=42).fit(Z[normal])
        train_scores = -forest.score_samples(Z[normal])
        scores = pd.Series(-forest.score_samples(Z), index=df.index)
        flags["iforest"] = day & (scores > np.quantile(train_scores, IF_QUANTILE))
        ranked = np.sort(train_scores)
        if_rank = pd.Series(np.searchsorted(ranked, scores.to_numpy()) / len(ranked), index=df.index)

    flagged = (flags["residual"] | flags["iforest"]) & day
    flagged = (flagged | (flagged.shift(1, fill_value=False) & flagged.shift(-1, fill_value=False))) & day

    daily_expected = df[normal].groupby(df["ts"].dt.tz_convert(tz).dt.date)["expected_kw"].sum() * step_h
    day_energy = float(daily_expected.median()) if len(daily_expected) else scale_kw * 5
    local = lambda t: t.tz_convert(tz).strftime("%d %b %H:%M")  # noqa: E731
    inr = lambda kwh: f"₹{kwh * tariff_inr_per_kwh:,.0f}" if tariff_inr_per_kwh else None  # noqa: E731
    step = pd.Timedelta(minutes=step_min)

    events: list[dict] = []
    for run in _runs(flagged, df["ts"], step_min):
        minutes = len(run) * step_min
        if minutes < MIN_EVENT_MIN:
            continue
        seg, fs = df.iloc[run], f.iloc[run]
        exp_sum, act_sum = float(seg["expected_kw"].sum()), float(seg["ac_power_kw"].sum())
        ratio = act_sum / exp_sum if exp_sum > 0 else 1.0
        lost = float((seg["expected_kw"] - seg["ac_power_kw"]).clip(lower=0).sum() * step_h)
        acdc = float(fs["acdc"].median()) if fs["acdc"].notna().any() else acdc_med
        acdc_drop = acdc_med - acdc
        te = float(fs["temp_excess"].mean())
        ac_cv = float(seg["ac_power_kw"].std() / max(seg["ac_power_kw"].mean(), 1e-6))
        sun_cv = float(seg["irradiation_kw_m2"].std() / max(seg["irradiation_kw_m2"].mean(), 1e-6))
        start, end = seg["ts"].iloc[0], seg["ts"].iloc[-1] + step
        when = f"{_fmt_duration(minutes)} ({local(start)} – {local(end)})"
        money = inr(lost)
        lost_txt = f"about {lost:,.0f} kWh" + (f" ({money})" if money else "") + " lost"

        if ratio > HIGH_RATIO:
            type_ = "sensor_mismatch"
            text = (f"The plant produced {ratio:.0%} of what the sunlight sensor reading explains for {when}. "
                    "Generation itself looks fine – the irradiation sensor is probably dirty, shaded or misaligned.")
        elif acdc_drop / acdc_sd > CAUSE_Z and acdc_drop > 0.01:
            type_ = "inverter_fault"
            text = (f"Inverter efficiency (AC/DC) fell to {acdc:.3f} (normal {acdc_med:.3f}) for {when}. The panels "
                    f"delivered normal DC power, so the loss is in the inverters – {lost_txt}. "
                    "Check inverter logs, cooling fans and derating.")
        elif (seg["ac_power_kw"].mean() > 0.5 * ac_p99 and ac_cv < 0.03 and sun_cv > 0.05 and ratio < 0.97):
            type_ = "clipping"
            text = (f"Output stayed flat at about {seg['ac_power_kw'].mean() / 1000:,.1f} MW while sunlight kept "
                    f"changing for {when} – likely grid curtailment or an inverter power limit; {lost_txt}.")
        elif (te - te_med) / te_sd > CAUSE_Z and te - te_med > 5 and ratio < 1.0:
            type_ = "overheating"
            text = (f"Modules ran {te - te_med:.1f} °C hotter than normal for the sunlight for {when}, and output was "
                    f"{ratio:.0%} of expected – {lost_txt}. Check ventilation, hot spots and the cooling schedule.")
        else:
            type_ = "output_drop"
            if lost < MIN_LOSS_CAPACITY_H * scale_kw or ratio >= LOW_RATIO + 0.05:
                continue  # small, unexplained wobble – not worth an alarm
            text = (f"Output was {ratio:.0%} of what the plant should produce for the measured sunlight for {when}; "
                    f"{lost_txt}. No single cause stood out – check strings, connectors, breakers and soiling.")

        frac = lost / day_energy if day_energy > 0 else 0
        if type_ == "sensor_mismatch":
            severity = "medium" if minutes >= 180 else "low"
        else:
            severity = "high" if frac >= 0.05 else "medium" if frac >= 0.01 else "low"
            if type_ == "inverter_fault" and acdc_drop > 0.03:
                severity = "high" if severity == "high" else "medium"

        used = [d for d in ("residual", "iforest") if flags[d].iloc[run].any()]
        rank = if_rank.iloc[run].max()
        events.append({
            "type": type_, "severity": severity,
            "ts_start": start.to_pydatetime(), "ts_end": end.to_pydatetime(),
            "score": round(float(rank), 4) if pd.notna(rank) else round(float(min(1.0, abs(1 - ratio))), 4),
            "expected_kw": round(float(seg["expected_kw"].mean()), 1),
            "actual_kw": round(float(seg["ac_power_kw"].mean()), 1),
            "energy_lost_kwh": round(lost, 1),
            "explanation": text,
            "details": {
                "detectors": used, "minutes": minutes, "output_ratio": round(ratio, 3),
                "acdc": round(acdc, 4), "acdc_normal": round(acdc_med, 4),
                "temp_excess_c": round(te - te_med, 1), "revenue_lost_inr": round(lost * tariff_inr_per_kwh),
                "start_minute": int(start.tz_convert(tz).hour * 60 + start.tz_convert(tz).minute),
                "model": method,
            },
        })

    _mark_shading(events, tz)
    info = {"method": method, "checked": int(day.sum()), "flagged": int(flagged.sum()),
            "normal": {"acdc": round(acdc_med, 4), "residual_sd_kw": round(res_sd, 1), "daily_energy_kwh": round(day_energy)}}
    return events, info


def _mark_shading(events: list[dict], tz: str) -> None:
    """Output drops that repeat at the same time of day on several days → shading."""
    drops = [e for e in events if e["type"] == "output_drop" and e["details"]["minutes"] <= SHADING_MAX_MIN]
    for e in drops:
        m = e["details"]["start_minute"]
        same = [o for o in drops if abs(o["details"]["start_minute"] - m) <= SHADING_WINDOW_MIN]
        days = {pd.Timestamp(o["ts_start"]).tz_convert(tz).date() for o in same}
        if len(days) >= SHADING_DAYS:
            e["type"] = "shading"
            r = e["details"]["output_ratio"]
            e["explanation"] = (
                f"Output dropped to {r:.0%} of expected around {m // 60:02d}:{m % 60:02d} – the same dip appears on "
                f"{len(days)} days, which points to shading (trees, buildings, poles or neighbouring rows). "
                f"About {e['energy_lost_kwh']:,.0f} kWh lost in this event.")
