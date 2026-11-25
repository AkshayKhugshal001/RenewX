"""Battery / grid dispatch what-if (simulated – the plants have no real battery).

Linear programme over one day of the hourly day-ahead forecast:
  maximise  Σ price_t · export_t            export_t = gen_t − charge_t + discharge_t   (kWh per hour)
  subject to
    0 ≤ charge_t ≤ min(P, gen_t)              battery charges from the plant's own solar only
    0 ≤ discharge_t ≤ P
    soc_t = soc_{t−1} + η·charge_t − discharge_t / η,   0 ≤ soc_t ≤ E,   soc_start = soc_end = 0
    export_t ≤ grid limit (plant capacity); output above it is curtailed unless the battery stores it
Time-of-day tariff (assumption, following India's ToD rules): solar hours cheaper, evening peak dearer.
Solved with scipy.optimize.linprog (HiGHS).
"""
from __future__ import annotations

import math

import numpy as np
from scipy.optimize import linprog

ROUND_TRIP_EFF = 0.90
SOLAR_HOURS, SOLAR_FACTOR = range(9, 17), 0.8     # 09:00–17:00 tariff × 0.8
PEAK_HOURS, PEAK_FACTOR = range(18, 22), 1.2      # 18:00–22:00 tariff × 1.2


def tod_prices(base: float) -> np.ndarray:
    p = np.full(24, base)
    p[list(SOLAR_HOURS)] = base * SOLAR_FACTOR
    p[list(PEAK_HOURS)] = base * PEAK_FACTOR
    return p


def dispatch(gen_kw: list[float], *, capacity_kwh: float, power_kw: float, grid_limit_kw: float, tariff: float) -> dict | None:
    """gen_kw: 24 hourly values (local hour 0–23). Returns the optimal schedule and the revenue gain."""
    gen = np.clip(np.asarray(gen_kw, float), 0, None)
    if len(gen) != 24 or capacity_kwh <= 0 or power_kw <= 0 or tariff <= 0 or gen.sum() <= 0:
        return None
    n, eta = 24, math.sqrt(ROUND_TRIP_EFF)
    price = tod_prices(tariff)
    # variables x = [charge(24), discharge(24), soc(24), curtail(24)]
    c = np.concatenate([price, -price, np.zeros(n), price])   # minimise −revenue (curtailed energy earns nothing)
    A_eq, b_eq = np.zeros((n + 1, 4 * n)), np.zeros(n + 1)
    for t in range(n):                                         # soc_t − soc_{t−1} − η c_t + d_t/η = 0
        A_eq[t, 2 * n + t] = 1
        if t > 0:
            A_eq[t, 2 * n + t - 1] = -1
        A_eq[t, t], A_eq[t, n + t] = -eta, 1 / eta
    A_eq[n, 3 * n - 1] = 1                                     # empty again at the end of the day
    A_ub = np.zeros((n, 4 * n))                                # gen − c + d − curtail ≤ grid limit
    for t in range(n):
        A_ub[t, t], A_ub[t, n + t], A_ub[t, 3 * n + t] = -1, 1, -1
    b_ub = grid_limit_kw - gen
    bounds = ([(0, min(power_kw, g)) for g in gen] + [(0, power_kw)] * n + [(0, capacity_kwh)] * n
              + [(0, g) for g in gen])
    res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq, bounds=bounds, method="highs")
    if not res.success:
        return None
    charge, discharge, soc, curtail = res.x[:n], res.x[n:2 * n], res.x[2 * n:3 * n], res.x[3 * n:]
    export = gen - charge + discharge - curtail
    base_rev, new_rev = float(price @ np.minimum(gen, grid_limit_kw)), float(price @ export)
    return {
        "gain_inr": round(new_rev - base_rev), "revenue_without_inr": round(base_rev), "revenue_with_inr": round(new_rev),
        "stored_kwh": round(float(charge.sum())), "shifted_kwh": round(float(discharge.sum())),
        "losses_kwh": round(float(charge.sum() - discharge.sum())), "curtailed_kwh": round(float(curtail.sum())),
        "hours": [{"hour": t, "gen_kw": round(float(gen[t])), "charge_kw": round(float(charge[t])),
                   "discharge_kw": round(float(discharge[t])), "export_kw": round(float(export[t])),
                   "soc_kwh": round(float(soc[t])), "price": round(float(price[t]), 2)} for t in range(n)],
        "assumptions": {"capacity_kwh": capacity_kwh, "power_kw": power_kw, "round_trip_eff": ROUND_TRIP_EFF,
                        "solar_hours": "09–17 × 0.8", "peak_hours": "18–22 × 1.2", "tariff": tariff},
    }
