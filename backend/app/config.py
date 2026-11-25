"""Settings read from backend/.env."""
import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

MAX_UPLOAD_MB = 50


def _required(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing {name} in backend/.env (see .env.example).")
    return value


@lru_cache
def database_url() -> str:
    return _required("DATABASE_URL")


@lru_cache
def supabase_url() -> str:
    return _required("SUPABASE_URL").rstrip("/")


@lru_cache
def supabase_anon_key() -> str:
    return _required("SUPABASE_ANON_KEY")


def frontend_origins() -> list[str]:
    raw = os.getenv("FRONTEND_ORIGINS", "http://localhost:5173")
    return [o.strip() for o in raw.split(",") if o.strip()]
