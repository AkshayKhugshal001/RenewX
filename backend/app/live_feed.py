"""Live data feed: device keys + ingest of readings sent by a (simulated) device.

A device (the phone page /device, or a real ESP32/data logger later) sends readings with the header
X-Device-Key. Readings are merged into the plant's 15-minute slots (latest value in a slot wins), so the rest
of RenewX – which expects 15-minute data – works unchanged. After every ingest only the touched local days are
recalculated (daily summary + rule alarms). Forecasts, ML anomalies, cleaning and recommendations stay on the
scheduled daily refresh (they take 25–45 s and must not run every few seconds).
"""
from __future__ import annotations

import hashlib
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import pandas as pd
from pydantic import BaseModel, Field

from . import analysis, store
from .cleaning import READING_COLS
from .pipeline import day_window, recompute_days

KEY_PREFIX = "rx_"
SLOT = pd.Timedelta(minutes=15)
MAX_BATCH = 96                 # one day of 15-minute slots (the phone's offline queue is sent in batches)
MIN_INTERVAL_S = 2.0           # rate limit per device
MAX_AGE = timedelta(days=3)    # older readings belong in a CSV upload


class Reading(BaseModel):
    ts: datetime                                              # ISO 8601 with timezone (the device sends UTC)
    ac_power_kw: float = Field(ge=0)
    dc_power_kw: float | None = Field(default=None, ge=0)
    irradiation_kw_m2: float | None = Field(default=None, ge=0, le=1.6)
    ambient_temp_c: float | None = Field(default=None, ge=-30, le=60)
    module_temp_c: float | None = Field(default=None, ge=-30, le=100)
    active_inverters: int | None = Field(default=None, ge=0, le=1000)


class IngestBody(BaseModel):
    readings: list[Reading] = Field(min_length=1, max_length=MAX_BATCH)
    timelapse: bool = False   # demo mode: each reading is the next 15-minute slot of today (may be ahead of the clock)


class IngestError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status, self.detail = status, detail


# ── Keys ────────────────────────────────────────────────────────────────
def hash_key(raw: str) -> str:
    return hashlib.sha256(raw.strip().encode()).hexdigest()


def new_key() -> tuple[str, str, str]:
    """(raw key shown once, sha256 hash stored, short prefix shown in lists)."""
    raw = KEY_PREFIX + secrets.token_urlsafe(24)
    return raw, hash_key(raw), raw[:9]


def create_key(conn, plant_id: str, name: str) -> dict:
    raw, digest, prefix = new_key()
    row = conn.execute(
        "insert into public.device_keys (plant_id, name, key_hash, key_prefix) values (%s, %s, %s, %s) "
        "returning id, created_at",
        (plant_id, name.strip()[:60] or "Phone device", digest, prefix),
    ).fetchone()
    return {"id": str(row[0]), "name": name, "key": raw, "key_prefix": prefix, "created_at": row[1].isoformat()}


def authenticate(conn, raw: str) -> tuple[str, dict]:
    """(key id, plant) for a valid, non-revoked key."""
    if not raw or not raw.startswith(KEY_PREFIX):
        raise IngestError(401, "Missing or invalid device key.")
    row = conn.execute(
        """select k.id, k.revoked_at, p.id, p.name, p.capacity_mw, p.tariff_inr_per_kwh, p.timezone,
                  p.latitude, p.longitude, p.data_mode
             from public.device_keys k join public.plants p on p.id = k.plant_id
            where k.key_hash = %s""",
        (hash_key(raw),),
    ).fetchone()
    if row is None:
        raise IngestError(401, "Unknown device key. Create a new device in Settings → Data input.")
    if row[1] is not None:
        raise IngestError(401, "This device key was revoked. Create a new device in Settings → Data input.")
    plant = store._plant_dict(row[2:9])
    plant["data_mode"] = row[9]
    return str(row[0]), plant


# ── Rate limit (in memory; the backend runs as one process) ─────────────
_last_call: dict[str, float] = {}
_lock = threading.Lock()


def check_rate(key_id: str) -> None:
    now = time.monotonic()
    with _lock:
        if now - _last_call.get(key_id, 0.0) < MIN_INTERVAL_S:
            raise IngestError(429, "Too many requests – send at most one batch every 2 seconds.")
        _last_call[key_id] = now


# ── Pure helpers (tested) ───────────────────────────────────────────────
def end_of_local_day(now: datetime, tz: str) -> pd.Timestamp:
    local = pd.Timestamp(now).tz_convert(tz)
    return (local.normalize() + pd.Timedelta(days=1)).tz_convert("UTC")


