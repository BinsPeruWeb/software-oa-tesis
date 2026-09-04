from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from io import BytesIO

import cv2
import numpy as np
import pydicom
from pydicom.pixels import apply_voi_lut

from .schemas import ImageSourceType, KneeSide


ALLOWED_DICOM_TYPES = {"application/dicom", "application/octet-stream"}
ALLOWED_RASTER_TYPES = {"image/png", "image/jpeg", "image/jpg"}


@dataclass(frozen=True)
class PreparedImage:
    roi: np.ndarray
    input_hash: str
    pipeline: str


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

