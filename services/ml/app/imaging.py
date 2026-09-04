from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from io import BytesIO

import cv2
import numpy as np
import pydicom
from pydicom.dataset import Dataset
from pydicom.pixels import apply_voi_lut

from .schemas import ImageSourceType, KneeSide


ALLOWED_DICOM_TYPES = {"application/dicom", "application/octet-stream"}
ALLOWED_RASTER_TYPES = {"image/png", "image/jpeg", "image/jpg"}


@dataclass(frozen=True)
class PreparedImage:
    roi: np.ndarray
    input_hash: str
    pipeline: str


@dataclass(frozen=True)
class DetectedImage:
    image: np.ndarray
    file_kind: str
    media_type: str
    exam_date: str | None
    preview_png: bytes
    external_review_png: bytes
    input_hash: str


def normalize_pixels(array: np.ndarray) -> np.ndarray:
    image = np.asarray(array, dtype=np.float32)
    finite = image[np.isfinite(image)]
    if finite.size == 0:
        raise ValueError("La imagen no contiene píxeles finitos")
    low, high = np.percentile(finite, [0.5, 99.5])
    if high <= low:
        raise ValueError("La imagen no tiene rango dinámico útil")
    image = np.nan_to_num(image, nan=low, posinf=high, neginf=low)
    return np.clip((image - low) / (high - low), 0.0, 1.0)


def read_dicom(content: bytes, metadata_inverted: bool) -> np.ndarray:
    try:
        dataset = pydicom.dcmread(BytesIO(content), force=False)
        raw = dataset.pixel_array
    except Exception as exc:
        raise ValueError("El DICOM está corrupto o usa una codificación no compatible") from exc
    if raw.ndim != 2 or int(getattr(dataset, "NumberOfFrames", 1)) != 1:
        raise ValueError("Solo se admite DICOM radiográfico monoframe 2D")
    try:
        array = apply_voi_lut(raw, dataset).astype(np.float32)
    except Exception:
        array = raw.astype(np.float32)
    photo = str(getattr(dataset, "PhotometricInterpretation", "")).upper()
    presentation = str(getattr(dataset, "PresentationLUTShape", "")).upper()
    if photo == "MONOCHROME1" or presentation == "INVERSE" or metadata_inverted:
        array = array.max() + array.min() - array
    return normalize_pixels(array)


def _dicom_pixels(dataset: Dataset) -> np.ndarray:
    raw = dataset.pixel_array
    if raw.ndim != 2 or int(getattr(dataset, "NumberOfFrames", 1)) != 1:
        raise ValueError("Solo se admite DICOM radiográfico monoframe 2D")
    try:
        array = apply_voi_lut(raw, dataset).astype(np.float32)
    except Exception:
        array = raw.astype(np.float32)
    photo = str(getattr(dataset, "PhotometricInterpretation", "")).upper()
    presentation = str(getattr(dataset, "PresentationLUTShape", "")).upper()
    if photo == "MONOCHROME1" or presentation == "INVERSE":
        array = array.max() + array.min() - array
    return normalize_pixels(array)


