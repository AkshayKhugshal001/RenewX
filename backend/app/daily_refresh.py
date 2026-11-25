"""Scheduled daily refresh (called every morning by a GitHub Actions workflow).

For every plant with a location: new 7-day forecast with fresh weather → cleaning analysis (rain forecast changed)
→ recommendations. Anomaly detection only changes when new readings arrive, so it is not repeated here.
Each plant is handled separately: one failure never stops the others.
"""
from __future__ import annotations

import logging
import time

from . import db, forecast_service, recommendation_service, soiling_service, store

log = logging.getLogger(__name__)


def run_all() -> dict:
    started = time.time()
    results = []
    with db.connect() as conn:
        plants = store.located_plants(conn)
        for plant in plants:
            t, steps = time.time(), {}
            for name, step in (("forecast", forecast_service.refresh), ("cleaning", soiling_service.run),
                               ("recommendations", recommendation_service.run)):
                try:
                    out = step(conn, plant)
                    steps[name] = "ok" if name != "forecast" else f"ok ({out.get('mode')})"
                except Exception as e:  # keep going with the next step / plant
                    log.exception("Daily refresh: %s failed for plant %s", name, plant["id"])
                    steps[name] = f"failed: {type(e).__name__}"
            results.append({"plant": plant["name"], "seconds": round(time.time() - t, 1), **steps})
    return {"plants": len(results), "seconds": round(time.time() - started, 1), "results": results}
