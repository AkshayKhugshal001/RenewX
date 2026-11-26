"""RenewX team test guide (small A4 PDF).  From RenewX/:  backend/.venv/Scripts/python docs/make_team_guide.py docs/RenewX_Team_Test_Guide.pdf"""
import sys

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.fonts import addMapping
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

OUT = sys.argv[1]
# Arial (Windows) instead of Helvetica: it has →, ₹ and ● which the built-in PDF fonts lack
for name, file in [("Arial", "arial"), ("Arial-Bold", "arialbd"), ("Arial-Italic", "ariali"), ("Arial-BoldItalic", "arialbi")]:
    pdfmetrics.registerFont(TTFont(name, f"C:/Windows/Fonts/{file}.ttf"))
for bold, italic, name in [(0, 0, "Arial"), (1, 0, "Arial-Bold"), (0, 1, "Arial-Italic"), (1, 1, "Arial-BoldItalic")]:
    addMapping("Arial", bold, italic, name)
GREEN = colors.HexColor("#1f8a4c")
NAVY = colors.HexColor("#0f2548")
SOFT = colors.HexColor("#eef6f1")
LINE = colors.HexColor("#d7dee8")
MUTED = colors.HexColor("#5b6b80")

ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=ss["Title"], fontName="Arial-Bold", fontSize=20, textColor=NAVY, alignment=TA_LEFT, spaceAfter=2)
SUB = ParagraphStyle("sub", parent=ss["Normal"], fontName="Arial", fontSize=9.5, textColor=MUTED, spaceAfter=8)
H2 = ParagraphStyle("h2", parent=ss["Heading2"], fontName="Arial-Bold", fontSize=12, textColor=GREEN, spaceBefore=8, spaceAfter=4)
P = ParagraphStyle("p", parent=ss["Normal"], fontName="Arial", fontSize=9, leading=12)
CELL = ParagraphStyle("cell", parent=P, fontSize=8.3, leading=10.4)
HEAD = ParagraphStyle("head", parent=CELL, fontName="Arial-Bold", textColor=colors.white)
NUM = ParagraphStyle("num", parent=CELL, fontName="Arial-Bold", textColor=GREEN, fontSize=10)

URL = "https://frontend-zeta-one-29.vercel.app"
REPO = "github.com/AkshayKhugshal001/RenewX"

STEPS = [
    ("Create an account",
     "Open the site, choose <b>Sign up</b>, use your own email + name. Confirm the email if asked, then log in.",
     "Dashboard with <i>Add your first plant</i>."),
    ("Add the Dehradun plant",
     "<b>Add plant</b>: name <i>Dehradun Plant</i>, location search <i>Dehradun</i>, capacity <b>36</b> MW, tariff <b>3</b> "
     "₹/kWh. Attach <i>RenewX_Dehradun_Plant_2026-09-27_to_2026-11-26.csv</i> as historical data. Wait 1–2 min.",
     "Upload report: ~5,800 rows, 61 days, no rows rejected. Dashboard shows the latest day."),
    ("Record the known cleaning",
     "<b>Maintenance → Maintenance tasks → New task</b>: category Cleaning, due <b>20 Oct 2026</b>, save, then "
     "<b>Mark done</b> with that date.",
     "Task listed as done. (The 12 Nov cleaning is NOT recorded on purpose – RenewX should find it.)"),
    ("Dashboard tour",
     "Switch Power tabs Today / Week / Month. Read Key Metrics, Loss Analysis, AI Recommendation. "
     "Click the shield icon (top right).",
     "Charts fill in; shield shows open alarms and opens Maintenance → Anomalies."),
    ("Plant Overview",
     "Open <b>Plant Overview</b>.",
     "Plant profile, totals, daily history, alarm summary."),
    ("Forecasting",
     "Click <b>Refresh forecast</b> (30–45 s).",
     "7-day day-ahead forecast, model comparison (RMSE/MAE), accuracy of past days."),
    ("Anomalies",
     "<b>Maintenance → Anomalies</b>, status <i>All</i>. Compare the list with <i>fault_log.csv</i>. Open one, "
     "click <b>Run detection</b>, then <b>Create task</b> from an anomaly.",
     "All 10 injected faults appear (dates and causes as in the log); day chart, cause, energy lost."),
    ("Maintenance tasks",
     "Tab <b>Maintenance tasks</b>: find the new task, add one with <b>New task</b>, then <b>Mark done</b> on one.",
     "Overdue / upcoming lists, health score, before/after effect of finished work."),
    ("Cleaning &amp; Cooling",
     "Read the cleaning decision. Under panel photos click <b>Import sample photos</b>, then <b>Refresh analysis</b>.",
     "Score 0–100 with reasons, dust rate near 0.4 %/day, the unrecorded 12 Nov cleaning, photo overlay."),
    ("AI Recommendations",
     "<b>Approve</b> one recommendation, <b>Dismiss</b> another (give a reason). Look at the battery what-if.",
     "Approved item becomes a maintenance task; ranked list with ₹ gain and confidence."),
    ("Environment",
     "Open <b>Environment</b>.",
     "CO<sub>2</sub> avoided with trees/cars equivalents, water use, ecological indicator."),
    ("Reports",
     "<b>Reports</b> → pick a month (or custom dates) → <b>Download PDF</b>. Try once with the AI summary on.",
     "A4 PDF with KPIs, chart, losses, anomalies, maintenance, recommendations."),
    ("Live feed (phone)",
     "<b>Settings → Data input</b> → <b>Live feed</b> → <b>Create device + QR</b>. Scan with your phone → "
     "<b>Time-lapse</b> → <b>Start sending</b>. After a few readings tap <b>Inverter trip</b>.",
     "Dashboard badge <i>● Live</i>, Today curve grows; an inverter alarm appears on phone and in Anomalies."),
    ("Ask RenewX (assistant)",
     "Chat button (bottom right): ask <i>Why is my output lower than expected?</i> and "
     "<i>How does the forecasting model work?</i> Try <b>Report an issue</b> once.",
     "Short answers using your plant's numbers; off-topic questions are declined."),
    ("Account &amp; appearance",
     "<b>Settings → Account</b>: edit name; <b>Change password</b> (asks current password first); "
     "<b>Change email</b> (confirmation link). Log out, use <b>Forgot password?</b>. "
     "<b>Appearance</b> → Dark.",
     "Each change opens a step dialog; wrong current password is rejected; plants stay after email change."),
    ("Jaipur plant",
     "Add <i>Jaipur Plant</i> (Jaipur, 36 MW, tariff 3) with <i>RenewX_Jaipur_Plant_2026-09-27_to_2026-11-26.csv</i>; record its cleaning on <b>25 Oct 2026</b>. "
     "Switch plants with the plant menu at the top.",
     "Every page changes to the selected plant; data never mixes; dust ≈ 0.6 %/day, faults as in the log."),
]


