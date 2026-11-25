"""RenewX API.  Run from backend/:  .venv\\Scripts\\uvicorn app.main:app --reload"""
from typing import Literal
from uuid import UUID

from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from . import config, db, forecast_service, store
from .auth import get_user_id
from .cleaning import CsvError
from .pipeline import PlantNotFound, process_upload
from .weather import WeatherError

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
