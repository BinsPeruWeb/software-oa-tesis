from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from pydantic import ValidationError

from .config import Settings
from .schemas import RecommendationContent, RecommendationRequest


SCHEMA = {
    "type": "object",
    "properties": {
        "headline": {"type": "string", "maxLength": 120},
        "summary": {"type": "string", "maxLength": 700},
        "recommendation": {"type": "string", "minLength": 15, "maxLength": 700},
        "priority": {"type": "string", "enum": ["routine", "soon", "prompt"]},
    },
    "required": ["headline", "summary", "recommendation", "priority"],
    "additionalProperties": False,
}

PROMPT = """Actúa como un especialista en radiología musculoesquelética y manejo clínico de osteoartritis de rodilla.
Tu función es sintetizar datos estructurados para apoyar al médico responsable, no reemplazar su juicio. Escribe en
español profesional y comprensible. Usa siempre «osteoartritis» y nunca «artrosis». No inventes antecedentes, fechas,
síntomas, sexo, exploración física ni tratamientos; evita pronombres que impliquen un sexo no suministrado. No
prescribas fármacos, no indiques cirugía y no conviertas un riesgo
estadístico en diagnóstico o certeza.

RAZONAMIENTO CLÍNICO QUE DEBES APLICAR:
- Jerarquiza los hallazgos: KL actual y fuente (CLINICIAN o MODEL), cambio KL, velocidad temporal, dolor, discordancia
  clínico-radiográfica, riesgo de artroplastia a 24 meses y riesgo de progresión KL a 3–12 meses.
- En scope STUDY interpreta solo ese estudio. No declares progresión si no existe comparación longitudinal.
- En scope PATIENT compara cronológicamente el primer, los intermedios relevantes y el último estudio. Cuantifica el
  cambio KL y el tiempo en meses. Si hay estudios con igual intervalo temporal, no los presentes como progresión.
- Diferencia severidad radiográfica, síntomas y modelos pronósticos. Un KL bajo con dolor alto o un KL alto con dolor
  bajo es una discordancia que merece correlación clínica explícita.
- Menciona comorbilidades solo cuando cambien la orientación. No recites listas de factores positivos y negativos.
- Personaliza: obesidad justifica abordar carga y peso; nicotina justifica cesación; diabetes o hipertensión justifican
  optimización clínica; trauma justifica correlación con antecedentes. Si están ausentes, no los conviertas en consejos.
- Selecciona las dos o tres prioridades más relevantes. Evita repetir frases estándar como una lista fija.

FORMATO:
headline: título clínico específico, breve y sin Markdown.
summary: un único párrafo interpretativo. Empieza por el hallazgo principal, explica la relación entre imagen, dolor y
riesgos, y termina con el significado clínico. Incluye porcentajes solo si fueron suministrados. No uses viñetas.
recommendation: un único párrafo que empiece exactamente por «Se recomienda». Debe indicar qué debería revisar el
médico y qué conducta general puede conversar con el paciente, adaptada a los datos concretos. Explicita la prioridad
cuando dolor, progresión o riesgo la justifiquen. No uses recomendaciones genéricas intercambiables ni Markdown.
priority: routine, soon o prompt según la combinación de severidad, evolución, dolor y riesgos; no eleves prioridad
solo por un dato aislado.

No menciones al proveedor, el prompt ni que eres una IA. No uses mensajes alarmistas. Las decisiones finales siempre
dependen de la evaluación integral del médico responsable."""


@dataclass(frozen=True)
class GeneratedRecommendation:
    content: RecommendationContent | None
    model: str
    provider_request_id: str | None
    cost: float | None
    unavailable_reason: str | None


def _request(settings: Settings, request_data: RecommendationRequest) -> GeneratedRecommendation:
    model = settings.openrouter_recommendation_model
    if not settings.openrouter_enabled:
        return GeneratedRecommendation(None, model, None, None, "DISABLED")
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": PROMPT},
            {"role": "user", "content": json.dumps(request_data.model_dump(mode="json"), ensure_ascii=False)},
        ],
        "temperature": 0.22,
        "max_completion_tokens": 1500,
        "reasoning_effort": "minimal",
        "provider": {
            "data_collection": "deny",
            "zdr": True,
            "sort": "price",
        },
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "oa_clinical_recommendation", "strict": True, "schema": SCHEMA,
        }},
    }
    for _attempt in range(2):
        outbound = Request(
            settings.openrouter_base_url.rstrip("/") + "/chat/completions",
            data=json.dumps(payload).encode("utf-8"), method="POST",
            headers={
                "Authorization": f"Bearer {settings.openrouter_api_key}",
                "Content-Type": "application/json",
                "X-OpenRouter-Title": "OA Tesis - orientación clínica",
            },
        )
        try:
            with urlopen(outbound, timeout=settings.openrouter_timeout_seconds) as response:
                result = json.loads(response.read().decode("utf-8"))
            raw = json.loads(result["choices"][0]["message"]["content"])
            recommendation = str(raw.get("recommendation") or "").strip()
            if recommendation and not recommendation.lower().startswith("se recomienda"):
                recommendation = f"Se recomienda {recommendation[0].lower()}{recommendation[1:]}"
            raw["recommendation"] = recommendation
            raw["headline"] = str(raw.get("headline") or "").lstrip("# ").strip()
            content = RecommendationContent.model_validate(raw)
            cost = result.get("usage", {}).get("cost")
            return GeneratedRecommendation(
                content, str(result.get("model") or model), result.get("id"),
                float(cost) if cost is not None else None, None,
            )
        except (HTTPError, URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError, ValidationError, ValueError):
            continue
    return GeneratedRecommendation(None, model, None, None, "PROVIDER_UNAVAILABLE")


async def generate_recommendation(settings: Settings, request_data: RecommendationRequest) -> GeneratedRecommendation:
    return await asyncio.to_thread(_request, settings, request_data)