def to_slots(readings: list[Reading], tz: str, now: datetime, capacity_kw: float, timelapse: bool) -> pd.DataFrame:
    """Validate and merge readings into 15-minute slots (latest reading in a slot wins).
    Returns a DataFrame in the same shape the CSV cleaner produces (ts + READING_COLS + quality_flags)."""
    now_ts = pd.Timestamp(now)
    latest_allowed = end_of_local_day(now, tz) if timelapse else now_ts + pd.Timedelta(minutes=5)
    rows = []
    for r in readings:
        ts = pd.Timestamp(r.ts)
        if ts.tzinfo is None:
            raise IngestError(422, "Timestamps need a timezone (send UTC, e.g. 2026-11-26T09:15:00Z).")
        ts = ts.tz_convert("UTC")
        if ts < now_ts - MAX_AGE:
            raise IngestError(422, "Reading is older than 3 days – upload older data as a CSV instead.")
        if ts >= latest_allowed:
            raise IngestError(422, "Reading is in the future." if not timelapse
                              else "Time-lapse readings must stay within today.")
        limit = capacity_kw * 1.5 if capacity_kw > 0 else None
        for col in ("ac_power_kw", "dc_power_kw"):
            v = getattr(r, col)
            if limit is not None and v is not None and v > limit:
                raise IngestError(422, f"{col} = {v:,.0f} kW is above 150 % of the plant capacity.")
        rows.append({"ts": ts.floor(SLOT), **{c: getattr(r, c, None) for c in READING_COLS}})

    df = pd.DataFrame(rows)
    for c in READING_COLS:  # yield columns are never sent: energy is computed from AC power
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.drop_duplicates("ts", keep="last").sort_values("ts").reset_index(drop=True)
    flags = ["live", "timelapse"] if timelapse else ["live"]
    df["quality_flags"] = [list(flags) for _ in range(len(df))]
    return df


# ── Ingest ──────────────────────────────────────────────────────────────
def ingest(conn, key_id: str, plant: dict, body: IngestBody, now: datetime | None = None) -> dict:
    if plant["data_mode"] != "live":
        raise IngestError(409, f"“{plant['name']}” is in manual mode. Switch it to Live in Settings → Data input.")
    now = now or datetime.now(timezone.utc)
    tz = plant["timezone"]
    df = to_slots(body.readings, tz, now, plant["capacity_mw"] * 1000, body.timelapse)
    info = analysis.PlantInfo(plant["capacity_mw"] * 1000, plant["tariff_inr_per_kwh"], tz)
    win_start, win_end = day_window(df["ts"], tz)

    with conn.transaction():
        store.insert_readings(conn, plant["id"], None, df, "replace")
        summaries, alarms = recompute_days(conn, plant["id"], None, info, win_start, win_end)
        conn.execute(
            "update public.device_keys set last_seen_at = now(), readings_sent = readings_sent + %s where id = %s",
            (len(body.readings), key_id),
        )

    today = summaries[-1] if summaries else {}
    return {
        "accepted": len(body.readings),
        "slots": len(df),
        "latest_slot": df["ts"].max().isoformat(),
        "day": str(today.get("day", "")),
        "energy_kwh": today.get("energy_kwh"),
        "peak_ac_kw": today.get("peak_ac_kw"),
        "alarms": [{"type": a["type"], "severity": a["severity"], "explanation": a["explanation"]} for a in alarms],
    }


# ── Device info (what the phone needs to simulate realistic values) ─────
def device_info(conn, plant: dict) -> dict:
    """Plant facts + its own 'output per sunlight' profile (same idea as ML/tools/make_demo_csv.py)."""
    row = conn.execute(
        """select
             (select percentile_cont(0.5) within group (
                       order by ac_power_kw / (irradiation_kw_m2 * (1 - 0.004 * (module_temp_c - 25))))
                from public.plant_readings
               where plant_id = %(p)s and irradiation_kw_m2 > 0.3 and ac_power_kw > 0 and module_temp_c is not null),
             (select percentile_cont(0.5) within group (order by (module_temp_c - ambient_temp_c) / irradiation_kw_m2)
                from public.plant_readings
               where plant_id = %(p)s and irradiation_kw_m2 > 0.3 and module_temp_c is not null
                 and ambient_temp_c is not null),
             (select max(active_inverters) from public.plant_readings where plant_id = %(p)s),
             (select max(ts) from public.plant_readings where plant_id = %(p)s and 'live' = any(quality_flags))""",
        {"p": plant["id"]},
    ).fetchone()
    capacity_kw = plant["capacity_mw"] * 1000
    k, heat, inverters, last_live = row
    return {
        "plant": {"name": plant["name"], "timezone": plant["timezone"], "latitude": plant["latitude"],
                  "longitude": plant["longitude"], "capacity_kw": capacity_kw, "data_mode": plant["data_mode"]},
        "profile": {
            # kW per kW/m² at 25 °C; without data assume performance ratio 0.8
            "k": float(k) if k else (capacity_kw * 0.8 if capacity_kw > 0 else 1000.0),
            "heat": float(heat) if heat else 25.0,       # module °C above air per kW/m²
            "inverters": int(inverters) if inverters else 10,
            "from_data": bool(k),
        },
        "last_live_reading": last_live.isoformat() if last_live else None,
        "limits": {"max_batch": MAX_BATCH, "min_interval_s": MIN_INTERVAL_S},
    }
