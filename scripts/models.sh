#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="$ROOT/.models/oa-final-2026-09-03"
SOURCE_DIR=${1:-}
mkdir -p "$ROOT/.models"
if [ -d "$TARGET" ]; then
  python "$ROOT/scripts/verify_models.py" "$TARGET"
  exit 0
fi
STAGING=$(mktemp -d "$ROOT/.models/.staging-XXXXXX")
trap 'rm -rf "$STAGING"' EXIT
if [ -n "$SOURCE_DIR" ]; then
  cp -R "$SOURCE_DIR"/. "$STAGING"/
else
  : "${MODEL_PACKAGE_URL:?Defina MODEL_PACKAGE_URL o pase una carpeta como primer argumento}"
  if [ -n "${GH_MODELS_TOKEN:-}" ]; then
    curl --fail --location --header "Authorization: Bearer $GH_MODELS_TOKEN" --header "Accept: application/octet-stream" "$MODEL_PACKAGE_URL" --output "$STAGING/models.zip"
  else
    curl --fail --location "$MODEL_PACKAGE_URL" --output "$STAGING/models.zip"
  fi
  mkdir "$STAGING/extracted"
  unzip -q "$STAGING/models.zip" -d "$STAGING/extracted"
  if [ -f "$STAGING/extracted/MANIFEST.json" ]; then SOURCE_DIR="$STAGING/extracted"; else SOURCE_DIR=$(find "$STAGING/extracted" -mindepth 1 -maxdepth 1 -type d | head -n 1); fi
  python "$ROOT/scripts/verify_models.py" "$SOURCE_DIR"
  mv "$SOURCE_DIR" "$TARGET"
fi
if [ ! -d "$TARGET" ]; then mv "$STAGING" "$TARGET"; trap - EXIT; fi
python "$ROOT/scripts/verify_models.py" "$TARGET"

