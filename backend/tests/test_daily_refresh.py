"""Scheduled refresh: secret check and per-plant error isolation (no database). Run with pytest."""
from fastapi.testclient import TestClient

from app import daily_refresh, main


def test_endpoint_needs_the_right_secret(monkeypatch):
    client = TestClient(main.app)
    monkeypatch.setenv("CRON_SECRET", "")
    assert client.post("/internal/daily-refresh", headers={"X-Cron-Secret": ""}).status_code == 403   # disabled
    monkeypatch.setenv("CRON_SECRET", "s3cret-value")
    assert client.post("/internal/daily-refresh").status_code == 403
    assert client.post("/internal/daily-refresh", headers={"X-Cron-Secret": "wrong"}).status_code == 403
    monkeypatch.setattr(daily_refresh, "run_all", lambda: {"plants": 0, "seconds": 0, "results": []})
    r = client.post("/internal/daily-refresh", headers={"X-Cron-Secret": "s3cret-value"})
    assert r.status_code == 200 and r.json()["plants"] == 0


def test_one_failing_step_does_not_stop_the_rest(monkeypatch):
    class Conn:
        def __enter__(self): return self
        def __exit__(self, *a): return False
    plants = [{"id": "1", "name": "A"}, {"id": "2", "name": "B"}]
    monkeypatch.setattr(daily_refresh.db, "connect", lambda: Conn())
    monkeypatch.setattr(daily_refresh.store, "located_plants", lambda conn: plants)
    def forecast(conn, plant):
        if plant["id"] == "1":
            raise RuntimeError("weather down")
        return {"mode": "live"}
    monkeypatch.setattr(daily_refresh.forecast_service, "refresh", forecast)
    monkeypatch.setattr(daily_refresh.soiling_service, "run", lambda conn, plant: {})
    monkeypatch.setattr(daily_refresh.recommendation_service, "run", lambda conn, plant: {})
    out = daily_refresh.run_all()
    a, b = out["results"]
    assert a["forecast"].startswith("failed") and a["cleaning"] == "ok" and a["recommendations"] == "ok"
    assert b["forecast"] == "ok (live)"
