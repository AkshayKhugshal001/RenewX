"""Forecasting models on synthetic data where the true plant behaviour is known.  Run:  .venv\\Scripts\\pytest -q"""
import numpy as np
import pandas as pd

from app import forecasting as fc

TZ = "Asia/Kolkata"
CAP = 30000.0  # kWp
PR = 0.8


def synthetic(days=14, seed=0):
    """15-min plant readings + matching hourly weather. Cloudy days reduce sunlight."""
    rng = np.random.default_rng(seed)
    ts = pd.date_range("2020-05-15", periods=96 * days, freq="15min", tz=TZ).tz_convert("UTC")
    local = ts.tz_convert(TZ)
    hour = local.hour + local.minute / 60
    clear = np.clip(np.sin((hour - 6) / 12 * np.pi), 0, None)
    cloud = np.repeat(rng.uniform(0, 80, days), 96)              # % per day
    irr = clear * (1 - 0.6 * cloud / 100)                         # kW/m²
    module = 25 + 30 * irr
    ac = CAP * irr * PR * (1 - 0.004 * (module - 25)) * rng.normal(1, 0.02, len(ts))
    readings = pd.DataFrame({
        "ts": ts, "ac_power_kw": np.clip(ac, 0, None), "dc_power_kw": ac / 0.98, "irradiation_kw_m2": irr,
        "module_temp_c": module, "ambient_temp_c": 25 + 8 * irr, "active_inverters": 22.0,
        "quality_flags": [[] for _ in range(len(ts))],
    })
    # hourly weather, labelled by hour END (Open-Meteo convention)
    hourly = (readings.assign(cloud=cloud).set_index("ts")[["irradiation_kw_m2", "cloud"]]
              .resample("1h", label="right", closed="right").mean())
    weather = pd.DataFrame({
        "ts": hourly.index, "ghi_w_m2": hourly["irradiation_kw_m2"].to_numpy() * 1000,
        "temp_c": 28.0, "cloud_cover_pct": hourly["cloud"].to_numpy(),
        "precipitation_mm": 0.0, "humidity_pct": 50.0, "wind_speed_ms": 2.0,
    })
    return readings, weather


def test_expected_model_learns_the_plant():
    readings, _ = synthetic()
    usable = fc.usable_rows(readings, [])
    fitted, pred = fc.fit_expected(readings, fc.healthy_rows(readings, usable), CAP, TZ)
    assert set(fitted.scores) == {"Physics baseline", "Random Forest", "Gradient Boosting"}
    best = fitted.scores[fitted.name]
    assert best["r2"] > 0.95 and best["daily_energy_error_pct"] < 5
    assert len(pred) == len(readings)
    night = readings["irradiation_kw_m2"].to_numpy() == 0
    assert (pred["predicted_kw"].to_numpy()[night] == 0).all()
    assert (pred["lower_kw"] <= pred["predicted_kw"]).all() and (pred["predicted_kw"] <= pred["upper_kw"]).all()


def test_physics_baseline_recovers_performance_ratio():
    readings, _ = synthetic()
    sun = readings["irradiation_kw_m2"].to_numpy()
    pr = fc.fit_pr(sun, readings["module_temp_c"].to_numpy(), readings["ac_power_kw"].to_numpy() / CAP)
    assert abs(pr - PR) < 0.02


def test_day_ahead_backtest_and_future_forecast():
    readings, weather = synthetic(days=14)
    actuals = fc.hourly_actuals(readings, fc.usable_rows(readings, []), 15)
    fitted, backtest = fc.fit_day_ahead(actuals, weather, CAP, TZ)
    assert fitted.scores[fitted.name]["r2"] > 0.9
    assert len(backtest) > 0 and backtest["ts"].min() >= weather["ts"].iloc[-24 * 4]  # only the last held-out days

    future_weather = weather.tail(48).assign(ts=weather["ts"].tail(48) + pd.Timedelta(days=14))
    future = fc.predict_day_ahead(fitted, future_weather, CAP, TZ)
    assert len(future) == 48 and future["predicted_kw"].max() < CAP * 1.1
    assert (future.loc[future_weather["ghi_w_m2"].to_numpy() == 0, "predicted_kw"] == 0).all()


def test_little_data_falls_back_to_physics():
    readings, weather = synthetic(days=3)
    actuals = fc.hourly_actuals(readings, fc.usable_rows(readings, []), 15)
    fitted, backtest = fc.fit_day_ahead(actuals, weather, CAP, TZ)
    assert fitted.name == fc.PHYSICS and fitted.model is None and backtest.empty
    assert abs(fitted.pr - PR) < 0.05  # still calibrated to the plant


def test_problem_rows_are_excluded_from_training():
    readings, _ = synthetic(days=6)
    readings.loc[100:110, "quality_flags"] = [["low_inverters"]] * 11
    start, end = readings["ts"].iloc[200], readings["ts"].iloc[210]
    usable = fc.usable_rows(readings, [(start, end)])
    assert not usable[100:110].any() and not usable[200:209].any() and usable[300]
    readings.loc[300:310, "ac_power_kw"] *= 0.1  # an outage in strong sun
    healthy = fc.healthy_rows(readings, usable)
    assert not healthy[readings.index[300:311][readings["irradiation_kw_m2"][300:311] >= 0.2]].any()
