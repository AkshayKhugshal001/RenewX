"""Small LLM provider layer (no SDK – plain HTTPS with httpx). Gemini by default, Groq switchable via .env.

  LLM_PROVIDER=gemini | groq                     (default gemini)
  GEMINI_API_KEY=…   GEMINI_MODEL=gemini-flash-lite-latest   GEMINI_FALLBACK_MODEL=gemini-flash-latest
  (Flash-Lite answers in ~2–6 s without "thinking"; on the free tier Flash was often overloaded or took > 60 s.)
  GROQ_API_KEY=…     GROQ_MODEL=<a current Groq chat model>

The LLM only explains (chat, recommendation wording). It never makes decisions or produces the numbers.
Keys stay on the server and are never logged or returned.
"""
from __future__ import annotations

import json
import os
import time

import httpx

TIMEOUT_S = 30
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
RETRY_STATUS = {429, 500, 502, 503, 504}


class LLMError(RuntimeError):
    """Message is safe to show to the user."""


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def provider() -> str:
    return _env("LLM_PROVIDER", "gemini").lower()


def enabled() -> bool:
    return bool(_env("GROQ_API_KEY") if provider() == "groq" else _env("GEMINI_API_KEY"))


def status() -> dict:
    p = provider()
    model = _env("GROQ_MODEL") if p == "groq" else _env("GEMINI_MODEL", "gemini-flash-lite-latest")
    return {"enabled": enabled(), "provider": p, "model": model}


def generate(system: str, messages: list[dict], *, max_tokens: int = 900, temperature: float = 0.3,
             json_output: bool = False) -> tuple[str, str]:
    """messages: [{role: 'user'|'assistant', content}] → (text, model used)."""
    if not enabled():
        raise LLMError("The AI assistant is not configured (no API key on the server).")
    if provider() == "groq":
        return _groq(system, messages, max_tokens, temperature, json_output)
    return _gemini(system, messages, max_tokens, temperature, json_output)


def _gemini(system, messages, max_tokens, temperature, json_output):
    key = _env("GEMINI_API_KEY")
    models = [_env("GEMINI_MODEL", "gemini-flash-lite-latest"), _env("GEMINI_FALLBACK_MODEL", "gemini-flash-latest")]
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "model" if m["role"] == "assistant" else "user", "parts": [{"text": m["content"]}]}
                     for m in messages],
        "generationConfig": {"maxOutputTokens": max_tokens, "temperature": temperature,
                             **({"responseMimeType": "application/json"} if json_output else {})},
    }
    last = None
    for model in dict.fromkeys(m for m in models if m):          # unique, in order
        try:
            r = httpx.post(GEMINI_URL.format(model=model), headers={"x-goog-api-key": key}, json=body, timeout=TIMEOUT_S)
        except httpx.HTTPError:
            last = "network"
            continue
        if r.status_code == 200:
            data = r.json()
            cand = (data.get("candidates") or [{}])[0]
            text = "".join(p.get("text", "") for p in cand.get("content", {}).get("parts", []))
            if text.strip():
                return text.strip(), data.get("modelVersion") or model
            last = "empty"
            continue
        last = r.status_code
        if r.status_code not in RETRY_STATUS and r.status_code != 404:
            break
        time.sleep(0.5)
    raise LLMError(_friendly(last))


def _groq(system, messages, max_tokens, temperature, json_output):
    model = _env("GROQ_MODEL")
    if not model:
        raise LLMError("Set GROQ_MODEL in backend/.env to use Groq.")
    body = {"model": model, "max_tokens": max_tokens, "temperature": temperature,
            "messages": [{"role": "system", "content": system}] + messages,
            **({"response_format": {"type": "json_object"}} if json_output else {})}
    try:
        r = httpx.post(GROQ_URL, headers={"Authorization": f"Bearer {_env('GROQ_API_KEY')}"}, json=body, timeout=TIMEOUT_S)
    except httpx.HTTPError:
        raise LLMError(_friendly("network"))
    if r.status_code != 200:
        raise LLMError(_friendly(r.status_code))
    return r.json()["choices"][0]["message"]["content"].strip(), model


def _friendly(code) -> str:
    if code == 429:
        return "The free AI quota is busy right now – please try again in a minute."
    if code in (500, 502, 503, 504):
        return "The AI service is overloaded at the moment – please try again shortly."
    if code in (401, 403):
        return "The AI service rejected the API key – check the key in backend/.env."
    if code == "network":
        return "Could not reach the AI service – check the internet connection of the server."
    return "The AI assistant could not answer right now."


def parse_json(text: str):
    """JSON from a model reply (tolerates ```json fences)."""
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(t)
