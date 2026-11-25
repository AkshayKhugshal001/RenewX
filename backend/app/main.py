"""RenewX API.  Run from backend/:  .venv\\Scripts\\uvicorn app.main:app --reload"""
import logging
from typing import Literal
from uuid import UUID

from datetime import date

import hmac

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import assistant, anomaly_service, config, daily_refresh, db, environment, forecast_service, llm, panel_vision, recommendation_service, report_pdf, reports, soiling_service, store
from .auth import get_user_id
from .cleaning import CsvError
from .pipeline import PlantNotFound, process_upload
from .weather import WeatherError

log = logging.getLogger(__name__)

app = FastAPI(title="RenewX API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.frontend_origins(),
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/plants/{plant_id}/uploads")
def upload_plant_csv(
    plant_id: UUID,
    file: UploadFile = File(...),
    kind: Literal["historical", "daily"] = Form("daily"),
    mode: Literal["skip", "replace"] = Form("skip"),
    user_id: str = Depends(get_user_id),
):
    """Upload a CSV for one plant. Rows are added to existing data; stats and alarms are recalculated."""
    if not (file.filename or "").lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only .csv files are supported.")
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise HTTPException(status_code=413, detail=f"File is too large (max {config.MAX_UPLOAD_MB} MB).")

    try:
        return process_upload(str(plant_id), user_id, file.filename, data, kind, mode)
    except PlantNotFound:
        raise HTTPException(status_code=404, detail="Plant not found.")
    except CsvError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/plants/{plant_id}/forecast/refresh")
def refresh_forecast(plant_id: UUID, user_id: str = Depends(get_user_id)):
    """Fetch weather, retrain this plant's models and issue a new forecast."""
    with db.connect() as conn:
        plant = store.get_plant(conn, str(plant_id), user_id)
        if plant is None:
            raise HTTPException(status_code=404, detail="Plant not found.")
        try:
            return forecast_service.refresh(conn, plant)
        except WeatherError as e:
            raise HTTPException(status_code=502, detail=str(e))


@app.post("/plants/{plant_id}/anomalies/detect")
def detect_anomalies(plant_id: UUID, user_id: str = Depends(get_user_id)):
    """Re-run ML anomaly detection on all of this plant's data."""
    with db.connect() as conn:
        plant = store.get_plant(conn, str(plant_id), user_id)
        if plant is None:
            raise HTTPException(status_code=404, detail="Plant not found.")
        return anomaly_service.run(conn, plant)


@app.post("/plants/{plant_id}/cleaning/analyse")
def analyse_cleaning(plant_id: UUID, user_id: str = Depends(get_user_id)):
    """Re-run the soiling, cleaning and cooling analysis (e.g. after a cleaning task or a new forecast)."""
    with db.connect() as conn:
        plant = store.get_plant(conn, str(plant_id), user_id)
        if plant is None:
            raise HTTPException(status_code=404, detail="Plant not found.")
        result = soiling_service.run(conn, plant)
        try:   # the cleaning decision feeds the recommendations
            result["recommendations"] = recommendation_service.run(conn, plant)
        except Exception:
            log.exception("Recommendations failed after cleaning analysis")
        return result


MAX_PHOTO_MB = 8


def _read_photo(f: UploadFile) -> bytes:
    data = f.file.read(MAX_PHOTO_MB * 1024 * 1024 + 1)
    if len(data) > MAX_PHOTO_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Photo is too large (max {MAX_PHOTO_MB} MB).")
    return data


@app.post("/plants/{plant_id}/panel-photos/analyse")
def analyse_panel_photo(
    plant_id: UUID,
    image: UploadFile = File(...),
    reference: UploadFile | None = File(None),
    user_id: str = Depends(get_user_id),
):
    """Soiling check of a panel photo (simulated camera capture), optionally against a clean reference photo.
    Stateless: the browser stores the photo and the result."""
    with db.connect() as conn:
        if store.get_plant(conn, str(plant_id), user_id) is None:
            raise HTTPException(status_code=404, detail="Plant not found.")
    try:
        return panel_vision.analyse(_read_photo(image), _read_photo(reference) if reference else None)
    except panel_vision.PhotoError as e:
        raise HTTPException(status_code=422, detail=str(e))


@app.post("/plants/{plant_id}/recommendations/refresh")
def refresh_recommendations(plant_id: UUID, user_id: str = Depends(get_user_id)):
    """Rebuild the AI recommendations from the latest module outputs."""
    with db.connect() as conn:
        plant = store.get_plant(conn, str(plant_id), user_id)
        if plant is None:
            raise HTTPException(status_code=404, detail="Plant not found.")
        return recommendation_service.run(conn, plant)


# ── "Ask RenewX" assistant (LLM; explains only) ────────────────────────
class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=4000)


