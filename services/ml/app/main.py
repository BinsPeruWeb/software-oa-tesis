from __future__ import annotations

import hmac
import base64
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .config import settings
from .engine import (
    LSTM_THRESHOLD,
    MODEL_VERSION,
    XGB_FEATURES,
    XGB_THRESHOLD,
    ModelSuite,
    json_safe_features,
)
from .imaging import detect_image, prepare_image
from .integrity import verify_model_package
from .schemas import (
    ArthroplastyRequest,
    ExplanationResponse,
    ImagePreflightResponse,
    ImageRenderResponse,
    ImageSourceType,
    KlResponse,
    KneeSide,
    ProgressionRequest,
    RiskResponse,
)
from .vision import assess_image, classify_review_status


logger = logging.getLogger("oa.ml")
state: dict[str, object] = {"suite": None, "ready": False, "load_error": None}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    try:
        settings.validate()
        verify_model_package(settings.model_root)
        state["suite"] = ModelSuite(settings.model_root, settings.device)
        state["ready"] = True
        logger.info("Modelos OA verificados y cargados")
    except Exception as exc:
        state["load_error"] = type(exc).__name__
        logger.exception("El servicio no está listo: falló la carga segura de modelos")
    yield
    state["suite"] = None
    state["ready"] = False


app = FastAPI(
    title="OA private inference service",
    version="1.0.0",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
    lifespan=lifespan,
)


@app.middleware("http")
async def correlation_id(request: Request, call_next):
    supplied = request.headers.get("x-correlation-id", "")
    request.state.correlation_id = supplied[:128] if supplied else str(uuid.uuid4())
    response = await call_next(request)
    response.headers["x-correlation-id"] = request.state.correlation_id
    response.headers["cache-control"] = "no-store"
    return response


@app.exception_handler(ValueError)
async def validation_error(_request: Request, exc: ValueError):
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(RequestValidationError)
async def request_validation_error(_request: Request, exc: RequestValidationError):
    safe = [
        {"location": list(error.get("loc", ())), "message": error.get("msg", "Entrada inválida"), "type": error.get("type", "validation")}
        for error in exc.errors()
    ]
    return JSONResponse(status_code=422, content={"detail": safe})


def authorize(x_service_token: str = Header(default="")) -> None:
    if not settings.service_token or not hmac.compare_digest(x_service_token, settings.service_token):
        raise HTTPException(status_code=401, detail="Servicio no autorizado")


def suite() -> ModelSuite:
    loaded = state.get("suite")
    if not state.get("ready") or not isinstance(loaded, ModelSuite):
        raise HTTPException(status_code=503, detail="Modelos no disponibles")
    return loaded


async def read_limited(upload: UploadFile) -> bytes:
    content = await upload.read(settings.max_upload_bytes + 1)
    await upload.close()
    if not content:
        raise ValueError("El archivo está vacío")
    if len(content) > settings.max_upload_bytes:
        raise ValueError("El archivo excede el límite permitido")
    return content


async def prepared_upload(
    image: UploadFile,
    source_type: ImageSourceType,
    knee_side: KneeSide,
    projection_confirmed: bool,
    weight_bearing_confirmed: bool,
    orientation_confirmed: bool,
    metadata_inverted: bool,
    horizontal_flip: bool,
):
    content = await read_limited(image)
    return prepare_image(
        content=content,
        content_type=(image.content_type or "application/octet-stream").lower(),
        source_type=source_type,
        side=knee_side,
        projection_confirmed=projection_confirmed,
        weight_bearing_confirmed=weight_bearing_confirmed,
        orientation_confirmed=orientation_confirmed,
        metadata_inverted=metadata_inverted,
        horizontal_flip=horizontal_flip,
    )


@app.get("/v1/health/live")
def live():
    return {"status": "live"}


@app.get("/v1/health/ready")
def ready():
    if not state.get("ready"):
        raise HTTPException(status_code=503, detail="not ready")
    return {"status": "ready", "model_version": MODEL_VERSION, "device": settings.device}


@app.get("/v1/models", dependencies=[Depends(authorize)])
def models_info(model_suite: ModelSuite = Depends(suite)):
    return {
        "model_version": MODEL_VERSION,
        "hashes": model_suite.model_hashes,
        "xgboost_features": XGB_FEATURES,
        "thresholds": {"arthroplasty_24m": XGB_THRESHOLD, "progression_3_12m": LSTM_THRESHOLD},
        "device": str(model_suite.device),
    }


