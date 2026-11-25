"""Report data for a plant and period (performance or maintenance). Rendered to PDF by report_pdf.py.

Optional AI executive summary (Gemini): written from the report figures only and rejected if it contains any
number that is not in them (same guard as the recommendation wording).
"""
from __future__ import annotations

import json
import logging
from datetime import date, datetime, timedelta

from . import assistant, environment, llm

log = logging.getLogger(__name__)
KINDS = ("performance", "maintenance")


def _exists(conn, table: str) -> bool:
    return conn.execute("select to_regclass(%s) is not null", (f"public.{table}",)).fetchone()[0]


def _f(x) -> float:
    return float(x or 0)


def build(conn, plant: dict, start: date, end: date, kind: str = "performance", ai_summary: bool = False) -> dict:
    pid, tz = plant["id"], plant["timezone"]
    tariff = plant.get("tariff_inr_per_kwh") or 0.0
    has_soiling = _exists(conn, "cleaning_analyses")
    rows = conn.execute(
        "select day, energy_kwh, expected_energy_kwh, performance_ratio, availability_pct, revenue_inr, peak_ac_kw, "
        "thermal_loss_kwh, inverter_loss_kwh, " + ("soiling_loss_pct" if has_soiling else "null") +
        " from public.daily_summaries where plant_id = %s and day between %s and %s order by day", (pid, start, end)).fetchall()
    daily = [{"day": r[0], "energy_kwh": _f(r[1]), "expected_kwh": None if r[2] is None else _f(r[2]),
              "pr": None if r[3] is None else _f(r[3]), "availability": None if r[4] is None else _f(r[4]),
              "revenue": _f(r[5]), "peak_kw": _f(r[6]), "thermal_kwh": _f(r[7]), "inverter_kwh": _f(r[8]),
              "soiling_pct": None if r[9] is None else _f(r[9])} for r in rows]
    energy = sum(d["energy_kwh"] for d in daily)
    with_exp = [d for d in daily if d["expected_kwh"]]
    prs = [d["pr"] for d in daily if d["pr"]]
    avs = [d["availability"] for d in daily if d["availability"] is not None]
    soiling_kwh = sum(d["energy_kwh"] * d["soiling_pct"] / (100 - d["soiling_pct"])
                      for d in daily if d["soiling_pct"] and d["soiling_pct"] < 100)
    kpis = {
        "days": len(daily), "energy_kwh": round(energy), "revenue_inr": round(sum(d["revenue"] for d in daily)),
        "expected_kwh": round(sum(d["expected_kwh"] for d in with_exp)) if with_exp else None,
        "output_vs_expected_pct": round(100 * sum(d["energy_kwh"] for d in with_exp) / sum(d["expected_kwh"] for d in with_exp), 1) if with_exp else None,
        "avg_pr": round(sum(prs) / len(prs), 3) if prs else None,
        "avg_availability_pct": round(sum(avs) / len(avs), 1) if avs else None,
        "peak_mw": round(max((d["peak_kw"] for d in daily), default=0) / 1000, 2),
        "best_day": max(daily, key=lambda d: d["energy_kwh"])["day"].isoformat() if daily else None,
        "worst_day": min(daily, key=lambda d: d["energy_kwh"])["day"].isoformat() if daily else None,
    }
    losses = {"thermal_kwh": round(sum(d["thermal_kwh"] for d in daily)), "inverter_kwh": round(sum(d["inverter_kwh"] for d in daily)),
              "soiling_kwh": round(soiling_kwh)}

    lo, hi = datetime.combine(start, datetime.min.time()), datetime.combine(end + timedelta(days=1), datetime.min.time())
    anomalies = [{"day": d, "source": s, "type": t, "severity": sev, "lost_kwh": round(_f(e)), "status": st}
                 for d, s, t, sev, e, st in conn.execute(
                     "select (ts_start at time zone %s)::date, source, type, severity, energy_lost_kwh, status "
                     "from public.anomalies where plant_id = %s and (ts_start at time zone %s) >= %s and (ts_start at time zone %s) < %s "
                     "order by energy_lost_kwh desc nulls last, ts_start", (tz, pid, tz, lo, tz, hi)).fetchall()]

    done, open_tasks = [], []
    if _exists(conn, "maintenance_tasks"):
        done = [{"day": d, "title": t, "category": c, "cost": None if cost is None else _f(cost), "water_l": None if w is None else _f(w)}
                for d, t, c, cost, w in conn.execute(
                    "select (completed_at at time zone %s)::date, title, category, actual_cost_inr, water_litres "
                    "from public.maintenance_tasks where plant_id = %s and status = 'done' "
                    "and (completed_at at time zone %s)::date between %s and %s order by completed_at",
                    (tz, pid, tz, start, end)).fetchall()]
        open_tasks = [{"title": t, "category": c, "due": due, "overdue": bool(due and due < date.today())}
                      for t, c, due in conn.execute(
                          "select title, category, due_date from public.maintenance_tasks where plant_id = %s "
                          "and status in ('planned', 'in_progress') order by due_date nulls last", (pid,)).fetchall()]

    cleaning = None
    if has_soiling:
        row = conn.execute("select as_of, action, due_date, loss_pct, rate_pct_per_day, rate_source, "
                           "result->'decision'->>'score', coalesce(result->'decision'->>'reason', result->'plan'->>'reason') "
                           "from public.cleaning_analyses where plant_id = %s and as_of <= %s order by created_at desc limit 1",
                           (pid, end)).fetchone()
        if row:
            cleaning = {"as_of": row[0], "action": row[1], "due": row[2], "loss_pct": row[3], "rate": row[4],
                        "rate_source": row[5], "score": row[6], "reason": row[7]}

    accuracy = None
    if _exists(conn, "power_forecasts"):
        fc = dict(conn.execute(
            "select ((ts - interval '30 minutes') at time zone %s)::date, sum(predicted_kw) from public.power_forecasts "
            "where plant_id = %s and kind = 'day_ahead' and ((ts - interval '30 minutes') at time zone %s)::date between %s and %s "
            "group by 1", (tz, pid, tz, start, end)).fetchall())
        pairs = [(d["energy_kwh"], _f(fc[d["day"]])) for d in daily if d["day"] in fc and d["energy_kwh"] > 0]
        if pairs:
            accuracy = {"days": len(pairs),
                        "mape_pct": round(100 * sum(abs(f - a) / a for a, f in pairs) / len(pairs), 1),
                        "bias_pct": round(100 * (sum(f for _, f in pairs) / sum(a for a, _ in pairs) - 1), 1)}

    recs = []
    if _exists(conn, "recommendations"):
        recs = [{"title": t, "status": s, "gain_inr": round(_f(g)), "confidence": c} for t, s, g, c in conn.execute(
            "select title, status, gain_inr, confidence from public.recommendations where plant_id = %s and "
            "(status = 'open' or updated_at::date between %s and %s) order by status <> 'open', rank nulls last limit 12",
            (pid, start, end)).fetchall()]

    env = environment.environment(conn, plant, start, end)
    data = {
        "kind": kind, "generated": datetime.now().strftime("%d %b %Y %H:%M"),
        "plant": {"name": plant["name"], "capacity_mw": plant["capacity_mw"], "tariff": tariff, "timezone": tz},
        "start": start, "end": end, "kpis": kpis, "daily": daily, "losses": losses, "anomalies": anomalies,
        "tasks_done": done, "tasks_open": open_tasks, "cleaning": cleaning, "accuracy": accuracy,
        "recommendations": recs, "environment": env, "summary": None,
    }
    if ai_summary and daily:
        data["summary"] = _ai_summary(data)
    return data


