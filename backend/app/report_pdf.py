"""Render report data (reports.build) to a PDF with reportlab (platypus layout + built-in charts).
Standard PDF fonts only have Latin-1 characters, so ₹ → "Rs", CO₂ → "CO2", ≈ → "~"."""
from __future__ import annotations

import io
from datetime import date

from reportlab.graphics.charts.barcharts import VerticalBarChart
from reportlab.graphics.charts.legends import Legend
from reportlab.graphics.shapes import Drawing, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

NAVY = colors.HexColor("#0f2548")
GREEN = colors.HexColor("#16a34a")
BLUE = colors.HexColor("#60a5fa")
TEAL = colors.HexColor("#0f766e")
MUTED = colors.HexColor("#64748b")
LINE = colors.HexColor("#e2e8f0")
SOFT = colors.HexColor("#f6f8fb")
LABELS = {"output_drop": "Output drop", "inverter_fault": "Inverter fault", "overheating": "Overheating", "shading": "Shading",
          "clipping": "Clipping", "sensor_mismatch": "Sensor mismatch", "underperformance": "Underperformance",
          "data_gap": "Data gap", "inverter_dropout": "Inverter not reporting", "sensor_fault": "Sensor fault"}
ACTIONS = {"clean_now": "Clean now", "clean_in": "Plan a cleaning", "wait_rain": "Wait for rain", "not_needed": "No cleaning needed"}

_ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=_ss["Heading1"], fontSize=17, textColor=colors.white, spaceAfter=2, leading=20)
SUB = ParagraphStyle("sub", parent=_ss["Normal"], fontSize=9.5, textColor=colors.HexColor("#c7d4ea"))
H2 = ParagraphStyle("h2", parent=_ss["Heading2"], fontSize=12.5, textColor=NAVY, spaceBefore=12, spaceAfter=6)
BODY = ParagraphStyle("body", parent=_ss["Normal"], fontSize=9.5, leading=13.5, alignment=TA_LEFT)
SMALL = ParagraphStyle("small", parent=BODY, fontSize=8, leading=11, textColor=MUTED)
CELL = ParagraphStyle("cell", parent=BODY, fontSize=8.5, leading=11)


def txt(s) -> str:
    """Latin-1 safe text for the standard PDF fonts (and escaped for Paragraph markup)."""
    s = str(s if s is not None else "–")
    for a, b in (("₹", "Rs "), ("≈", "~"), ("₂", "2"), ("→", "->"), ("≥", ">="), ("≤", "<="), ("–", "-"), ("—", "-"),
                 ("’", "'"), ("‘", "'"), ("“", '"'), ("”", '"'), ("…", "..."), ("✦", "*")):
        s = s.replace(a, b)
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s.encode("latin-1", "replace").decode("latin-1")


def n(x, d=0, unit=""):
    return "–" if x is None else f"{float(x):,.{d}f}{unit}"


def _day(d) -> str:
    d = date.fromisoformat(d) if isinstance(d, str) else d
    return f"{d:%d %b %Y}"


def _table(rows, widths, head=True, zebra=True):
    t = Table([[Paragraph(txt(c), CELL) if isinstance(c, str) else c for c in r] for r in rows], colWidths=widths, repeatRows=1 if head else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.4, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
             ("TOPPADDING", (0, 0), (-1, -1), 3), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]
    if head:
        style += [("BACKGROUND", (0, 0), (-1, 0), SOFT), ("TEXTCOLOR", (0, 0), (-1, 0), NAVY)]
    if zebra:
        style += [("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#fbfcfe")])]
    t.setStyle(TableStyle(style))
    return t


def _kpi_grid(items):
    cells = [Paragraph(f"<font size=8 color='#64748b'>{txt(k)}</font><br/><font size=13><b>{txt(v)}</b></font>", BODY) for k, v in items]
    rows = [cells[i:i + 4] + [""] * (4 - len(cells[i:i + 4])) for i in range(0, len(cells), 4)]
    t = Table(rows, colWidths=[44 * mm] * 4)
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("BOX", (0, 0), (-1, -1), 0.4, LINE),
                           ("INNERGRID", (0, 0), (-1, -1), 2, colors.white), ("TOPPADDING", (0, 0), (-1, -1), 6),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), 6), ("LEFTPADDING", (0, 0), (-1, -1), 7)]))
    return t


