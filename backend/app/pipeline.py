"""Upload pipeline: validate → clean → store readings → recompute daily stats + alarms → report."""
from __future__ import annotations

import logging

import pandas as pd

from . import analysis, db, forecast_service, store
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
            local = df["ts"].dt.tz_convert(tz)
            win_start = local.min().normalize().tz_convert("UTC")
            win_end = (local.max().normalize() + pd.Timedelta(days=1)).tz_convert("UTC")

            with conn.transaction():  # all or nothing
                counts = store.insert_readings(conn, plant_id, upload_id, df, mode)
                window = store.fetch_readings(conn, plant_id, win_start.to_pydatetime(), win_end.to_pydatetime())
                reference, max_inverters = store.plant_reference(conn, plant_id)
                alarms = analysis.detect_alarms(window, info, reference, max_inverters)
                store.replace_rule_alarms(conn, plant_id, upload_id, win_start.to_pydatetime(),
                                          win_end.to_pydatetime(), alarms)
                summaries = analysis.daily_summaries(window, info, analysis.alarm_counts_by_day(alarms, tz))
                store.upsert_summaries(conn, plant_id, summaries)

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
