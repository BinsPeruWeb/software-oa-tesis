from datetime import date

import numpy as np
import pytest
import cv2
from io import BytesIO
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian
from pydantic import ValidationError

from app.engine import XGB_FEATURES, build_arthroplasty_features
from app.imaging import detect_image, extract_bilateral_roi, normalize_pixels, read_dicom, read_raster
from app.schemas import ArthroplastyRequest, ProgressionRequest
from app.vision import VisionAssessment, classify_review_status


BASE_FLAGS = {
    "obesity": False,
    "diabetes": False,
    "hypertension": False,
    "nicotine_use": False,
    "trauma_lower_extremity": False,
}


def test_xgboost_has_exact_feature_order_and_first_exam_semantics():
    request = ArthroplastyRequest(
        date_of_birth=date(1960, 1, 1), exam_date=date(2026, 1, 1), current_kl=2,
        pain_score=None, sex=None, knee_side="R", prior_exams=[], **BASE_FLAGS,
    )
    features = build_arthroplasty_features(request)
    assert list(features) == XGB_FEATURES
    assert features["n_prior_exams"] == 0
    assert np.isnan(features["prior_KLG"])
    assert features["pain_missing"] == 1
    assert features["years_since_first"] == 0
    assert features["kl_change_from_first"] == 0


def test_xgboost_rejects_future_and_other_knee_history():
    with pytest.raises(ValidationError):
        ArthroplastyRequest(
            date_of_birth=date(1960, 1, 1), exam_date=date(2026, 1, 1), current_kl=2,
            knee_side="R", prior_exams=[{"date": "2027-01-01", "KLG": 1, "knee_side": "L"}],
            **BASE_FLAGS,
        )


@pytest.mark.parametrize("count", [0, 1, 3])
def test_lstm_requires_exactly_two_observations(count):
    item = {"date": "2025-01-01", "KLG": 1, "age_at_exam": 60, "knee_side": "L", **BASE_FLAGS}
    with pytest.raises(ValidationError):
        ProgressionRequest(patient_reference="synthetic", observations=[item] * count)


def test_lstm_rejects_t2_kl4():
    with pytest.raises(ValidationError):
        ProgressionRequest(patient_reference="synthetic", observations=[
            {"date": "2024-01-01", "KLG": 2, "age_at_exam": 60, "knee_side": "L", **BASE_FLAGS},
            {"date": "2025-01-01", "KLG": 4, "age_at_exam": 61, "knee_side": "L", **BASE_FLAGS},
        ])


def test_normalization_rejects_flat_image_and_left_roi_is_mirrored():
    with pytest.raises(ValueError):
        normalize_pixels(np.ones((64, 64)))
    bilateral = np.arange(128 * 256, dtype=np.float32).reshape(128, 256)
    left = extract_bilateral_roi(bilateral, "L", False)
    assert left.flags["C_CONTIGUOUS"]
    assert left[0, 0] > left[0, -1]


@pytest.mark.parametrize("extension", [".png", ".jpg"])
def test_png_and_jpg_are_decoded_deterministically(extension):
    source = np.arange(128 * 256, dtype=np.uint8).reshape(128, 256)
    ok, encoded = cv2.imencode(extension, source)
    assert ok
    decoded = read_raster(encoded.tobytes())
    assert decoded.shape == source.shape
    assert decoded.min() == 0
    assert decoded.max() == 1


def test_dicom_monochrome1_polarity_is_applied_without_exposing_metadata():
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.Rows, dataset.Columns = 64, 128
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME1"
    dataset.BitsAllocated = dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    dataset.PatientName = "PHI^MUST_NOT_BE_RETURNED"
    pixels = np.arange(64 * 128, dtype=np.uint16).reshape(64, 128)
    dataset.PixelData = pixels.tobytes()
    stream = BytesIO()
    dataset.save_as(stream)
    decoded = read_dicom(stream.getvalue(), False)
    assert decoded[0, 0] > decoded[-1, -1]


def test_preflight_detects_dicom_renders_png_and_masks_possible_border_text():
    meta = FileMetaDataset()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    dataset = FileDataset(None, {}, file_meta=meta, preamble=b"\0" * 128)
    dataset.Rows, dataset.Columns = 100, 200
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = dataset.BitsStored = 16
    dataset.HighBit = 15
    dataset.PixelRepresentation = 0
    dataset.PatientName = "PHI^MUST_NOT_LEAVE"
    dataset.StudyDate = "20260904"
    dataset.PixelData = np.arange(100 * 200, dtype=np.uint16).reshape(100, 200).tobytes()
    stream = BytesIO()
    dataset.save_as(stream)

    detected = detect_image(stream.getvalue())
    external = cv2.imdecode(np.frombuffer(detected.external_review_png, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert detected.file_kind == "DICOM"
    assert detected.media_type == "application/dicom"
    assert detected.exam_date == "2026-09-04"
    assert detected.preview_png.startswith(b"\x89PNG")
    assert np.all(external[:10, :] == 0)
    assert b"PHI^MUST_NOT_LEAVE" not in detected.external_review_png


@pytest.mark.parametrize(
    ("is_radiograph", "anatomy"),
    [(False, "other"), (False, "knee"), (True, "other")],
)
def test_preflight_hard_rejects_non_radiographs_and_non_knee_anatomy(is_radiograph, anatomy):
    assessment = VisionAssessment(
        is_radiograph=is_radiograph, anatomy=anatomy, view="uncertain", coverage="uncertain",
        laterality="unknown", weight_bearing="unknown", quality="limited", confidence=0.25,
        reason_codes=["not_knee"],
    )
    assert classify_review_status(assessment) == "REJECTED"


def test_preflight_keeps_uncertain_knee_radiograph_for_manual_review():
    assessment = VisionAssessment(
        is_radiograph=True, anatomy="uncertain", view="uncertain", coverage="uncertain",
        laterality="unknown", weight_bearing="unknown", quality="limited", confidence=0.4,
        reason_codes=["uncertain_view"],
    )
    assert classify_review_status(assessment) == "REVIEW_REQUIRED"


def test_integrity_rejects_modified_artifact(tmp_path, monkeypatch):
    from app import integrity
    artifact = tmp_path / "model.bin"
    artifact.write_bytes(b"trusted")
    expected = __import__('hashlib').sha256(b"trusted").hexdigest()
    monkeypatch.setattr(integrity, 'REQUIRED_MODELS', {"model.bin": expected})
    (tmp_path / "MANIFEST.json").write_text(
        __import__('json').dumps({"release": "oa-final-2026-09-03", "files": [{"path": "model.bin", "sha256": expected}]}),
        encoding="utf-8",
    )
    assert integrity.verify_model_package(tmp_path) == {"model.bin": expected}
    artifact.write_bytes(b"modified")
    with pytest.raises(RuntimeError, match="Hash inválido"):
        integrity.verify_model_package(tmp_path)