@app.post("/v1/images/preflight", response_model=ImagePreflightResponse, dependencies=[Depends(authorize)])
async def image_preflight(image: UploadFile = File(...)):
    content = await read_limited(image)
    detected = detect_image(content)
    vision = await assess_image(settings, detected.external_review_png)
    assessment = vision.assessment
    review_status = classify_review_status(assessment)
    if assessment is None:
        layout = "uncertain"
    else:
        layout = assessment.coverage
    supported = not (detected.file_kind == "DICOM" and layout == "single")
    suggested_source = None
    if layout in {"bilateral", "single"}:
        if detected.file_kind == "DICOM" and layout == "bilateral":
            suggested_source = ImageSourceType.DICOM_BILATERAL
        elif detected.file_kind == "RASTER" and layout == "bilateral":
            suggested_source = ImageSourceType.RASTER_BILATERAL
        elif detected.file_kind == "RASTER" and layout == "single":
            suggested_source = ImageSourceType.RASTER_SINGLE_ROI
    return {
        "input_hash": detected.input_hash,
        "file_kind": detected.file_kind,
        "media_type": detected.media_type,
        "exam_date": detected.exam_date,
        "preview_base64_png": base64.b64encode(detected.preview_png).decode("ascii"),
        "review_status": review_status,
        "suggested_layout": layout,
        "suggested_source_type": suggested_source,
        "supported": supported,
        "assessment": assessment.model_dump() if assessment else None,
        "provider_model": vision.model,
        "provider_request_id": vision.provider_request_id,
        "cost_usd": vision.cost,
        "external_preview_metadata_stripped": True,
        "external_preview_borders_masked": True,
    }


@app.post("/v1/images/render", response_model=ImageRenderResponse, dependencies=[Depends(authorize)])
async def image_render(image: UploadFile = File(...)):
    content = await read_limited(image)
    detected = detect_image(content)
    return {
        "input_hash": detected.input_hash,
        "file_kind": detected.file_kind,
        "preview_base64_png": base64.b64encode(detected.preview_png).decode("ascii"),
    }


@app.post("/v1/kl/predict", response_model=KlResponse, dependencies=[Depends(authorize)])
async def predict_kl(
    image: UploadFile = File(...),
    source_type: ImageSourceType = Form(...),
    knee_side: KneeSide = Form(...),
    projection_confirmed: bool = Form(...),
    weight_bearing_confirmed: bool = Form(...),
    orientation_confirmed: bool = Form(...),
    metadata_inverted: bool = Form(False),
    horizontal_flip: bool = Form(False),
    model_suite: ModelSuite = Depends(suite),
):
    started = time.perf_counter()
    prepared = await prepared_upload(
        image, source_type, knee_side, projection_confirmed, weight_bearing_confirmed,
        orientation_confirmed, metadata_inverted, horizontal_flip,
    )
    result = model_suite.kl.predict(prepared.roi)
    return {
        **result,
        "model_version": MODEL_VERSION,
        "model_hashes": {
            "resnet50": model_suite.model_hashes["resnet50"],
            "densenet121": model_suite.model_hashes["densenet121"],
        },
        "input_hash": prepared.input_hash,
        "input_type": source_type,
        "pipeline": prepared.pipeline,
        "knee_side": knee_side,
        "device": str(model_suite.device),
        "duration_ms": (time.perf_counter() - started) * 1000,
    }


@app.post(
    "/v1/kl/explanations",
    response_model=ExplanationResponse,
    dependencies=[Depends(authorize)],
)
async def explain_kl(
    image: UploadFile = File(...),
    source_type: ImageSourceType = Form(...),
    knee_side: KneeSide = Form(...),
    projection_confirmed: bool = Form(...),
    weight_bearing_confirmed: bool = Form(...),
    orientation_confirmed: bool = Form(...),
    metadata_inverted: bool = Form(False),
    horizontal_flip: bool = Form(False),
    target_kl: int | None = Form(None),
    model_suite: ModelSuite = Depends(suite),
):
    prepared = await prepared_upload(
        image, source_type, knee_side, projection_confirmed, weight_bearing_confirmed,
        orientation_confirmed, metadata_inverted, horizontal_flip,
    )
    target, overlays = model_suite.kl.explain(prepared.roi, target_kl)
    return {
        "target_kl": target,
        "input_hash": prepared.input_hash,
        "model_version": MODEL_VERSION,
        "overlays_base64_png": overlays,
    }


@app.post(
    "/v1/risks/arthroplasty",
    response_model=RiskResponse,
    dependencies=[Depends(authorize)],
)
def arthroplasty_risk(request: ArthroplastyRequest, model_suite: ModelSuite = Depends(suite)):
    probability, features = model_suite.arthroplasty.predict(request)
    return {
        "model_version": MODEL_VERSION,
        "target": "tamizaje experimental de artroplastia",
        "horizon": "24 meses",
        "probability": probability,
        "threshold": XGB_THRESHOLD,
        "screen_positive": probability >= XGB_THRESHOLD,
        "model_hash": model_suite.model_hashes["xgboost"],
        "features": json_safe_features(features),
    }


@app.post(
    "/v1/risks/progression",
    response_model=RiskResponse,
    dependencies=[Depends(authorize)],
)
def progression_risk(request: ProgressionRequest, model_suite: ModelSuite = Depends(suite)):
    probability = model_suite.progression.predict(request)
    return {
        "model_version": MODEL_VERSION,
        "target": "aumento de al menos un grado KL",
        "horizon": "3–12 meses",
        "probability": probability,
        "threshold": LSTM_THRESHOLD,
        "screen_positive": probability >= LSTM_THRESHOLD,
        "model_hash": model_suite.model_hashes["lstm"],
        "features": None,
    }
