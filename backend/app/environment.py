"""Environmental impact of a plant: CO₂ avoided with everyday equivalents, water use, site conditions and a simple
ecological indicator. Used by the Environment page (GET /plants/{id}/environment) and by the PDF reports.

Conversion factors are approximate, commonly cited values (shown in the UI and reports as assumptions):
  CO₂: 0.71 kg per kWh of Indian grid electricity replaced (CEA baseline, rounded)
  tree: ≈ 21 kg CO₂ absorbed per mature tree per year
  car: ≈ 1.8 t CO₂ per Indian passenger car per year (≈ 12,000 km at ≈ 150 g/km)
  coal: ≈ 0.6 kg of coal burned per kWh in Indian coal plants
  home: ≈ 100 kWh per Indian household per month
Ecological indicator (water use per MWh produced, last 90 days of data; more than 4 cleanings a month raises it):
  < 50 L/MWh low · < 150 L/MWh medium · otherwise high.
"""
from __future__ import annotations

from datetime import date, timedelta

from .analysis import CO2_KG_PER_KWH

TREE_KG_PER_YEAR = 21.0
CAR_KG_PER_YEAR = 1800.0
COAL_KG_PER_KWH = 0.6
HOME_KWH_PER_MONTH = 100.0
WATER_LOW, WATER_HIGH = 50.0, 150.0      # L per MWh
CLEANINGS_PER_MONTH_HIGH = 4
INDICATOR_DAYS = 90

FACTORS = {"co2_kg_per_kwh": CO2_KG_PER_KWH, "tree_kg_co2_per_year": TREE_KG_PER_YEAR, "car_kg_co2_per_year": CAR_KG_PER_YEAR,
           "coal_kg_per_kwh": COAL_KG_PER_KWH, "home_kwh_per_month": HOME_KWH_PER_MONTH}


def equivalents(energy_kwh: float, days: int) -> dict:
    """Everyday equivalents of `energy_kwh` produced over `days` days."""
    co2 = energy_kwh * CO2_KG_PER_KWH
    return {
        "energy_kwh": round(energy_kwh), "co2_kg": round(co2),
        "trees": round(co2 / TREE_KG_PER_YEAR),                   # trees growing for one year absorb the same CO₂
        "cars": round(co2 / CAR_KG_PER_YEAR, 1),                  # cars driven for one year emit the same CO₂
        "coal_kg": round(energy_kwh * COAL_KG_PER_KWH),
        "homes": round(energy_kwh / (HOME_KWH_PER_MONTH * max(days, 1) / 30)),   # homes powered for the same time
    }


def indicator(water_l: float, energy_kwh: float, cleanings: int, days: int) -> dict:
    per_mwh = water_l / (energy_kwh / 1000) if energy_kwh > 0 else 0.0
    level = 0 if per_mwh < WATER_LOW else 1 if per_mwh < WATER_HIGH else 2
    per_month = cleanings / max(days, 1) * 30
    if per_month > CLEANINGS_PER_MONTH_HIGH:
        level = min(2, level + 1)
    label = ["Low", "Medium", "High"][level]
    why = (f"{per_mwh:,.0f} L of water per MWh produced" + (f", {per_month:.1f} cleanings per month" if cleanings else "")
           + f" (last {days} days of data). Low < {WATER_LOW:.0f}, high ≥ {WATER_HIGH:.0f} L/MWh.")
    return {"level": label, "water_l_per_mwh": round(per_mwh, 1), "cleanings_per_month": round(per_month, 1), "reason": why}


def _exists(conn, table: str) -> bool:
    return conn.execute("select to_regclass(%s) is not null", (f"public.{table}",)).fetchone()[0]


