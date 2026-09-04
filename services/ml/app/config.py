from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    model_root: Path = Path(os.getenv("MODEL_ROOT", "/models"))
    service_token: str = os.getenv("SERVICE_TOKEN", "")
    device: str = os.getenv("DEVICE", "cpu")
    max_upload_bytes: int = int(os.getenv("MAX_UPLOAD_BYTES", str(64 * 1024 * 1024)))
    openrouter_enabled: bool = os.getenv("OPENROUTER_ENABLED", "false").lower() == "true"
    openrouter_api_key: str = os.getenv("OPENROUTER_API_KEY", "")
    openrouter_model: str = os.getenv("OPENROUTER_MODEL", "google/gemini-2.5-flash-lite")
    openrouter_base_url: str = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
    openrouter_timeout_seconds: int = int(os.getenv("OPENROUTER_TIMEOUT_SECONDS", "25"))

    def validate(self) -> None:
        if len(self.service_token) < 24:
            raise RuntimeError("SERVICE_TOKEN debe tener al menos 24 caracteres")
        if self.device not in {"cpu", "cuda"}:
            raise RuntimeError("DEVICE debe ser cpu o cuda")
        if self.openrouter_enabled and len(self.openrouter_api_key) < 20:
            raise RuntimeError("OPENROUTER_API_KEY no está configurada")
        if self.openrouter_timeout_seconds < 5 or self.openrouter_timeout_seconds > 60:
            raise RuntimeError("OPENROUTER_TIMEOUT_SECONDS debe estar entre 5 y 60")


settings = Settings()
