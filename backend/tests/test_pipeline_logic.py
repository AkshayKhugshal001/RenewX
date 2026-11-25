"""Tests for CSV cleaning and analysis (no database needed).  Run:  .venv\\Scripts\\pytest -q"""
import numpy as np
import pandas as pd
import pytest

from app.analysis import PlantInfo, daily_summaries, detect_alarms, alarm_counts_by_day
from app.cleaning import CsvError, clean_csv

TZ = "Asia/Kolkata"


def make_day_frame(days=2, ratio=30000.0, dc_factor=10.0):
    """Plant-level 15-min data: bell-shaped sunlight 06:00–18:00, AC = ratio × irradiation."""
    ts = pd.date_range("2020-05-15 00:00", periods=96 * days, freq="15min")
    hour = ts.hour + ts.minute / 60
    irr = np.clip(np.sin((hour - 6) / 12 * np.pi), 0, None)  # peaks at 1.0 kW/m² at noon
    ac = ratio * irr
    return pd.DataFrame({
        "plant_id": "Plant_1",
        "DATE_TIME": ts.strftime("%Y-%m-%d %H:%M:%S"),
        "DC_POWER": ac / 0.98 * dc_factor,
        "AC_POWER": ac,
        "DAILY_YIELD": 0.0,
        "TOTAL_YIELD": 0.0,
        "active_inverters": 22,
        "AMBIENT_TEMPERATURE": 25 + 8 * irr,
        "MODULE_TEMPERATURE": 25 + 30 * irr,
        "IRRADIATION": irr,
    })


def to_csv(df):
    return df.to_csv(index=False).encode()


# ── cleaning ────────────────────────────────────────────────
def test_master_format_is_parsed_and_converted_to_utc():
    res = clean_csv(to_csv(make_day_frame(days=1)), TZ)
    r = res.readings
    assert len(r) == 96 and res.rows_rejected == 0
    assert r["ts"].iloc[0] == pd.Timestamp("2020-05-14 18:30", tz="UTC")  # 00:00 IST
    assert res.interval_minutes == 15


def test_dc_power_ten_times_too_high_is_fixed():
    res = clean_csv(to_csv(make_day_frame(days=1)), TZ)
    noon = res.readings.iloc[48]
    assert noon["ac_power_kw"] / noon["dc_power_kw"] == pytest.approx(0.98)
    assert any("divided by 10" in f for f in res.fixes)


def test_correct_dc_is_left_alone():
    res = clean_csv(to_csv(make_day_frame(days=1, dc_factor=1.0)), TZ)
    assert not res.fixes


def test_bad_rows_are_rejected_and_reported():
    df = make_day_frame(days=1).astype(object)
    df.loc[3, "DATE_TIME"] = "not a date"
    df.loc[4, "AC_POWER"] = ""
    df.loc[5, "MODULE_TEMPERATURE"] = "500"  # impossible -> removed
    res = clean_csv(to_csv(df), TZ)
    assert res.rows_rejected == 2 and len(res.readings) == 94
    assert any("unreadable timestamp" in w for w in res.warnings)
    assert "sensor_out_of_range" in res.readings.loc[res.readings["module_temp_c"].isna(), "quality_flags"].iloc[0]


def test_kaggle_per_inverter_file_is_summed_per_timestamp():
    ts = pd.date_range("2020-05-15 12:00", periods=4, freq="15min").strftime("%d-%m-%Y %H:%M")
    rows = [{"DATE_TIME": t, "PLANT_ID": 4135001, "SOURCE_KEY": k, "DC_POWER": 1000.0, "AC_POWER": 980.0,
             "DAILY_YIELD": 1.0, "TOTAL_YIELD": 2.0} for t in ts for k in ("inv_a", "inv_b", "inv_c")]
    res = clean_csv(to_csv(pd.DataFrame(rows)), TZ)
    assert res.per_inverter and len(res.readings) == 4
    assert res.readings["ac_power_kw"].iloc[0] == 2940
    assert res.readings["active_inverters"].iloc[0] == 3
    assert res.timestamp_format == "%d-%m-%Y %H:%M"


def test_irradiance_in_w_per_m2_is_converted():
    df = make_day_frame(days=1)
    df["IRRADIATION"] *= 1000
    res = clean_csv(to_csv(df), TZ)
    assert res.readings["irradiation_kw_m2"].max() == pytest.approx(1.0)


def test_missing_required_column_gives_clear_error():
    with pytest.raises(CsvError, match="AC power"):
        clean_csv(to_csv(make_day_frame(days=1).drop(columns="AC_POWER")), TZ)
    with pytest.raises(CsvError, match="empty"):
        clean_csv(b"   ", TZ)


# ── analysis ────────────────────────────────────────────────
PLANT = PlantInfo(capacity_kwp=30000, tariff_inr_per_kwh=3.0, timezone=TZ)


def test_daily_summary_values():
    readings = clean_csv(to_csv(make_day_frame(days=1, dc_factor=1.0)), TZ).readings
    (s,) = daily_summaries(readings, PLANT, {})
    # ∫ 30000·sin over 12 h ≈ 30000 · 24/π kWh
    assert s["energy_kwh"] == pytest.approx(30000 * 24 / np.pi, rel=0.01)
    assert s["performance_ratio"] == pytest.approx(1.0, rel=0.01)
    assert s["revenue_inr"] == pytest.approx(s["energy_kwh"] * 3.0)
    assert s["inverter_eff_pct"] == pytest.approx(98.0, rel=0.001)
    assert s["availability_pct"] == 100
    assert s["data_completeness_pct"] == 100
    assert s["thermal_loss_kwh"] > 0


def test_alarms_underperformance_gap_and_inverter_dropout():
    df = make_day_frame(days=2, dc_factor=1.0)
    day2 = df["DATE_TIME"].str.startswith("2020-05-16")
    hhmm = df["DATE_TIME"].str[11:16]
    df.loc[day2 & hhmm.between("10:00", "11:45"), "AC_POWER"] *= 0.2        # 2 h at 20 % output
    df.loc[day2 & hhmm.between("09:00", "09:30"), "active_inverters"] = 15  # 7 of 22 silent
    df = df[~(day2 & hhmm.between("13:00", "14:45"))]                       # 2 h of missing data
    readings = clean_csv(to_csv(df), TZ).readings

    alarms = detect_alarms(readings, PLANT, reference_kw_per_kw_m2=30000, max_inverters=22)
    types = {a["type"]: a for a in alarms}
    assert set(types) == {"underperformance", "data_gap", "inverter_dropout"}
    under = types["underperformance"]
    assert under["severity"] == "high" and under["energy_lost_kwh"] > 0
    assert types["data_gap"]["severity"] == "medium"
    assert types["inverter_dropout"]["severity"] == "high"

    counts = alarm_counts_by_day(alarms, TZ)
    assert counts == {pd.Timestamp("2020-05-16").date(): 3}
    summaries = daily_summaries(readings, PLANT, counts)
    assert [s["alarm_count"] for s in summaries] == [0, 3]
    assert summaries[1]["data_completeness_pct"] < 100
