"""
Minimal async client for the Gemini REST API (generateContent).

Calls the API directly with httpx — the google-generativeai SDK is deprecated.
Model is configurable with GEMINI_MODEL; transient overload (429/503) is retried.
Returns None whenever Gemini is unavailable, so callers can fall back.
"""
import asyncio
import logging
import os

import httpx

logger = logging.getLogger(__name__)

_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_RETRY_STATUS = {429, 500, 503}
_RETRIES = 2


def available() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


async def generate(
    prompt: str,
    system: str,
    *,
    max_tokens: int = 512,
    temperature: float = 0.2,
    json_mode: bool = False,
) -> str | None:
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    model = os.getenv("GEMINI_MODEL", "gemini-3.8-flash")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "maxOutputTokens": max_tokens},
    }
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"

    async with httpx.AsyncClient(timeout=25.0) as client:
        for attempt in range(_RETRIES + 1):
            try:
                res = await client.post(_URL.format(model=model), json=body, headers={"x-goog-api-key": api_key})
            except httpx.HTTPError as exc:
                logger.warning("Gemini request failed: %r", exc)
                return None
            if res.status_code == 200:
                try:
                    parts = res.json()["candidates"][0]["content"]["parts"]
                    return "".join(p.get("text", "") for p in parts).strip() or None
                except (KeyError, IndexError, ValueError):
                    logger.warning("Gemini returned no text: %s", res.text[:200])
                    return None
            if res.status_code in _RETRY_STATUS and attempt < _RETRIES:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            logger.warning("Gemini HTTP %s: %s", res.status_code, res.text[:200])
            return None
    return None
