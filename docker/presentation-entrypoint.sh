#!/usr/bin/env bash
set -Eeuo pipefail

CONFIG_FILE=/opt/oa/config/presentation.env
DATA_ROOT=/data
PGDATA=${DATA_ROOT}/postgres
RUNTIME_ROOT=${DATA_ROOT}/runtime
POSTGRES_PASSWORD_FILE=${RUNTIME_ROOT}/postgres-password

if [[ ! -r "${CONFIG_FILE}" ]]; then
  echo "No se encontro la configuracion incorporada en la imagen." >&2
  exit 1
fi

# La configuracion queda dentro de la imagen de presentacion; nunca se imprime.
set -a
# shellcheck disable=SC1090
source "${CONFIG_FILE}"
set +a

export NODE_ENV=production
export PORT=3000
export MODEL_ROOT=/opt/oa/models
export ASSET_ROOT=${DATA_ROOT}/assets
export ML_SERVICE_URL=http://127.0.0.1:8000
export DEPLOYMENT_ENV=local
export COOKIE_SECURE=false
export BOOTSTRAP_ADMIN_EMAIL=admin@local.com
export BOOTSTRAP_ADMIN_PASSWORD=admin12345
export DEV_ADMIN_PASSWORD=admin12345
export RESET_BOOTSTRAP_ADMIN_PASSWORD=false

mkdir -p "${ASSET_ROOT}" "${PGDATA}" "${RUNTIME_ROOT}"
chmod 700 "${RUNTIME_ROOT}"
chown -R postgres:postgres "${PGDATA}"

if [[ ! -s "${POSTGRES_PASSWORD_FILE}" ]]; then
  python - <<'PY' > "${POSTGRES_PASSWORD_FILE}"
import secrets
print(secrets.token_hex(32))
PY
  chmod 600 "${POSTGRES_PASSWORD_FILE}"
fi
POSTGRES_PASSWORD="$(<"${POSTGRES_PASSWORD_FILE}")"
export DATABASE_URL="postgresql://oa_app:${POSTGRES_PASSWORD}@127.0.0.1:5432/oa_app"

PGBIN="$(pg_config --bindir)"
if [[ ! -s "${PGDATA}/PG_VERSION" ]]; then
  runuser -u postgres -- "${PGBIN}/initdb" -D "${PGDATA}" --auth-local=trust --auth-host=scram-sha-256 >/dev/null
fi

runuser -u postgres -- "${PGBIN}/pg_ctl" -D "${PGDATA}" \
  -o "-c listen_addresses=127.0.0.1 -p 5432" -w start >/dev/null

if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='oa_app'" | grep -q 1; then
  runuser -u postgres -- createuser oa_app
fi
runuser -u postgres -- psql -v ON_ERROR_STOP=1 \
  -c "ALTER ROLE oa_app WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}'" >/dev/null
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname='oa_app'" | grep -q 1; then
  runuser -u postgres -- createdb -O oa_app oa_app
fi

cd /opt/oa/ml
python bootstrap_models.py
uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-access-log &
ML_PID=$!

for _attempt in $(seq 1 90); do
  if ! kill -0 "${ML_PID}" 2>/dev/null; then
    echo "El servicio de inferencia no pudo iniciar." >&2
    exit 1
  fi
  if python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/health/ready', timeout=2)" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/v1/health/ready', timeout=2)" >/dev/null 2>&1; then
  echo "El servicio de inferencia no alcanzo el estado listo." >&2
  exit 1
fi

cd /opt/oa/api
node dist/main.js &
API_PID=$!

shutdown() {
  trap - EXIT INT TERM
  kill "${API_PID:-}" "${ML_PID:-}" 2>/dev/null || true
  wait "${API_PID:-}" "${ML_PID:-}" 2>/dev/null || true
  runuser -u postgres -- "${PGBIN}/pg_ctl" -D "${PGDATA}" -m fast -w stop >/dev/null 2>&1 || true
}
trap shutdown EXIT INT TERM

echo "Software OA disponible en http://localhost:3000"
wait "${API_PID}"
