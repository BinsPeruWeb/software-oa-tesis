from __future__ import annotations

import os
import shutil
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from app.integrity import verify_model_package


root = Path(os.getenv("MODEL_ROOT", "/models"))
try:
    verify_model_package(root)
except Exception:
    url = os.getenv("MODEL_PACKAGE_URL", "")
    token = os.getenv("GH_MODELS_TOKEN", "")
    if not url:
        raise RuntimeError("Modelos ausentes y MODEL_PACKAGE_URL no configurada")
    root.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="oa-models-") as temporary:
        archive = Path(temporary) / "models.zip"
        request = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"} if token else {})
        with urllib.request.urlopen(request, timeout=300) as response, archive.open("wb") as output:
            shutil.copyfileobj(response, output)
        extracted = Path(temporary) / "extracted"
        extracted.mkdir()
        with zipfile.ZipFile(archive) as package:
            base = extracted.resolve()
            for member in package.infolist():
                target = (extracted / member.filename).resolve()
                if target != base and base not in target.parents:
                    raise RuntimeError("El ZIP de modelos contiene una ruta insegura")
            package.extractall(extracted)
        if (extracted / "MANIFEST.json").is_file():
            candidate = extracted
        else:
            directories = [item for item in extracted.iterdir() if item.is_dir()]
            if len(directories) != 1 or not (directories[0] / "MANIFEST.json").is_file():
                raise RuntimeError("El ZIP no contiene un paquete de modelos válido")
            candidate = directories[0]
        verify_model_package(candidate)
        shutil.copytree(candidate, root, dirs_exist_ok=True)
    verify_model_package(root)
