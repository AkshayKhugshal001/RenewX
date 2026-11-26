"""Upload pipeline: validate → clean → store readings → recompute daily stats + alarms → report."""
from __future__ import annotations

import logging

import pandas as pd

from . import analysis, anomaly_service, db, forecast_service, recommendation_service, soiling_service, store
from .cleaning import CsvError, clean_csv
from .weather import WeatherError

log = logging.getLogger("renewx.pipeline")


class PlantNotFound(Exception):
    pass


def _valid_timezone(tz: str) -> str:
    try:
        pd.Timestamp.now(tz=tz)
        return tz
    except Exception:
        return "Asia/Kolkata"


def day_window(ts: pd.Series, tz: str) -> tuple:
    """Whole local days (UTC start, UTC end) touched by these timestamps."""
    local = ts.dt.tz_convert(tz)
    return (local.min().normalize().tz_convert("UTC").to_pydatetime(),
            (local.max().normalize() + pd.Timedelta(days=1)).tz_convert("UTC").to_pydatetime())


def recompute_days(conn, plant_id: str, upload_id: str | None, info: analysis.PlantInfo, win_start, win_end):
    """Recalculate rule alarms and daily summaries for whole local days from ALL stored readings.
    Shared by CSV uploads and the live feed (call inside a transaction). Returns (summaries, alarms)."""
    window = store.fetch_readings(conn, plant_id, win_start, win_end)
    reference, max_inverters = store.plant_reference(conn, plant_id)
    alarms = analysis.detect_alarms(window, info, reference, max_inverters)
    store.replace_rule_alarms(conn, plant_id, upload_id, win_start, win_end, alarms)
    summaries = analysis.daily_summaries(window, info, analysis.alarm_counts_by_day(alarms, info.timezone))
    store.upsert_summaries(conn, plant_id, summaries)
    return summaries, alarms


def process_upload(plant_id: str, user_id: str, file_name: str, data: bytes, kind: str, mode: str) -> dict:
    with db.connect() as conn:
        plant = store.get_plant(conn, plant_id, user_id)
        if plant is None:
            raise PlantNotFound()
        upload_id = store.create_upload(conn, plant_id, user_id, file_name, kind, mode)

        try:
            tz = _valid_timezone(plant["timezone"])
            result = clean_csv(data, tz)
            df = result.readings
            info = analysis.PlantInfo(plant["capacity_mw"] * 1000, plant["tariff_inr_per_kwh"], tz)

            # Whole local days touched by this file: they are recalculated from ALL stored readings,
            # so a day split across two daily uploads still gets correct totals.
            win_start, win_end = day_window(df["ts"], tz)

            with conn.transaction():  # all or nothing
                counts = store.insert_readings(conn, plant_id, upload_id, df, mode)
                summaries, alarms = recompute_days(conn, plant_id, upload_id, info, win_start, win_end)

            counts.update(total=result.rows_total, rejected=result.rows_rejected)
            ts_from, ts_to = df["ts"].min().to_pydatetime(), df["ts"].max().to_pydatetime()
            warnings = list(result.warnings)
            if plant["capacity_mw"] <= 0:
                warnings.append("Plant capacity is 0, so performance ratio and specific yield could not be calculated. "
                                "Set the capacity in Settings and upload again.")
            report = {
                "fixes": result.fixes,
                "warnings": warnings,
                "column_mapping": result.column_mapping,
                "timestamp_format": result.timestamp_format,
                "interval_minutes": result.interval_minutes,
                "per_inverter_file": result.per_inverter,
                "days_analysed": len(summaries),
                "alarms_found": len(alarms),
            }

            # Forecasts are refreshed with the new data. A failure here must not fail the upload.
            try:
                fc = forecast_service.refresh(conn, plant)
                report["forecast"] = {"mode": fc["mode"], "expected_model": fc.get("expected_model"),
                                      "day_ahead_model": fc.get("day_ahead_model"), "days": fc["days"]}
                warnings.extend(fc.get("notes", []))
            except WeatherError as e:
                warnings.append(f"Forecast not updated: {e}")
            except Exception:
                log.exception("Forecast refresh failed after upload %s", upload_id)
                warnings.append("The data was saved, but the forecast could not be updated. Try 'Refresh forecast'.")

            # ML anomaly detection on all of the plant's data (also must not fail the upload)
            try:
                report["ml_anomalies"] = anomaly_service.run(conn, plant)
            except Exception:
                log.exception("Anomaly detection failed after upload %s", upload_id)
                warnings.append("The data was saved, but ML anomaly detection could not run. "
                                "Try 'Run detection' on the Anomalies page.")

            # Soiling / cleaning / cooling analysis (needs the expected model, so it runs after the forecast)
            try:
                report["cleaning"] = soiling_service.run(conn, plant)
            except Exception:
                log.exception("Cleaning analysis failed after upload %s", upload_id)
                warnings.append("The data was saved, but the cleaning analysis could not run. "
                                "Try 'Refresh analysis' on the Cleaning & Cooling page.")

            # AI recommendations from all module outputs (last step)
            try:
                report["recommendations"] = recommendation_service.run(conn, plant)
            except Exception:
                log.exception("Recommendations failed after upload %s", upload_id)
                warnings.append("The data was saved, but the recommendations could not be updated. "
                                "Try 'Refresh' on the AI Recommendations page.")

            store.finish_upload(conn, upload_id, "done", counts=counts, ts_from=ts_from, ts_to=ts_to, report=report)
            return {"upload_id": upload_id, "status": "done", **counts,
                    "ts_from": ts_from.isoformat(), "ts_to": ts_to.isoformat(), **report}

        except CsvError as e:
            store.finish_upload(conn, upload_id, "failed", error=str(e))
            raise
        except Exception:
            log.exception("Upload %s failed", upload_id)
            store.finish_upload(conn, upload_id, "failed", error="Unexpected error while processing the file.")
            raise
