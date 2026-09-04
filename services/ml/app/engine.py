from __future__ import annotations

import contextlib
import math
from datetime import date
from pathlib import Path
from typing import Any

import cv2
import joblib
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
from torchvision import models

from .imaging import overlay_base64
from .integrity import REQUIRED_MODELS
from .schemas import ArthroplastyRequest, ProgressionRequest


MODEL_VERSION = "oa-final-2026-09-03"
XGB_THRESHOLD = 0.2574747475
LSTM_THRESHOLD = 0.4802020202
IMAGENET_MEAN = np.asarray([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.asarray([0.229, 0.224, 0.225], dtype=np.float32)
XGB_FEATURES = [
    "age_at_exam", "KLG", "pain_score", "pain_missing", "obesity", "diabetes",
    "hypertension", "nicotine_use", "trauma_lower_extremity", "sex_female",
    "sex_missing", "knee_left", "prior_KLG", "years_since_prior",
    "kl_change_from_prior", "prior_kl_rate", "n_prior_exams",
    "years_since_first", "kl_change_from_first",
]


def trusted_torch_load(path: Path, device: torch.device):
    try:
        return torch.load(path, map_location=device, weights_only=False)
    except TypeError:
        return torch.load(path, map_location=device)


def knee_tensor(knee_image: np.ndarray, size: int = 320) -> tuple[torch.Tensor, np.ndarray]:
    image = np.asarray(knee_image, dtype=np.float32)
    if image.ndim != 2 or image.min() < 0 or image.max() > 1:
        raise ValueError("La ROI normalizada debe ser 2D y estar en el rango [0,1]")
    resized = cv2.resize(
        image,
        (size, size),
        interpolation=cv2.INTER_AREA if max(image.shape) > size else cv2.INTER_CUBIC,
    )
    rgb = np.repeat(resized[:, :, None], 3, axis=2)
    normalized = (rgb - IMAGENET_MEAN) / IMAGENET_STD
    return torch.from_numpy(normalized.transpose(2, 0, 1)).float().unsqueeze(0), np.rint(resized * 255).astype(np.uint8)


def make_cnn(architecture: str):
    if architecture == "resnet50":
        model = models.resnet50(weights=None)
        model.fc = nn.Linear(model.fc.in_features, 5)
        return model, lambda item: item.layer4[-1].conv3
    if architecture == "densenet121":
        model = models.densenet121(weights=None)
        model.classifier = nn.Linear(model.classifier.in_features, 5)
        return model, lambda item: item.features.denseblock4.denselayer16.conv2
    raise ValueError("Arquitectura CNN desconocida")


class KlClassifier:
    def __init__(self, package_root: Path, device: torch.device):
        self.device = device
        self.members: dict[str, nn.Module] = {}
        self.layers: dict[str, Any] = {}
        for architecture in ("resnet50", "densenet121"):
            model, layer = make_cnn(architecture)
            checkpoint = trusted_torch_load(
                package_root / "models" / "cnn" / f"{architecture}_v2_best.pt", device
            )
            model.load_state_dict(checkpoint["model_state"])
            del checkpoint
            self.members[architecture] = model.to(device).eval()
            self.layers[architecture] = layer

    @torch.inference_mode()
    def predict(self, roi: np.ndarray) -> dict[str, Any]:
        tensor, _ = knee_tensor(roi)
        tensor = tensor.to(self.device)
        members: dict[str, np.ndarray] = {}
        for name, model in self.members.items():
            autocast = (
                torch.autocast("cuda", dtype=torch.bfloat16)
                if self.device.type == "cuda"
                else contextlib.nullcontext()
            )
            with autocast:
                members[name] = torch.softmax(model(tensor).float(), dim=1)[0].cpu().numpy()
        ensemble = (members["resnet50"] + members["densenet121"]) / 2.0
        ensemble = ensemble / ensemble.sum()
        predicted = int(ensemble.argmax())
        return {
            "predicted_kl": predicted,
            "confidence": float(ensemble[predicted]),
            "probabilities": {f"KL{i}": float(value) for i, value in enumerate(ensemble)},
            "member_probabilities": {
                name: {f"KL{i}": float(value) for i, value in enumerate(values)}
                for name, values in members.items()
            },
        }

    def explain(self, roi: np.ndarray, target_kl: int | None) -> tuple[int, dict[str, str]]:
        prediction = self.predict(roi)
        target = prediction["predicted_kl"] if target_kl is None else target_kl
        if target not in range(5):
            raise ValueError("target_kl debe estar entre 0 y 4")
        tensor, grayscale = knee_tensor(roi)
        tensor = tensor.to(self.device)
        overlays: dict[str, str] = {}
        for name, model in self.members.items():
            captured: dict[str, torch.Tensor] = {}
            layer = self.layers[name](model)

            def capture(_module, _inputs, output):
                captured["activation"] = output
                output.register_hook(lambda grad: captured.__setitem__("gradient", grad))

            handle = layer.register_forward_hook(capture)
            try:
                model.zero_grad(set_to_none=True)
                logits = model(tensor)
                logits[0, target].backward()
                weights = captured["gradient"].float().mean(dim=(2, 3), keepdim=True)
                cam = torch.relu((weights * captured["activation"].float()).sum(dim=1, keepdim=True))
                cam = F.interpolate(cam, size=(320, 320), mode="bilinear", align_corners=False)[0, 0]
                cam -= cam.min()
                cam /= cam.max().clamp_min(1e-8)
                overlays[name] = overlay_base64(grayscale, cam.detach().cpu().numpy())
            finally:
                handle.remove()
        return target, overlays


def full_year_age(birth: date, exam: date) -> float:
    return (exam - birth).days / 365.25


def build_arthroplasty_features(request: ArthroplastyRequest) -> dict[str, float | int]:
    history = sorted(request.prior_exams, key=lambda item: item.date)
    current_date = pd.Timestamp(request.exam_date)
    first = history[0] if history else None
    prior = history[-1] if history else None
    if prior:
        years_since_prior = (current_date - pd.Timestamp(prior.date)).days / 365.25
        change_prior = request.current_kl - prior.KLG
        prior_rate = change_prior / years_since_prior
        prior_kl: float | int = prior.KLG
    else:
        years_since_prior = math.nan
        change_prior = math.nan
        prior_rate = math.nan
        prior_kl = math.nan
    if first:
        years_since_first = (current_date - pd.Timestamp(first.date)).days / 365.25
        change_first = request.current_kl - first.KLG
    else:
        years_since_first = 0.0
        change_first = 0
    pain_missing = request.pain_score is None
    values = {
        "age_at_exam": full_year_age(request.date_of_birth, request.exam_date),
        "KLG": request.current_kl,
        "pain_score": math.nan if pain_missing else float(request.pain_score),
        "pain_missing": int(pain_missing),
        "obesity": int(request.obesity),
        "diabetes": int(request.diabetes),
        "hypertension": int(request.hypertension),
        "nicotine_use": int(request.nicotine_use),
        "trauma_lower_extremity": int(request.trauma_lower_extremity),
        "sex_female": int(request.sex == "female"),
        "sex_missing": int(request.sex is None),
        "knee_left": int(request.knee_side == "L"),
        "prior_KLG": prior_kl,
        "years_since_prior": years_since_prior,
        "kl_change_from_prior": change_prior,
        "prior_kl_rate": prior_rate,
        "n_prior_exams": len(history),
        "years_since_first": years_since_first,
        "kl_change_from_first": change_first,
    }
    if list(values) != XGB_FEATURES:
        raise RuntimeError("Orden interno incorrecto de features XGBoost")
    return values


class ArthroplastyPredictor:
    def __init__(self, package_root: Path):
        self.bundle = joblib.load(package_root / "models/xgboost/xgboost_calibrator_v2.joblib")
        if list(self.bundle["features"]) != XGB_FEATURES:
            raise RuntimeError("El artefacto XGBoost no tiene las 19 features esperadas")
        if not math.isclose(float(self.bundle["threshold"]), XGB_THRESHOLD, abs_tol=1e-10):
            raise RuntimeError("El umbral XGBoost del artefacto fue alterado")

    def predict(self, request: ArthroplastyRequest) -> tuple[float, dict[str, float | int]]:
        features = build_arthroplasty_features(request)
        frame = pd.DataFrame([{name: features[name] for name in XGB_FEATURES}], columns=XGB_FEATURES)
        probability = float(self.bundle["calibrator"].predict_proba(frame)[:, 1][0])
        return probability, features


class HybridLstm(nn.Module):
    def __init__(self, sequence_dim: int, static_dim: int, hidden_size: int, dropout: float):
        super().__init__()
        self.lstm = nn.LSTM(sequence_dim, hidden_size, batch_first=True)
        self.head = nn.Sequential(nn.Dropout(dropout), nn.Linear(hidden_size + static_dim, 1))

    def forward(self, sequence, static):
        _, (hidden, _) = self.lstm(sequence)
        return self.head(torch.cat([hidden[-1], static], dim=1)).squeeze(1)


class ProgressionPredictor:
    def __init__(self, package_root: Path, device: torch.device):
        self.device = device
        self.checkpoint = trusted_torch_load(
            package_root / "models/lstm/lstm_progression_v2_clean.pt", device
        )
        if not math.isclose(float(self.checkpoint["threshold"]), LSTM_THRESHOLD, abs_tol=1e-10):
            raise RuntimeError("El umbral LSTM del artefacto fue alterado")
        config = self.checkpoint["config"]
        self.model = HybridLstm(11, 5, config["hidden_size"], config["dropout"]).to(device)
        self.model.load_state_dict(self.checkpoint["model_state"])
        self.model.eval()

    def encode(self, request: ProgressionRequest) -> tuple[np.ndarray, np.ndarray]:
        ordered = sorted(request.observations, key=lambda item: item.date)
        interval = (ordered[1].date - ordered[0].date).days / 365.25
        prep = self.checkpoint["sequence_preprocessor"]
        raw_rows: list[list[float]] = []
        pains: list[float] = []
        for position, item in enumerate(ordered):
            missing = item.pain_score is None
            pain = float(prep["pain_median"] if missing else item.pain_score)
            pains.append(pain)
            raw_rows.append([
                float(item.KLG), item.age_at_exam, pain, 0.0 if position == 0 else interval,
                float(missing), float(item.obesity), float(item.diabetes),
                float(item.hypertension), float(item.nicotine_use),
                float(item.trauma_lower_extremity), float(item.knee_side == "L"),
            ])
        sequence = np.asarray([raw_rows], dtype=np.float32)
        sequence[:, :, :4] = (
            sequence[:, :, :4] - np.asarray(prep["means"], dtype=np.float32)
        ) / np.asarray(prep["stds"], dtype=np.float32)
        delta_kl = float(ordered[1].KLG - ordered[0].KLG)
        static_raw = np.asarray(
            [[delta_kl, delta_kl / interval, pains[1] - pains[0], float(ordered[1].KLG), interval]],
            dtype=np.float32,
        )
        static_prep = self.checkpoint["static_preprocessor"]
        static = (static_raw - np.asarray(static_prep["mean"], dtype=np.float32)) / np.asarray(
            static_prep["std"], dtype=np.float32
        )
        return sequence, static

    @torch.inference_mode()
    def predict(self, request: ProgressionRequest) -> float:
        sequence, static = self.encode(request)
        value = torch.sigmoid(
            self.model(torch.from_numpy(sequence).to(self.device), torch.from_numpy(static).to(self.device))
        )[0]
        return float(value.cpu())


class ModelSuite:
    def __init__(self, root: Path, device_name: str):
        if device_name == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("DEVICE=cuda pero CUDA no está disponible")
        self.device = torch.device(device_name)
        self.kl = KlClassifier(root, self.device)
        self.arthroplasty = ArthroplastyPredictor(root)
        self.progression = ProgressionPredictor(root, self.device)
        self.model_hashes = {
            "resnet50": REQUIRED_MODELS["models/cnn/resnet50_v2_best.pt"],
            "densenet121": REQUIRED_MODELS["models/cnn/densenet121_v2_best.pt"],
            "xgboost": REQUIRED_MODELS["models/xgboost/xgboost_calibrator_v2.joblib"],
            "lstm": REQUIRED_MODELS["models/lstm/lstm_progression_v2_clean.pt"],
        }


def json_safe_features(features: dict[str, float | int]) -> dict[str, float | int | None]:
    return {
        key: None if isinstance(value, float) and math.isnan(value) else value
        for key, value in features.items()
    }