def _png_bytes(image: np.ndarray, max_dimension: int, mask_borders: bool) -> bytes:
    height, width = image.shape
    scale = min(1.0, max_dimension / max(height, width))
    if scale < 1.0:
        image = cv2.resize(image, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
    encoded_image = np.rint(np.clip(image, 0, 1) * 255).astype(np.uint8)
    if mask_borders:
        masked = encoded_image.copy()
        h, w = masked.shape
        masked[: max(1, round(h * 0.10)), :] = 0
        masked[h - max(1, round(h * 0.07)) :, :] = 0
        masked[:, : max(1, round(w * 0.035))] = 0
        masked[:, w - max(1, round(w * 0.035)) :] = 0
        encoded_image = masked
    ok, encoded = cv2.imencode(".png", encoded_image, [cv2.IMWRITE_PNG_COMPRESSION, 6])
    if not ok:
        raise ValueError("No se pudo generar la vista previa")
    return encoded.tobytes()


def detect_image(content: bytes) -> DetectedImage:
    dataset = None
    try:
        dataset = pydicom.dcmread(BytesIO(content), force=False)
        image = _dicom_pixels(dataset)
        file_kind = "DICOM"
        media_type = "application/dicom"
    except Exception:
        image = read_raster(content)
        file_kind = "RASTER"
        media_type = "image/png" if content.startswith(b"\x89PNG\r\n\x1a\n") else "image/jpeg"
    exam_date = None
    if dataset is not None:
        raw_date = str(getattr(dataset, "StudyDate", "") or getattr(dataset, "AcquisitionDate", ""))
        if len(raw_date) == 8 and raw_date.isdigit():
            exam_date = f"{raw_date[:4]}-{raw_date[4:6]}-{raw_date[6:]}"
    return DetectedImage(
        image=image,
        file_kind=file_kind,
        media_type=media_type,
        exam_date=exam_date,
        preview_png=_png_bytes(image, 1200, False),
        external_review_png=_png_bytes(image, 768, True),
        input_hash=hashlib.sha256(content).hexdigest(),
    )


def read_raster(content: bytes) -> np.ndarray:
    encoded = np.frombuffer(content, dtype=np.uint8)
    image = cv2.imdecode(encoded, cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError("El PNG/JPG está corrupto o no es compatible")
    if image.ndim == 3:
        if image.shape[2] == 4:
            image = cv2.cvtColor(image, cv2.COLOR_BGRA2GRAY)
        else:
            image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    if image.ndim != 2:
        raise ValueError("La imagen debe poder convertirse a escala de grises 2D")
    return normalize_pixels(image)


def extract_bilateral_roi(
    bilateral: np.ndarray,
    side: KneeSide,
    horizontal_flip: bool,
    width_fraction: float = 0.90,
    center_y_fraction: float = 0.55,
) -> np.ndarray:
    array = np.fliplr(bilateral) if horizontal_flip else bilateral
    height, width = array.shape
    if height < 64 or width < 128:
        raise ValueError("La imagen bilateral tiene resolución insuficiente")
    middle = width // 2
    half = array[:, :middle] if side == KneeSide.RIGHT else array[:, middle:]
    half_height, half_width = half.shape
    roi_size = max(32, min(int(round(half_width * width_fraction)), half_height))
    center_x = half_width // 2
    center_y = int(round(half_height * center_y_fraction))
    x0 = int(np.clip(center_x - roi_size // 2, 0, half_width - roi_size))
    y0 = int(np.clip(center_y - roi_size // 2, 0, half_height - roi_size))
    roi = half[y0 : y0 + roi_size, x0 : x0 + roi_size]
    if side == KneeSide.LEFT:
        roi = np.fliplr(roi)
    return np.ascontiguousarray(roi)


def prepare_image(
    content: bytes,
    content_type: str,
    source_type: ImageSourceType,
    side: KneeSide,
    projection_confirmed: bool,
    weight_bearing_confirmed: bool,
    orientation_confirmed: bool,
    metadata_inverted: bool,
    horizontal_flip: bool,
) -> PreparedImage:
    if not (projection_confirmed and weight_bearing_confirmed and orientation_confirmed):
        raise ValueError("Debe confirmarse proyección AP, soporte de peso y orientación")
    if source_type == ImageSourceType.DICOM_BILATERAL:
        if content_type not in ALLOWED_DICOM_TYPES:
            raise ValueError("El tipo MIME no corresponde a DICOM")
        image = read_dicom(content, metadata_inverted)
        roi = extract_bilateral_roi(image, side, horizontal_flip)
        pipeline = "dicom-voi-polarity-percentile-bilateral-roi-v2"
    else:
        if content_type not in ALLOWED_RASTER_TYPES:
            raise ValueError("Solo se admite PNG o JPG para una entrada raster")
        image = read_raster(content)
        if source_type == ImageSourceType.RASTER_BILATERAL:
            roi = extract_bilateral_roi(image, side, horizontal_flip)
            pipeline = "raster-grayscale-percentile-bilateral-roi-v2"
        else:
            if min(image.shape) < 32:
                raise ValueError("La ROI tiene resolución insuficiente")
            roi = np.fliplr(image) if side == KneeSide.LEFT else image
            roi = np.ascontiguousarray(roi)
            pipeline = "raster-single-roi-grayscale-percentile-mirror-v2"
    return PreparedImage(roi=roi, input_hash=hashlib.sha256(content).hexdigest(), pipeline=pipeline)


def overlay_base64(grayscale: np.ndarray, heatmap: np.ndarray) -> str:
    base = cv2.cvtColor(grayscale, cv2.COLOR_GRAY2BGR)
    color = cv2.applyColorMap(np.rint(heatmap * 255).astype(np.uint8), cv2.COLORMAP_JET)
    overlay = cv2.addWeighted(base, 0.55, color, 0.45, 0)
    ok, encoded = cv2.imencode(".png", overlay)
    if not ok:
        raise RuntimeError("No se pudo codificar Grad-CAM")
    return base64.b64encode(encoded.tobytes()).decode("ascii")
