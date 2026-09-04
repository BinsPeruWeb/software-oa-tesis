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

    def validate(self) -> None:
        if len(self.service_token) < 24:
            raise RuntimeError("SERVICE_TOKEN debe tener al menos 24 caracteres")
        if self.device not in {"cpu", "cuda"}:
            raise RuntimeError("DEVICE debe ser cpu o cuda")


settings = Settings()

