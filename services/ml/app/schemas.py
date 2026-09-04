from __future__ import annotations

from datetime import date
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, StrictBool, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class KneeSide(StrEnum):
    LEFT = "L"
    RIGHT = "R"


class ImageSourceType(StrEnum):
    DICOM_BILATERAL = "DICOM_BILATERAL"
    RASTER_BILATERAL = "RASTER_BILATERAL"
    RASTER_SINGLE_ROI = "RASTER_SINGLE_ROI"


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
