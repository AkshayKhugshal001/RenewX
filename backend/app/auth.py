"""Identify the logged-in user from the Supabase access token sent by the frontend."""
import hashlib
import threading
import time

import httpx
from fastapi import Header, HTTPException

from . import config

# A verified token is remembered for a short time, so consecutive requests (a page loading several things,
# the dashboard + environment) don't each make a round trip to Supabase. Only a hash of the token is kept.
# A signed-out token can therefore still work for at most CACHE_S seconds.
CACHE_S = 60
_cache: dict[str, tuple[str, float]] = {}  # sha256(token) -> (user id, expires at)
_lock = threading.Lock()


def get_user_id(authorization: str | None = Header(default=None)) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Not signed in.")
    token = authorization.split(" ", 1)[1].strip()
    digest = hashlib.sha256(token.encode()).hexdigest()
    now = time.monotonic()
    with _lock:
        hit = _cache.get(digest)
        if hit and hit[1] > now:
            return hit[0]

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
    user_id = res.json()["id"]
    with _lock:
        if len(_cache) > 1000:  # tiny prototype; just drop everything rather than track ages
            _cache.clear()
        _cache[digest] = (user_id, now + CACHE_S)
    return user_id
