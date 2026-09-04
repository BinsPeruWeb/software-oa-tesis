from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .config import Settings


class VisionAssessment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_radiograph: bool
    anatomy: str
    view: str
    coverage: str
    laterality: str
    weight_bearing: str
    quality: str
    confidence: float = Field(ge=0, le=1)
    reason_codes: list[str] = Field(max_length=5)


@dataclass(frozen=True)
class VisionResult:
    assessment: VisionAssessment | None
    model: str
    provider_request_id: str | None
    cost: float | None
    unavailable_reason: str | None


SCHEMA = {
    "type": "object",
    "properties": {
        "is_radiograph": {"type": "boolean"},
        "anatomy": {"type": "string", "enum": ["knee", "other", "uncertain"]},
        "view": {"type": "string", "enum": ["frontal_ap", "lateral_or_axial", "other", "uncertain"]},
        "coverage": {"type": "string", "enum": ["bilateral", "single", "uncertain"]},
        "laterality": {"type": "string", "enum": ["left", "right", "bilateral", "unknown"]},
        "weight_bearing": {"type": "string", "enum": ["likely", "unlikely", "unknown"]},
        "quality": {"type": "string", "enum": ["adequate", "limited", "unusable"]},
        "confidence": {"type": "number", "minimum": 0, "maximum": 1},
        "reason_codes": {
            "type": "array", "maxItems": 5,
            "items": {"type": "string", "enum": [
                "not_radiograph", "not_knee", "non_frontal_view", "uncertain_view",
                "single_knee", "bilateral_knees", "poor_quality", "cropped_joint", "orientation_uncertain",
            ]},
        },
    },
    "required": ["is_radiograph", "anatomy", "view", "coverage", "laterality", "weight_bearing", "quality", "confidence", "reason_codes"],
    "additionalProperties": False,
}


PROMPT = """Classify this image only for input validation in a knee osteoarthritis research app.
Do not diagnose, estimate Kellgren-Lawrence grade, identify a person, or transcribe text.
Determine conservatively whether it is a radiograph, whether it shows knee anatomy, whether the view is frontal/AP,
whether it contains both knees or one knee, and whether image quality is usable. Weight-bearing and laterality may be
unknown; never guess them from text markers. Return only the required JSON schema."""


def _request(settings: Settings, png: bytes) -> VisionResult:
    if not settings.openrouter_enabled:
        return VisionResult(None, settings.openrouter_model, None, None, "DISABLED")
    image_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    payload = {
        "model": settings.openrouter_model,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": image_url, "detail": "low"}},
        ]}],
        "temperature": 0,
        "max_tokens": 250,
        "provider": {"require_parameters": True, "data_collection": "deny", "zdr": True},
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "knee_radiograph_preflight", "strict": True, "schema": SCHEMA,
        }},
    }
    request = Request(
        settings.openrouter_base_url.rstrip("/") + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"), method="POST",
        headers={
            "Authorization": f"Bearer {settings.openrouter_api_key}",
            "Content-Type": "application/json",
            "X-OpenRouter-Title": "OA Tesis - validación de entrada",
        },
    )
    try:
        with urlopen(request, timeout=settings.openrouter_timeout_seconds) as response:
            result = json.loads(response.read().decode("utf-8"))
        content = result["choices"][0]["message"]["content"]
        assessment = VisionAssessment.model_validate_json(content)
        cost = result.get("usage", {}).get("cost")
        return VisionResult(assessment, str(result.get("model") or settings.openrouter_model), result.get("id"), float(cost) if cost is not None else None, None)
    except (HTTPError, URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, ValidationError, ValueError):
        return VisionResult(None, settings.openrouter_model, None, None, "PROVIDER_UNAVAILABLE")


async def assess_image(settings: Settings, png: bytes) -> VisionResult:
    return await asyncio.to_thread(_request, settings, png)
