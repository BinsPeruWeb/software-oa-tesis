# Operación local y Railway

## Clonación local

Requisitos del host: Git y Docker Desktop. No se requiere Python, Node, PostgreSQL ni `venv`.

```powershell
git clone <URL-PRIVADA>
cd software_oa
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/models.ps1 -SourceDirectory "C:\ruta\entrega_software_oa_final"
docker compose up --build
```

Abra `http://localhost:3000`. El script muestra la contraseña bootstrap generada; guárdela de forma segura. Para GPU local configure `ML_SERVICE_URL=http://ml-inference-gpu:8000` y use `docker compose --profile gpu up --build`; requiere NVIDIA Container Toolkit.

## Release privado

Publique `models-oa-final-2026-09-03.zip` como asset de un Release privado. El ZIP debe contener `MANIFEST.json` en la raíz (o una carpeta raíz única). Configure `MODEL_PACKAGE_URL` con la URL API/browser del asset y `GH_MODELS_TOKEN` con acceso de solo lectura. Los scripts rechazan una versión incorrecta, archivos faltantes y cualquiera de los 51 hashes alterados.

## Railway

Cree recursos independientes desde el mismo repositorio:

1. PostgreSQL administrado.
2. `ml-inference`, usando `railway.ml.json`, sin dominio público y con volumen montado en `/models`.
3. `web-api`, usando `railway.web.json`, con volumen montado en `/data/assets` y único dominio público.

Variables mínimas de `web-api`: `DATABASE_URL`, `JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `SERVICE_TOKEN`, `ML_SERVICE_URL`, `ASSET_ROOT`, credenciales bootstrap, `COOKIE_SECURE=true`, `DEPLOYMENT_ENV=production` y `CLINICAL_PRODUCTION_APPROVED=false`.

Variables mínimas de ML: `MODEL_ROOT=/models`, `MODEL_PACKAGE_URL`, `GH_MODELS_TOKEN`, `SERVICE_TOKEN`, `DEVICE=cpu` y `PORT` provisto por Railway. Use la dirección DNS privada para `ML_SERVICE_URL`.

Separe proyectos/ambientes `staging` y `production`, secretos, volúmenes y bases. Staging solo acepta información sintética o desidentificada. La API rechaza escrituras clínicas en producción mientras `CLINICAL_PRODUCTION_APPROVED` no sea `true`; solo cámbielo después de aprobar toda la puerta institucional.

## Puerta de producción clínica

No cargue datos identificables hasta documentar autorización hospitalaria, responsables, contrato/plan del proveedor, región, retención y borrado, backups/restauración, incidentes, cifrado y custodia/rotación de claves. La sola capacidad técnica de desplegar no constituye autorización para operar con datos clínicos reales.