def _energy_chart(daily):
    w, h = 176 * mm, 62 * mm
    dr = Drawing(w, h)
    ch = VerticalBarChart()
    ch.x, ch.y, ch.width, ch.height = 34, 22, w - 50, h - 44
    actual = [round(d["energy_kwh"] / 1000, 1) for d in daily]
    expected = [round((d["expected_kwh"] or 0) / 1000, 1) for d in daily]
    ch.data = [actual, expected] if any(expected) else [actual]
    ch.bars[0].fillColor = GREEN
    if len(ch.data) > 1:
        ch.bars[1].fillColor = colors.HexColor("#cbd5e1")
    ch.bars.strokeColor = None
    ch.groupSpacing, ch.barSpacing = 2, 0
    step = max(1, len(daily) // 10)
    ch.categoryAxis.categoryNames = [f"{d['day']:%d %b}" if i % step == 0 else "" for i, d in enumerate(daily)]
    ch.categoryAxis.labels.fontSize, ch.categoryAxis.labels.angle, ch.categoryAxis.labels.dy = 6.5, 0, -2
    ch.categoryAxis.labels.fontName = ch.valueAxis.labels.fontName = "Helvetica"
    ch.valueAxis.valueMin = 0
    ch.valueAxis.labels.fontSize = 7
    ch.valueAxis.gridStrokeColor, ch.valueAxis.visibleGrid = LINE, True
    dr.add(ch)
    dr.add(String(0, h - 10, "MWh / day", fontSize=7, fillColor=MUTED, fontName="Helvetica"))
    lg = Legend()
    lg.x, lg.y, lg.fontSize, lg.alignment, lg.columnMaximum = w - 170, h - 6, 7, "right", 1
    lg.fontName = "Helvetica"
    lg.colorNamePairs = [(GREEN, "Actual"), (colors.HexColor("#cbd5e1"), "Expected (ML model)")][:len(ch.data)]
    lg.deltax, lg.dx, lg.dy = 80, 7, 7
    dr.add(lg)
    return dr


def render(data: dict) -> bytes:
    buf = io.BytesIO()
    p, k = data["plant"], data.get("kpis", {})
    period = f"{_day(data['start'])} - {_day(data['end'])}"
    title = "Performance report" if data["kind"] == "performance" else "Maintenance report"

    def frame(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 7.5)
        canvas.setFillColor(MUTED)
        canvas.drawString(15 * mm, 9 * mm, txt(f"RenewX · {p['name']} · {title} · {period}"))
        canvas.drawRightString(195 * mm, 9 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=14 * mm,
                            bottomMargin=16 * mm, title=f"RenewX {title} – {p['name']}", author="RenewX")
    s = []
    head = Table([[Paragraph(f"RenewX · {txt(title)}", H1)],
                  [Paragraph(txt(f"{p['name']} · {n(p['capacity_mw'], 1)} MW · tariff Rs {p['tariff']}/kWh · {period} · "
                                 f"generated {data['generated']}"), SUB)]], colWidths=[180 * mm])
    head.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), NAVY), ("LEFTPADDING", (0, 0), (-1, -1), 10),
                              ("TOPPADDING", (0, 0), (0, 0), 10), ("BOTTOMPADDING", (0, -1), (-1, -1), 10)]))
    s += [head, Spacer(1, 8)]

    if not data["daily"]:
        s.append(Paragraph("No data for this period.", BODY))
        doc.build(s, onFirstPage=frame, onLaterPages=frame)
        return buf.getvalue()

    if data.get("summary"):
        box = Table([[Paragraph(f"<b>Executive summary</b> <font size=7 color='#7c3aed'>(AI-written from the figures in this report)</font><br/>{txt(data['summary'])}", BODY)]],
                    colWidths=[180 * mm])
        box.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f5f3ff")), ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#ddd6fe")),
                                 ("LEFTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
        s += [box, Spacer(1, 6)]

    env = data["environment"]
    if data["kind"] == "performance":
        s.append(Paragraph("Summary", H2))
        s.append(_kpi_grid([
            ("Energy produced", n(k["energy_kwh"] / 1000, 1, " MWh")), ("Revenue", f"Rs {n(k['revenue_inr'])}"),
            ("Output vs expected", n(k["output_vs_expected_pct"], 1, " %")), ("Avg performance ratio", n(k["avg_pr"], 3)),
            ("Avg availability", n(k["avg_availability_pct"], 1, " %")), ("Peak output", n(k["peak_mw"], 2, " MW")),
            ("CO2 avoided", n(env.get("total", {}).get("co2_kg", 0) / 1000, 1, " t")), ("Days with data", n(k["days"])),
        ]))
        s += [Spacer(1, 4), Paragraph(txt(f"Best day {_day(k['best_day'])}, weakest day {_day(k['worst_day'])}."), SMALL)]
        s += [Paragraph("Daily energy", H2), _energy_chart(data["daily"])]

        lo = data["losses"]
        total_l = sum(lo.values())
        rows = [["Loss", "Energy (kWh)", "Value (Rs)", "Share of losses"]]
        for name, key in (("Heat (thermal)", "thermal_kwh"), ("Inverter", "inverter_kwh"), ("Soiling (modelled)", "soiling_kwh")):
            rows.append([name, n(lo[key]), n(lo[key] * p["tariff"]), n(100 * lo[key] / total_l, 1, " %") if total_l else "–"])
        s += [Paragraph("Losses", H2), _table(rows, [60 * mm, 40 * mm, 40 * mm, 40 * mm])]

        if data["accuracy"]:
            a = data["accuracy"]
            s += [Paragraph("Forecast accuracy", H2),
                  Paragraph(txt(f"Day-ahead forecast vs actual on {a['days']} day(s): average daily error {a['mape_pct']} %, "
                                f"bias {a['bias_pct']:+} % (positive = forecast too high)."), BODY)]

    an = data["anomalies"]
    s.append(Paragraph(f"Anomalies ({len(an)})", H2))
    if an:
        lost = sum(a["lost_kwh"] for a in an)
        s.append(Paragraph(txt(f"~{lost:,.0f} kWh (Rs {lost * p['tariff']:,.0f}) lost in detected events. Largest events:"), BODY))
        rows = [["Date", "Cause", "Source", "Severity", "Lost (kWh)", "Status"]]
        rows += [[_day(a["day"]), LABELS.get(a["type"], a["type"]), a["source"].upper() if a["source"] == "ml" else "Rule",
                  a["severity"], n(a["lost_kwh"]), a["status"]] for a in an[:12]]
        s.append(_table(rows, [28 * mm, 42 * mm, 18 * mm, 22 * mm, 24 * mm, 26 * mm]))
    else:
        s.append(Paragraph("No anomalies in this period.", BODY))

    s.append(Paragraph("Maintenance", H2))
    done = data["tasks_done"]
    cost = sum(t["cost"] or 0 for t in done)
    s.append(Paragraph(txt(f"{len(done)} task(s) completed in the period (Rs {cost:,.0f} recorded); "
                           f"{len(data['tasks_open'])} open, {sum(t['overdue'] for t in data['tasks_open'])} overdue."), BODY))
    if done:
        rows = [["Done on", "Task", "Category", "Cost (Rs)", "Water (L)"]]
        rows += [[_day(t["day"]), t["title"], t["category"], n(t["cost"]), n(t["water_l"])] for t in done[:15]]
        s.append(_table(rows, [26 * mm, 76 * mm, 26 * mm, 26 * mm, 24 * mm]))
    if data["tasks_open"]:
        rows = [["Open task", "Category", "Due"]]
        rows += [[t["title"] + (" (overdue)" if t["overdue"] else ""), t["category"], _day(t["due"]) if t["due"] else "–"]
                 for t in data["tasks_open"][:10]]
        s += [Spacer(1, 5), _table(rows, [110 * mm, 34 * mm, 34 * mm])]

    c = data["cleaning"]
    if c:
        s += [Paragraph("Cleaning & soiling", H2), Paragraph(txt(
            f"Latest analysis ({_day(c['as_of'])}): {ACTIONS.get(c['action'], c['action'])}"
            + (f" by {_day(c['due'])}" if c["due"] else "") + f"; cleaning score {c['score'] or '–'}/100; soiling loss "
            f"{n(c['loss_pct'], 1)} % at {n(c['rate'], 2)} %/day ({c['rate_source']}). {c['reason'] or ''}"), BODY)]

    recs = data["recommendations"]
    if recs:
        rows = [["Recommendation", "Status", "Gain / 30 days (Rs)", "Confidence"]]
        rows += [[r["title"], r["status"], n(r["gain_inr"]), n(r["confidence"], 0, " %")] for r in recs]
        s += [Paragraph("AI recommendations", H2), _table(rows, [98 * mm, 24 * mm, 34 * mm, 24 * mm])]

    if env.get("has_data"):
        t, w, ind = env["total"], env["water"], env["indicator"]
        s.append(KeepTogether([
            Paragraph("Environmental impact", H2),
            Paragraph(txt(f"{t['energy_kwh'] / 1000:,.1f} MWh of solar energy avoided ~{t['co2_kg'] / 1000:,.1f} t of CO2 "
                          f"(as much as ~{t['trees']:,} trees absorb in a year, or ~{t['cars']:,} cars emit in a year), ~{t['coal_kg'] / 1000:,.1f} t of coal, and "
                          f"powered ~{t['homes']:,} homes. Cleaning used {w['total_l']:,} L of water ({w['per_mwh']} L/MWh); "
                          f"ecological indicator: {ind['level']}."), BODY),
            Paragraph(txt("Factors (approximate): 0.71 kg CO2/kWh (Indian grid), 21 kg CO2 per tree per year, 1.8 t CO2 per "
                          "car per year, 0.6 kg coal/kWh, 100 kWh per home per month."), SMALL)]))

    s += [Spacer(1, 10), Paragraph(txt(
        "Generated by RenewX (prototype). Expected output, anomalies and forecasts come from ML models trained on the "
        "plant's own data; money values use the plant tariff. Figures are estimates."), SMALL)]
    doc.build(s, onFirstPage=frame, onLaterPages=frame)
    return buf.getvalue()