def steps_table():
    rows = [[Paragraph("#", HEAD), Paragraph("Feature", HEAD), Paragraph("Do this", HEAD),
             Paragraph("You should see", HEAD), Paragraph("OK / notes", HEAD)]]
    for i, (name, do, see) in enumerate(STEPS, 1):
        rows.append([Paragraph(str(i), NUM), Paragraph(f"<b>{name}</b>", CELL), Paragraph(do, CELL),
                     Paragraph(see, CELL), ""])
    t = Table(rows, colWidths=[8 * mm, 35 * mm, 60 * mm, 50 * mm, 21 * mm], repeatRows=1)
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f7f9fc")]),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
    ]))
    return t


def box(paragraphs):
    t = Table([[paragraphs]], colWidths=[174 * mm])
    t.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, -1), SOFT), ("BOX", (0, 0), (-1, -1), 0.6, GREEN),
                           ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                           ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6)]))
    return t


def bullets(items):
    return [Paragraph(f"•&nbsp;&nbsp;{x}", P) for x in items]


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Arial", 7.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 10 * mm, "RenewX · team test guide · CSE27-413 · 26 Nov 2026")
    canvas.drawRightString(192 * mm, 10 * mm, f"Page {doc.page}")
    canvas.restoreState()


story = [
    Paragraph("RenewX – Team Test Guide", H1),
    Paragraph("Walk through every feature once, in this order, with a brand-new account. About 45–60 minutes. "
              "Tick each step and write down anything that looks wrong.", SUB),
    box(bullets([
        f"<b>Website:</b> {URL} (laptop, Chrome or Edge). A phone is needed for step 13.",
        f"<b>Test files</b> (download from {REPO}, folder <i>ML/data/test</i>): <i>RenewX_Dehradun_Plant_2026-09-27_to_2026-11-26.csv</i>, "
        "<i>RenewX_Jaipur_Plant_2026-09-27_to_2026-11-26.csv</i> and <i>fault_log.csv</i> (what RenewX should find).",
        "<b>First request can take ~1 minute</b> – the free server sleeps when unused. Wait; don't keep refreshing.",
        "Use your <b>own</b> email – never share accounts. Every account only sees its own plants.",
    ])),
    Paragraph("Steps", H2),
    steps_table(),
    KeepTogether([
        Paragraph("Not bugs (known prototype limits)", H2),
        *bullets([
            "The test files are <b>synthetic</b>: real weather at each city × the real 2020 behaviour of two Kaggle plants, plus injected faults and dust. The phone device is simulated too.",
            "Plant locations (Dehradun/Jaipur) and the 36 MW capacity are assumptions, so forecasts are only moderately accurate.",
            "Forecasts, ML anomalies and recommendations refresh after uploads and every morning at 06:00 – "
            "live readings update only today's statistics and rule alarms immediately.",
            "The assistant explains; it never changes data. The battery is a what-if simulation.",
        ]),
        Paragraph("How to report a problem", H2),
        *bullets([
            "Step number, what you clicked, what you expected, what happened, and a screenshot.",
            "Send it in the team group, or use <b>Ask RenewX → Report an issue</b> (the team sees it in Supabase).",
        ]),
    ]),
]

doc = SimpleDocTemplate(OUT, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=15 * mm, bottomMargin=16 * mm,
                        title="RenewX – Team Test Guide", author="RenewX team (CSE27-413)")
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(OUT)
