"""Live feed: keys, 15-minute slotting and validation (no database).  Run:  .venv\\Scripts\\pytest -q"""
from datetime import datetime, timezone

import pytest

from app import live_feed as lf

TZ = "Asia/Kolkata"
NOW = datetime(2026, 11, 26, 6, 0, tzinfo=timezone.utc)  # 11:30 IST
CAP = 36_000.0


def r(ts, ac=1000.0, **kw):
    return lf.Reading(ts=ts, ac_power_kw=ac, **kw)


def test_keys_are_random_and_only_the_hash_is_stored():
    raw1, h1, p1 = lf.new_key()
    raw2, h2, _ = lf.new_key()
    assert raw1.startswith("rx_") and raw1 != raw2
    assert h1 == lf.hash_key(raw1) and h1 != h2 and raw1 not in h1
    assert raw1.startswith(p1) and len(p1) == 9


def test_readings_merge_into_15_minute_slots_latest_wins():
    df = lf.to_slots([r("2026-11-26T05:31:00Z", 100), r("2026-11-26T05:44:50Z", 200),
                      r("2026-11-26T05:45:10Z", 300)], TZ, NOW, CAP, timelapse=False)
    assert [t.strftime("%H:%M") for t in df["ts"]] == ["05:30", "05:45"]
    assert df["ac_power_kw"].tolist() == [200, 300]
    assert df["quality_flags"].iloc[0] == ["live"]
    assert df["daily_yield_kwh"].isna().all()  # energy comes from AC power, not yield columns


def test_future_readings_rejected_unless_timelapse_within_today():
    later_today = "2026-11-26T12:00:00Z"   # 17:30 IST, ahead of the clock
    with pytest.raises(lf.IngestError, match="future"):
        lf.to_slots([r(later_today)], TZ, NOW, CAP, timelapse=False)
    df = lf.to_slots([r(later_today)], TZ, NOW, CAP, timelapse=True)
    assert df["quality_flags"].iloc[0] == ["live", "timelapse"]
    with pytest.raises(lf.IngestError, match="within today"):
        lf.to_slots([r("2026-11-26T19:00:00Z")], TZ, NOW, CAP, timelapse=True)  # 00:30 IST tomorrow


def test_old_naive_and_impossible_readings_rejected():
    with pytest.raises(lf.IngestError, match="older than 3 days"):
        lf.to_slots([r("2026-11-20T06:00:00Z")], TZ, NOW, CAP, timelapse=False)
    with pytest.raises(lf.IngestError, match="timezone"):
        lf.to_slots([r("2026-11-26T05:00:00")], TZ, NOW, CAP, timelapse=False)
    with pytest.raises(lf.IngestError, match="150 %"):
        lf.to_slots([r("2026-11-26T05:00:00Z", ac=60_000)], TZ, NOW, CAP, timelapse=False)
    with pytest.raises(ValueError):
        r("2026-11-26T05:00:00Z", irradiation_kw_m2=3.0)  # pydantic range check


def test_rate_limit():
    lf._last_call.clear()
    lf.check_rate("k1")
    with pytest.raises(lf.IngestError) as e:
        lf.check_rate("k1")
    assert e.value.status == 429
    lf.check_rate("k2")  # other devices are not affected