def environment(conn, plant: dict, start: date | None = None, end: date | None = None) -> dict:
    """Environmental summary. With start/end only that period is used (reports); otherwise everything."""
    pid, tz = plant["id"], plant["timezone"]
    where, args = "plant_id = %s", [pid]
    if start:
        where += " and day between %s and %s"
        args += [start, end]
    days = conn.execute(
        f"select day, energy_kwh, insolation_kwh_m2, avg_ambient_temp_c, max_module_temp_c, soiling_loss_pct "
        f"from public.daily_summaries where {where} order by day", args).fetchall() \
        if _exists(conn, "cleaning_analyses") else conn.execute(
        f"select day, energy_kwh, insolation_kwh_m2, avg_ambient_temp_c, max_module_temp_c, null "
        f"from public.daily_summaries where {where} order by day", args).fetchall()
    if not days:
        return {"has_data": False, "factors": FACTORS}
    first, last = days[0][0], days[-1][0]
    n_days = len(days)
    total = sum(float(d[1] or 0) for d in days)
    latest = float(days[-1][1] or 0)
    month_days = [d for d in days if d[0] > last - timedelta(days=30)]
    month = sum(float(d[1] or 0) for d in month_days)

    cleanings = []
    if _exists(conn, "maintenance_tasks"):
        cleanings = conn.execute(
            "select (completed_at at time zone %s)::date, coalesce(water_litres, 0), coalesce(actual_cost_inr, 0) "
            "from public.maintenance_tasks where plant_id = %s and status = 'done' and category = 'cleaning' "
            "and completed_at is not null order by completed_at", (tz, pid)).fetchall()
    in_period = [c for c in cleanings if first <= c[0] <= last]
    water_total = sum(float(c[1]) for c in in_period)

    ind_from = last - timedelta(days=INDICATOR_DAYS - 1)
    ind_energy = sum(float(d[1] or 0) for d in days if d[0] >= ind_from)
    ind_clean = [c for c in cleanings if ind_from <= c[0] <= last]
    ind_days = min(INDICATOR_DAYS, (last - max(first, ind_from)).days + 1)

    saved_water = 0.0
    if _exists(conn, "cleaning_analyses"):
        waits = conn.execute(
            "select count(distinct due_date), max(cleaning_cost_inr) from public.cleaning_analyses "
            "where plant_id = %s and action = 'wait_rain' and as_of between %s and %s", (pid, first, last)).fetchone()
        per_clean = conn.execute("select to_jsonb(p) from public.plants p where id = %s", (pid,)).fetchone()[0]
        saved_water = (waits[0] or 0) * float(per_clean.get("cleaning_water_l_per_mw") or 0) * plant["capacity_mw"]

    rain = dict(conn.execute(
        "select ((ts - interval '30 minutes') at time zone %s)::date, sum(precipitation_mm) from public.weather_data "
        "where plant_id = %s and source = 'open-meteo' and ts >= %s and ts < %s group by 1",
        (tz, pid, first - timedelta(days=1), last + timedelta(days=2))).fetchall())
    daily = [{"day": d.isoformat(), "energy_kwh": round(float(e or 0)), "co2_kg": round(float(e or 0) * CO2_KG_PER_KWH),
              "sun_kwh_m2": None if s is None else round(float(s), 2), "temp_c": None if t is None else round(float(t), 1),
              "max_module_c": None if m is None else round(float(m), 1), "rain_mm": round(float(rain.get(d) or 0), 1),
              "soiling_pct": None if sl is None else round(float(sl), 2),
              "water_l": round(sum(float(c[1]) for c in cleanings if c[0] == d))} for d, e, s, t, m, sl in days]
    return {
        "has_data": True, "first_day": first.isoformat(), "last_day": last.isoformat(), "days": n_days,
        "latest": {"day": last.isoformat(), **equivalents(latest, 1)},
        "month": {"days": len(month_days), **equivalents(month, len(month_days))},
        "total": {"days": n_days, **equivalents(total, n_days)},
        "water": {"total_l": round(water_total), "cleanings": len(in_period),
                  "per_mwh": round(water_total / (total / 1000), 1) if total else 0.0,
                  "saved_by_rain_l": round(saved_water)},
        "indicator": indicator(sum(float(c[1]) for c in ind_clean), ind_energy, len(ind_clean), ind_days),
        "daily": daily, "factors": FACTORS,
    }
