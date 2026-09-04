#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
TARGET="$ROOT/.env"
EXAMPLE="$ROOT/.env.example"

if [ -e "$TARGET" ]; then
  echo ".env ya existe; no fue sobrescrito" >&2
  exit 1
fi

random_base64() {
  head -c "$1" /dev/urandom | base64 | tr -d '\r\n'
}

JWT_SECRET=$(random_base64 48)
CSRF_SECRET=$(random_base64 48)
FIELD_KEY=$(random_base64 32)
BLIND_KEY=$(random_base64 32)
SERVICE_TOKEN=$(random_base64 48)
BOOTSTRAP_PASSWORD="OA-$(random_base64 24 | tr '/+' '_-')"
TEMP="$ROOT/.env.tmp.$$"

trap 'rm -f "$TEMP"' EXIT

awk \
  -v jwt="$JWT_SECRET" \
  -v csrf="$CSRF_SECRET" \
  -v field="$FIELD_KEY" \
  -v blind="$BLIND_KEY" \
  -v service="$SERVICE_TOKEN" \
  -v password="$BOOTSTRAP_PASSWORD" '
  BEGIN { FS = OFS = "=" }
  $1 == "JWT_SECRET" { $2 = jwt }
  $1 == "CSRF_SECRET" { $2 = csrf }
  $1 == "FIELD_ENCRYPTION_KEY" { $2 = field }
  $1 == "BLIND_INDEX_KEY" { $2 = blind }
  $1 == "SERVICE_TOKEN" { $2 = service }
  $1 == "BOOTSTRAP_ADMIN_PASSWORD" { $2 = password }
  { print }
' "$EXAMPLE" > "$TEMP"

mv "$TEMP" "$TARGET"
trap - EXIT

echo "Se creó $TARGET"
echo "Contraseña bootstrap inicial: $BOOTSTRAP_PASSWORD"
echo "Guárdela para el primer inicio de sesión."
