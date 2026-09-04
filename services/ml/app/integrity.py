from __future__ import annotations

import hashlib
import json
from pathlib import Path


REQUIRED_MODELS = {
    "models/cnn/resnet50_v2_best.pt": "5749183d3b797cd1111ed4566bb88685374239dc9c6d961ea99fe5aa82d18f62",
    "models/cnn/densenet121_v2_best.pt": "c5a464f977a0bd8bd3612391fff979a64036b772e9d4c776210f64a517d22325",
    "models/xgboost/xgboost_artroplastia_v2.json": "a4a5b69682262f81a7a7dec8a0df72d329b29a8e160c308c1bec0ef20db5956b",
    "models/xgboost/xgboost_calibrator_v2.joblib": "710bd1e07d4f8d2d251e52cc30816b2535f4864943e8df6086f1b1b029bda314",
    "models/lstm/lstm_progression_v2_clean.pt": "c0b66e7e4475fa3b45967459a2bb90067946ac04705a2f09a28c0434b79c3ec0",
}


def sha256_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_package(root: Path) -> dict[str, str]:
    manifest_path = root / "MANIFEST.json"
    if not manifest_path.is_file():
        raise RuntimeError("Falta MANIFEST.json en el paquete de modelos")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest.get("release") != "oa-final-2026-09-03":
        raise RuntimeError("La versión del paquete de modelos no es compatible")
    manifest_hashes = {item["path"]: item["sha256"] for item in manifest.get("files", [])}
    verified: dict[str, str] = {}
    for relative, expected in REQUIRED_MODELS.items():
        path = root / relative
        if not path.is_file():
            raise RuntimeError(f"Falta el artefacto requerido: {relative}")
        if manifest_hashes.get(relative) != expected:
            raise RuntimeError(f"El manifiesto no autoriza el artefacto: {relative}")
        actual = sha256_file(path)
        if actual != expected:
            raise RuntimeError(f"Hash inválido para: {relative}")
        verified[relative] = actual
    return verified

