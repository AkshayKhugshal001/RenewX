"""Identify the logged-in user from the Supabase access token sent by the frontend."""
import httpx
from fastapi import Header, HTTPException

from . import config


def get_user_id(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not signed in.")
    token = authorization.split(" ", 1)[1].strip()

    # Supabase checks the token for us (signature + expiry) and returns the user.
    try:
        res = httpx.get(
            f"{config.supabase_url()}/auth/v1/user",
            headers={"Authorization": f"Bearer {token}", "apikey": config.supabase_anon_key()},
            timeout=10,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=503, detail="Could not reach Supabase to verify your login.")
    if res.status_code != 200:
        raise HTTPException(status_code=401, detail="Your session has expired. Please sign in again.")
    return res.json()["id"]