SUMMARY_PROMPT = """Write a short executive summary (3–5 sentences, max 110 words) of this solar plant {kind} report
for the plant manager. Mention overall performance, the main issues and the most important next action.
Use ONLY numbers that appear in the JSON, written the same way. Plain text, no headings or bullet points."""


def _ai_summary(data: dict) -> str | None:
    facts = {"plant": data["plant"], "period": f"{data['start']} to {data['end']}", "kpis": data["kpis"],
             "losses_kwh": data["losses"], "anomalies": len(data["anomalies"]),
             "top_anomalies": [{**a, "day": str(a["day"])} for a in data["anomalies"][:5]],
             "tasks_done": len(data["tasks_done"]), "open_tasks": len(data["tasks_open"]),
             "cleaning": {k: str(v) for k, v in (data["cleaning"] or {}).items()},
             "forecast_accuracy": data["accuracy"], "co2_kg": data["environment"].get("total", {}).get("co2_kg"),
             "top_recommendations": data["recommendations"][:3]}
    source = json.dumps(facts, ensure_ascii=False, default=str)
    try:
        text, _ = llm.generate(SUMMARY_PROMPT.format(kind=data["kind"]), [{"role": "user", "content": source}],
                               max_tokens=400, temperature=0.3)
    except llm.LLMError:
        return None
    text = " ".join(text.split())
    if not assistant.grounded(text, source):
        log.info("AI report summary rejected by the number guard")
        return None
    return text
