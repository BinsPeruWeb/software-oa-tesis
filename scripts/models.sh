#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
MODEL_PARENT="$ROOT/.models"
TARGET="$MODEL_PARENT/oa-final-2026-09-03"
INPUT=${1:-}

mkdir -p "$MODEL_PARENT"

verify_package() {
  package_path=$1
  relative_path=${package_path#"$ROOT"/}
  docker run --rm \
    -v "$ROOT:/workspace:ro" \
    -w /workspace \
    python:3.12-alpine \
    python scripts/verify_models.py "/workspace/$relative_path"
}

if [ -d "$TARGET" ]; then
  verify_package "$TARGET"
  echo "Modelos verificados en $TARGET"
  exit 0
fi

STAGING=$(mktemp -d "$MODEL_PARENT/.staging-XXXXXX")
trap 'rm -rf "$STAGING"' EXIT

if [ -n "$INPUT" ] && [ -d "$INPUT" ]; then
  cp -R "$INPUT"/. "$STAGING"/
  verify_package "$STAGING"
  mv "$STAGING" "$TARGET"
  trap - EXIT
elif { [ -n "$INPUT" ] && [ -f "$INPUT" ]; } || [ -n "${MODEL_PACKAGE_URL:-}" ]; then
  ARCHIVE="$STAGING/models.zip"
  if [ -n "$INPUT" ] && [ -f "$INPUT" ]; then
    cp "$INPUT" "$ARCHIVE"
  else
    docker run --rm \
      -e PACKAGE_URL="$MODEL_PACKAGE_URL" \
      -e PACKAGE_TOKEN="${GH_MODELS_TOKEN:-}" \
      -v "$STAGING:/package" \
      alpine:3.22 sh -c '
        apk add --no-cache curl >/dev/null
        if [ -n "$PACKAGE_TOKEN" ]; then
          curl --fail --location \
            --header "Authorization: Bearer $PACKAGE_TOKEN" \
            --header "Accept: application/octet-stream" \
            "$PACKAGE_URL" --output /package/models.zip
        else
          curl --fail --location "$PACKAGE_URL" --output /package/models.zip
        fi
      '
  fi

  mkdir "$STAGING/extracted"
  docker run --rm \
    -v "$STAGING:/package" \
    alpine:3.22 sh -c 'apk add --no-cache unzip >/dev/null && unzip -q /package/models.zip -d /package/extracted'

  if [ -f "$STAGING/extracted/MANIFEST.json" ]; then
    CANDIDATE="$STAGING/extracted"
  else
    CANDIDATE=$(find "$STAGING/extracted" -mindepth 1 -maxdepth 1 -type d | head -n 1)
    if [ -z "$CANDIDATE" ]; then
      echo "El ZIP no contiene un paquete de modelos" >&2
      exit 1
    fi
  fi

  verify_package "$CANDIDATE"
  mv "$CANDIDATE" "$TARGET"
else
  echo "Pase la carpeta o el ZIP de modelos, o defina MODEL_PACKAGE_URL" >&2
  exit 1
fi

verify_package "$TARGET"
echo "Los 51 archivos y sus hashes fueron verificados correctamente."
