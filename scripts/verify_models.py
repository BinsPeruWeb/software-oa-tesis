from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
manifest = json.loads((root / "MANIFEST.json").read_text(encoding="utf-8-sig"))
if manifest.get("release") != "oa-final-2026-09-03" or len(manifest.get("files", [])) != 51:
    raise SystemExit("Versión o manifiesto incorrecto")
for item in manifest["files"]:
    path = (root / item["path"]).resolve()
    if root not in path.parents or not path.is_file():
        raise SystemExit(f"Archivo ausente o ruta insegura: {item['path']}")
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    if digest.hexdigest() != item["sha256"]:
        raise SystemExit(f"Hash inválido: {item['path']}")
print("51 archivos verificados: oa-final-2026-09-03")

