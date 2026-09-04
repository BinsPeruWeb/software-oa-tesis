# Plataforma OA — tesis

Aplicación web de apoyo investigativo para clasificar osteoartritis de rodilla y
mostrar riesgos independientes de progresión y artroplastia. No sustituye la
decisión del traumatólogo ni emite indicaciones quirúrgicas.

## Componentes

- `apps/web`: PWA React/TypeScript.
- `apps/api`: API NestJS, PostgreSQL, autenticación, auditoría y reportes.
- `services/ml`: FastAPI/Python 3.12 para CNN, Grad-CAM, XGBoost y LSTM.
- `packages/contracts`: contratos compartidos del producto.
- `scripts`: importación y verificación de la entrega privada de modelos.

Los modelos no se almacenan en Git. La entrega original
`oa-final-2026-09-03` debe importarse en `.models/oa-final-2026-09-03` y superar
la comprobación SHA-256 antes de iniciar inferencia.

## Inicio local

1. Instale Git y Docker Desktop.
2. Ejecute `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1`
   para crear `.env` con secretos distintos y aleatorios.
3. Importe los modelos en PowerShell:

   ```powershell
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/models.ps1 -SourceDirectory ../entrega_software_oa_final
   ```

4. Inicie el perfil CPU:

   ```bash
   docker compose up --build
   ```

5. Abra `http://localhost:3000`.

El perfil NVIDIA local requiere NVIDIA Container Toolkit. Configure
`ML_SERVICE_URL=http://ml-inference-gpu:8000` y ejecute
`docker compose --profile gpu up --build`.

## Datos y despliegue

Nunca confirme DICOM, PNG/JPG clínicos, exportaciones, backups, `.env`, tokens o
claves. `staging` admite únicamente datos sintéticos/desidentificados. El entorno
Railway de producción con datos identificables no debe habilitarse sin aprobación
institucional y revisión de seguridad documentada. Consulte `docs/DEPLOYMENT.md`
y `docs/SECURITY_CHECKLIST.md`.
