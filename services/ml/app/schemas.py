from __future__ import annotations

from datetime import date
from enum import StrEnum
import re
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KneeSide(StrEnum):
    LEFT = "L"
    RIGHT = "R"


class ImageSourceType(StrEnum):
    DICOM_BILATERAL = "DICOM_BILATERAL"
    RASTER_BILATERAL = "RASTER_BILATERAL"
    RASTER_SINGLE_ROI = "RASTER_SINGLE_ROI"


class ImagePreflightResponse(StrictModel):
    input_hash: str
    file_kind: Literal["DICOM", "RASTER"]
    media_type: Literal["application/dicom", "image/png", "image/jpeg"]
    exam_date: str | None
    preview_base64_png: str
    review_status: Literal["ACCEPTED", "REJECTED", "REVIEW_REQUIRED", "UNAVAILABLE"]
    suggested_layout: Literal["bilateral", "single", "uncertain"]
    suggested_source_type: ImageSourceType | None
    supported: bool
    assessment: dict | None
    provider_model: str
    provider_request_id: str | None
    cost_usd: float | None
    external_preview_metadata_stripped: bool
    external_preview_borders_masked: bool


class ImageRenderResponse(StrictModel):
    input_hash: str
    file_kind: Literal["DICOM", "RASTER"]
    preview_base64_png: str


class Sex(StrEnum):
    FEMALE = "female"
    MALE = "male"


class ClinicalFlags(StrictModel):
    obesity: StrictBool
    diabetes: StrictBool
    hypertension: StrictBool
    nicotine_use: StrictBool
    trauma_lower_extremity: StrictBool


class PriorExam(StrictModel):
    date: date
    KLG: int = Field(ge=0, le=4)
    knee_side: KneeSide


class ArthroplastyRequest(ClinicalFlags):
    date_of_birth: date
    exam_date: date
    current_kl: int = Field(ge=0, le=4)
    pain_score: float | None = Field(default=None, ge=0, le=10)
    sex: Sex | None = None
    knee_side: KneeSide
    prior_exams: list[PriorExam] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_dates_and_knees(self):
        if self.exam_date <= self.date_of_birth:
            raise ValueError("exam_date debe ser posterior a date_of_birth")
        for exam in self.prior_exams:
            if exam.date >= self.exam_date:
                raise ValueError("Los antecedentes deben ser anteriores al examen índice")
            if exam.knee_side != self.knee_side:
                raise ValueError("No se pueden mezclar antecedentes de otra rodilla")
        if len({exam.date for exam in self.prior_exams}) != len(self.prior_exams):
            raise ValueError("No puede haber dos antecedentes en la misma fecha")
        return self


class ProgressionTimepoint(ClinicalFlags):
    date: date
    KLG: int = Field(ge=0, le=4)
    age_at_exam: float = Field(gt=0, le=130)
    pain_score: float | None = Field(default=None, ge=0, le=10)
    knee_side: KneeSide


class ProgressionRequest(StrictModel):
    patient_reference: str = Field(min_length=1, max_length=128)
    observations: list[ProgressionTimepoint]

    @model_validator(mode="after")
    def validate_pair(self):
        if len(self.observations) != 2:
            raise ValueError("LSTM requiere exactamente dos observaciones")
        ordered = sorted(self.observations, key=lambda item: item.date)
        if ordered[0].date == ordered[1].date:
            raise ValueError("t1 y t2 deben tener fechas diferentes")
        if ordered[0].knee_side != ordered[1].knee_side:
            raise ValueError("t1 y t2 deben corresponder a la misma rodilla")
        if ordered[1].KLG == 4:
            raise ValueError("LSTM no es aplicable cuando t2 tiene KL4")
        return self


class ProbabilityMap(StrictModel):
    KL0: float
    KL1: float
    KL2: float
    KL3: float
    KL4: float


class KlResponse(StrictModel):
    model_version: str
    predicted_kl: int
    confidence: float
    probabilities: ProbabilityMap
    member_probabilities: dict[str, ProbabilityMap]
    model_hashes: dict[str, str]
    input_hash: str
    input_type: ImageSourceType
    pipeline: str
    knee_side: KneeSide
    device: str
    duration_ms: float


class ExplanationResponse(StrictModel):
    target_kl: int
    input_hash: str
    model_version: str
    overlays_base64_png: dict[str, str]


class RiskResponse(StrictModel):
    model_version: str
    target: str
    horizon: str
    probability: float
    threshold: float
    screen_positive: bool
    model_hash: str
    features: dict[str, float | int | None] | None = None


class RecommendationStudy(ClinicalFlags):
    sequence: int = Field(ge=1, le=50)
    months_since_first: float = Field(ge=0, le=1200)
    knee_side: KneeSide
    kl_grade: int = Field(ge=0, le=4)
    confidence: float | None = Field(default=None, ge=0, le=1)
    pain_score: float | None = Field(default=None, ge=0, le=10)
    arthroplasty_probability: float | None = Field(default=None, ge=0, le=1)
    progression_probability: float | None = Field(default=None, ge=0, le=1)
    age_at_exam: float | None = Field(default=None, ge=0, le=130)
    kl_source: Literal["CLINICIAN", "MODEL"]


class RecommendationRequest(StrictModel):
    scope: Literal["STUDY", "PATIENT"]
    studies: list[RecommendationStudy] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_scope(self):
        if self.scope == "STUDY" and len(self.studies) != 1:
            raise ValueError("Una recomendación de estudio requiere exactamente un análisis")
        if self.scope == "PATIENT" and len(self.studies) < 2:
            raise ValueError("Una recomendación longitudinal requiere al menos dos análisis")
        if [item.sequence for item in self.studies] != list(range(1, len(self.studies) + 1)):
            raise ValueError("Los análisis deben enviarse en orden cronológico")
        return self


class RecommendationContent(StrictModel):
    headline: str = Field(min_length=1, max_length=120)
    summary: str = Field(min_length=1, max_length=700)
    recommendation: str = Field(min_length=15, max_length=700, pattern=r"^Se recomienda\b")
    priority: Literal["routine", "soon", "prompt"]

    @field_validator("headline", "summary", "recommendation", mode="before")
    @classmethod
    def use_osteoarthritis_term(cls, value: object):
        if not isinstance(value, str):
            return value
        return re.sub(
            r"\bartrosis\b",
            lambda match: "Osteoartritis" if match.group(0)[0].isupper() else "osteoartritis",
            value.strip(),
            flags=re.IGNORECASE,
        )


class RecommendationResponse(StrictModel):
    available: bool
    content: RecommendationContent | None = None
    provider_model: str
    provider_request_id: str | None = None
    cost_usd: float | None = None
    unavailable_reason: str | None = None
    error_code: str | None = None
    error_message: str | None = None