class ChatRequest(BaseModel):
    plant_id: UUID | None = None
    messages: list[ChatMessage] = Field(min_length=1, max_length=40)


@app.get("/assistant/status")
def assistant_status(user_id: str = Depends(get_user_id)):
    return llm.status()


@app.post("/assistant/chat")
def assistant_chat(req: ChatRequest, user_id: str = Depends(get_user_id)):
    """Answer a question about the app, the selected plant or the project."""
    try:
        assistant.check_rate(user_id)
        with db.connect() as conn:
            plant = store.get_plant(conn, str(req.plant_id), user_id) if req.plant_id else None
            if req.plant_id and plant is None:
                raise HTTPException(status_code=404, detail="Plant not found.")
            return assistant.chat(conn, plant, [m.model_dump() for m in req.messages])
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e))


@app.post("/assistant/issue-draft")
def assistant_issue_draft(req: ChatRequest, user_id: str = Depends(get_user_id)):
    """Summarise the conversation into an issue report the user can edit before submitting."""
    try:
        assistant.check_rate(user_id)
    except llm.LLMError as e:
        raise HTTPException(status_code=429, detail=str(e))
    return assistant.draft_issue([m.model_dump() for m in req.messages])


# ── Environment and reports ─────────────────────────────────────────────
def _owned_plant(conn, plant_id: UUID, user_id: str) -> dict:
    plant = store.get_plant(conn, str(plant_id), user_id)
    if plant is None:
        raise HTTPException(status_code=404, detail="Plant not found.")
    return plant


@app.get("/plants/{plant_id}/environment")
def plant_environment(plant_id: UUID, user_id: str = Depends(get_user_id)):
    """CO₂ avoided with equivalents, water use, site conditions and the ecological indicator."""
    with db.connect() as conn:
        return environment.environment(conn, _owned_plant(conn, plant_id, user_id))


@app.get("/plants/{plant_id}/reports/pdf")
def plant_report_pdf(
    plant_id: UUID,
    start: date = Query(...),
    end: date = Query(...),
    kind: Literal["performance", "maintenance"] = Query("performance"),
    ai_summary: bool = Query(False),
    user_id: str = Depends(get_user_id),
):
    """Downloadable PDF report for a period (max 1 year)."""
    if end < start:
        raise HTTPException(status_code=422, detail="The end date is before the start date.")
    if (end - start).days > 366:
        raise HTTPException(status_code=422, detail="Choose a period of at most one year.")
    with db.connect() as conn:
        plant = _owned_plant(conn, plant_id, user_id)
        data = reports.build(conn, plant, start, end, kind, ai_summary)
    pdf = report_pdf.render(data)
    safe = "".join(ch if ch.isalnum() else "-" for ch in plant["name"]).strip("-")
    name = f"RenewX_{safe}_{kind}_{start}_{end}.pdf"
    return Response(pdf, media_type="application/pdf", headers={"Content-Disposition": f'attachment; filename="{name}"'})


# ── Scheduled daily refresh (GitHub Actions, every morning) ─────────────
@app.post("/internal/daily-refresh")
def scheduled_daily_refresh(x_cron_secret: str = Header(default="")):
    """Refresh forecasts, cleaning analyses and recommendations of all located plants.
    Protected by the CRON_SECRET shared with the scheduler; disabled when CRON_SECRET is not set."""
    secret = config.cron_secret()
    if not secret or not hmac.compare_digest(x_cron_secret.encode(), secret.encode()):
        raise HTTPException(status_code=403, detail="Forbidden.")
    return daily_refresh.run_all()
