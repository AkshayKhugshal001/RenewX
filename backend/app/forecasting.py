"""Forecasting models (scikit-learn). Pure functions: DataFrames in, predictions + test scores out.

Two tasks, same method:
  * expected  – 15-min AC power from the plant's own sensor (sunlight, module/ambient temperature, time of day).
                "What the plant should have produced" -> reveals hidden losses on past days.
  * day_ahead – hourly AC power from weather-API data (sunlight, temperature, cloud, humidity, time of day).
                Trained on past weather, then applied to the weather forecast for the next days.

For each task three models are compared on the most recent days (held out, never seen in training):
  Physics baseline  (sunlight × capacity × performance ratio × temperature correction)
  Random Forest
  Gradient Boosting
The most accurate one (lowest RMSE) is refitted on all data and used. With less than
MIN_TRAIN_DAYS of data, only the physics baseline is used (a brand-new plant still gets a forecast).
Targets are normalised by plant capacity (kW per kWp), so the same code works for any plant size.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor, RandomForestRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

TEMP_COEFF_PER_C = 0.004
STC_TEMP_C = 25.0
DEFAULT_PR = 0.80                # typical performance ratio, used before a plant has data
NOCT_RISE_C_PER_W = 25 / 800     # module ≈ air temperature + 25 °C at 800 W/m²
MIN_TRAIN_DAYS = 5
DAYLIGHT_KW_M2 = 0.05
UNDERPERFORMANCE_LIMIT = 0.6
PHYSICS = "Physics baseline"


def _candidates() -> dict:
    return {
        "Random Forest": RandomForestRegressor(n_estimators=150, min_samples_leaf=3, n_jobs=-1, random_state=42),
        "Gradient Boosting": HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05, random_state=42),
    }


def _hour_features(local: pd.Series) -> tuple[np.ndarray, np.ndarray]:
    h = (local.dt.hour + local.dt.minute / 60).to_numpy()
    return np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)


def _physics(sun: np.ndarray, module_temp: np.ndarray, pr: float) -> np.ndarray:
    return np.clip(sun * pr * (1 - TEMP_COEFF_PER_C * (module_temp - STC_TEMP_C)), 0, None)


def fit_pr(sun: np.ndarray, module_temp: np.ndarray, y: np.ndarray) -> float:
    """Performance ratio that best explains the data (median over strong-sun rows)."""
    strong = sun >= 0.2
    if strong.sum() < 10:
        return DEFAULT_PR
    ratio = y[strong] / _physics(sun[strong], module_temp[strong], 1.0)
    ratio = ratio[np.isfinite(ratio) & (ratio > 0)]
    return float(np.clip(np.median(ratio), 0.3, 1.2)) if len(ratio) else DEFAULT_PR


@dataclass
class Task:
    X: pd.DataFrame
    y: np.ndarray            # kW per kWp
    sun: np.ndarray          # kW/m²
    module_temp: np.ndarray  # °C
    day: np.ndarray          # local date, for the day-based train/test split


@dataclass
class Fitted:
    name: str
    model: object | None
    pr: float
    scores: dict = field(default_factory=dict)        # candidate -> test metrics
    test_mask: np.ndarray | None = None               # rows of the task used as test days
    test_pred: np.ndarray | None = None               # best model's predictions for those rows (kW per kWp)
    band: tuple[float, float] = (-0.0, 0.0)           # 10th / 90th percentile of test errors (kW per kWp)
    train_days: int = 0

    def predict(self, X: pd.DataFrame, sun: np.ndarray, module_temp: np.ndarray) -> np.ndarray:
        if self.model is None:
            pred = _physics(sun, module_temp, self.pr)
        else:
            pred = np.clip(self.model.predict(X), 0, None)
        return np.where(sun > 0, pred, 0.0)


def _metrics(actual_kw, pred_kw, daylight, day) -> dict:
    a, p = actual_kw[daylight], pred_kw[daylight]
    daily = pd.DataFrame({"d": day, "a": actual_kw, "p": pred_kw}).groupby("d").sum()
    daily = daily[daily["a"] > 0]
    return {
        "mae_kw": round(float(mean_absolute_error(a, p)), 1),
        "rmse_kw": round(float(np.sqrt(mean_squared_error(a, p))), 1),
        "r2": round(float(r2_score(a, p)), 3) if len(a) > 1 else None,
        "daily_energy_error_pct": round(float((abs(daily["p"] - daily["a"]) / daily["a"]).mean() * 100), 1) if len(daily) else None,
    }


def select_and_fit(task: Task, scale_kw: float) -> Fitted:
    """Compare models on the last ~20 % of days, then refit the best one on everything."""
    days = sorted(pd.unique(task.day))
    n_days = len(days)
    if n_days < MIN_TRAIN_DAYS or len(task.y) < 50:
        return Fitted(PHYSICS, None, fit_pr(task.sun, task.module_temp, task.y) if len(task.y) else DEFAULT_PR,
                      train_days=n_days, band=(-0.05, 0.05))

    n_test = max(2, round(0.2 * n_days))
    test = np.isin(task.day, days[-n_test:])
    train = ~test
    pr = fit_pr(task.sun[train], task.module_temp[train], task.y[train])

    preds = {PHYSICS: _physics(task.sun[test], task.module_temp[test], pr)}
    models = _candidates()
    for name, model in models.items():
        model.fit(task.X[train], task.y[train])
        preds[name] = np.clip(model.predict(task.X[test]), 0, None)

    daylight = task.sun[test] >= DAYLIGHT_KW_M2
    actual_kw = task.y[test] * scale_kw
    scores = {name: _metrics(actual_kw, p * scale_kw, daylight, task.day[test]) for name, p in preds.items()}
    best = min(scores, key=lambda n: scores[n]["rmse_kw"])

    errors = (task.y[test] - preds[best])[daylight]
    band = (float(np.percentile(errors, 10)), float(np.percentile(errors, 90))) if len(errors) else (0.0, 0.0)

    if best == PHYSICS:
        final_model, final_pr = None, fit_pr(task.sun, task.module_temp, task.y)
    else:
        final_model = _candidates()[best].fit(task.X, task.y)
        final_pr = pr
    return Fitted(best, final_model, final_pr, scores, test, preds[best], band, n_days)


# ─────────────────────────────────────────────────────────────
# Data quality: which rows can be used for training
# ─────────────────────────────────────────────────────────────
def usable_rows(readings: pd.DataFrame, outages: list[tuple]) -> pd.Series:
    """Rows without data problems (inverters missing, weather missing, inverter/sensor alarm periods)."""
    flags = readings["quality_flags"]
    ok = ~flags.apply(lambda f: "low_inverters" in f or "missing_weather" in f or "sensor_out_of_range" in f)
    for start, end in outages:
        ok &= ~((readings["ts"] >= start) & (readings["ts"] < end))
    return ok


def healthy_rows(readings: pd.DataFrame, usable: pd.Series) -> pd.Series:
    """Usable rows where the plant also performed normally (for the 'should have produced' model)."""
    irr, ac = readings["irradiation_kw_m2"], readings["ac_power_kw"]
    strong = (irr >= 0.2) & (ac > 0)
    if strong.sum() < 10:
        return usable
    reference = float((ac[strong] / irr[strong]).median())
    return usable & ~((irr >= 0.2) & (ac < UNDERPERFORMANCE_LIMIT * reference * irr))


# ─────────────────────────────────────────────────────────────
# Expected generation (15-min, plant sensor)
# ─────────────────────────────────────────────────────────────
def expected_inputs(readings: pd.DataFrame, tz: str):
    """Features for rows that have a sunlight reading. Returns (rows, X, sun, module_temp)."""
    df = readings[readings["irradiation_kw_m2"].notna()].copy()
    sun = df["irradiation_kw_m2"].clip(lower=0).to_numpy()
    amb = df["ambient_temp_c"].fillna(df["ambient_temp_c"].median()).fillna(25)
    mod = df["module_temp_c"].fillna(amb + 30 * df["irradiation_kw_m2"]).to_numpy()
    hs, hc = _hour_features(df["ts"].dt.tz_convert(tz))
    X = pd.DataFrame({"sun": sun, "module_temp": mod, "ambient_temp": amb.to_numpy(), "hour_sin": hs, "hour_cos": hc})
    return df, X, sun, mod


def fit_expected(readings: pd.DataFrame, healthy: pd.Series, scale_kw: float, tz: str) -> tuple[Fitted, pd.DataFrame]:
    """Returns the fitted model and predictions (ts, predicted_kw, lower_kw, upper_kw) for every past reading."""
    rows, X, sun, mod = expected_inputs(readings, tz)
    train = (healthy.loc[rows.index] & rows["ac_power_kw"].notna()).to_numpy()
    local_day = rows["ts"].dt.tz_convert(tz).dt.date.to_numpy()
    task = Task(X[train].reset_index(drop=True), (rows["ac_power_kw"].to_numpy() / scale_kw)[train],
                sun[train], mod[train], local_day[train])
    fitted = select_and_fit(task, scale_kw)
    pred = fitted.predict(X, sun, mod) * scale_kw
    out = pd.DataFrame({"ts": rows["ts"].to_numpy(), "predicted_kw": pred})
    out["lower_kw"] = np.where(pred > 0, np.clip(pred + fitted.band[0] * scale_kw, 0, None), 0)
    out["upper_kw"] = np.where(pred > 0, np.maximum(pred, pred + fitted.band[1] * scale_kw), 0)
    return fitted, out


# ─────────────────────────────────────────────────────────────
# Day-ahead (hourly, weather API)
# ─────────────────────────────────────────────────────────────
def hourly_actuals(readings: pd.DataFrame, usable: pd.Series, interval_min: float) -> pd.DataFrame:
    """Mean AC power per hour (labelled by hour END, like Open-Meteo). Keeps complete, problem-free hours."""
    r = readings.assign(hour=readings["ts"].dt.ceil("h"), ok=usable.astype(float))
    g = r.groupby("hour").agg(ac_kw=("ac_power_kw", "mean"), n=("ac_power_kw", "count"), ok=("ok", "mean"))
    per_hour = 60 / interval_min
    g = g[(g["n"] >= 0.75 * per_hour) & (g["ok"] >= 0.75)]
    return g[["ac_kw"]].reset_index().rename(columns={"hour": "ts"})


def day_ahead_inputs(weather: pd.DataFrame, tz: str):
    w = weather.reset_index(drop=True)
    ghi = w["ghi_w_m2"].fillna(0).clip(lower=0).to_numpy()
    temp = w["temp_c"].fillna(w["temp_c"].median()).fillna(25).to_numpy()
    hs, hc = _hour_features((w["ts"] - pd.Timedelta(minutes=30)).dt.tz_convert(tz))  # middle of the hour
    X = pd.DataFrame({
        "ghi": ghi, "temp": temp,
        "cloud": w["cloud_cover_pct"].fillna(50).to_numpy(),
        "humidity": w["humidity_pct"].fillna(60).to_numpy(),
        "hour_sin": hs, "hour_cos": hc,
    })
    return X, ghi / 1000, temp + NOCT_RISE_C_PER_W * ghi


def fit_day_ahead(actuals: pd.DataFrame, weather: pd.DataFrame, scale_kw: float, tz: str) -> tuple[Fitted, pd.DataFrame]:
    """Returns the fitted model and its held-out test predictions (ts, predicted_kw, lower_kw, upper_kw)."""
    joined = actuals.merge(weather, on="ts", how="inner").dropna(subset=["ghi_w_m2"]).reset_index(drop=True)
    if joined.empty:
        return Fitted(PHYSICS, None, DEFAULT_PR, band=(-0.05, 0.05)), pd.DataFrame(columns=["ts", "predicted_kw", "lower_kw", "upper_kw"])
    X, sun, mod = day_ahead_inputs(joined, tz)
    day = (joined["ts"] - pd.Timedelta(minutes=30)).dt.tz_convert(tz).dt.date.to_numpy()
    fitted = select_and_fit(Task(X, joined["ac_kw"].to_numpy() / scale_kw, sun, mod, day), scale_kw)
    if fitted.test_mask is None:
        return fitted, pd.DataFrame(columns=["ts", "predicted_kw", "lower_kw", "upper_kw"])
    test = joined[fitted.test_mask]
    pred = np.where(sun[fitted.test_mask] > 0, fitted.test_pred, 0) * scale_kw
    return fitted, _with_band(test["ts"].to_numpy(), pred, fitted, scale_kw)


def predict_day_ahead(fitted: Fitted, weather: pd.DataFrame, scale_kw: float, tz: str) -> pd.DataFrame:
    if weather.empty:
        return pd.DataFrame(columns=["ts", "predicted_kw", "lower_kw", "upper_kw"])
    X, sun, mod = day_ahead_inputs(weather, tz)
    return _with_band(weather["ts"].to_numpy(), fitted.predict(X, sun, mod) * scale_kw, fitted, scale_kw)


def _with_band(ts, pred_kw: np.ndarray, fitted: Fitted, scale_kw: float) -> pd.DataFrame:
    lower = np.where(pred_kw > 0, np.clip(pred_kw + fitted.band[0] * scale_kw, 0, None), 0)
    upper = np.where(pred_kw > 0, np.clip(pred_kw + fitted.band[1] * scale_kw, 0, scale_kw * 1.1), 0)
    return pd.DataFrame({"ts": ts, "predicted_kw": pred_kw, "lower_kw": lower, "upper_kw": np.maximum(upper, pred_kw)})
