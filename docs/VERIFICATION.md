# Estado de verificación local

Fecha de ejecución: 2026-09-04. El despliegue externo está fuera de esta etapa.

## Resultado actual

- `npm run typecheck`: aprobado para contratos, React y NestJS.
- `npm test`: 2/2 pruebas NestJS aprobadas (AES-256-GCM/HMAC y vector RFC 6238 TOTP).
- `npm run build`: aprobado para los bundles de producción web y API.
- `docker compose build web-api ml-inference`: aprobado con imágenes CPU.
- `docker compose up -d`: PostgreSQL, FastAPI y NestJS/React iniciados correctamente.
- Página pública: HTTP 200 en `http://localhost:3000`, CSP activa y `Cache-Control: no-store`.
- Modelos: 51/51 hashes SHA-256 verificados antes de deserializar.
- Suite ML dentro de Docker: 12/12 pruebas aprobadas con los artefactos reales.
- Smoke test E2E: aprobado para MFA, sesión/CSRF, paciente cifrado, búsqueda HMAC,
  episodio, PNG ROI, CNN CPU, cinco probabilidades KL, dos Grad-CAM, revisión,
  datos clínicos, XGBoost con 19 features, LSTM y PDF borrador.
- Cola persistente: un trabajo sintético dejado en `RUNNING` fue recuperado y
  terminó en `SUCCEEDED` después de reiniciar `web-api`.
- Logs revisados: no se encontraron identificadores ni nombres del payload sintético.
- Consumo ocioso observado: FastAPI con modelos cargados entre 0.5 y 0.9 GiB;
  NestJS aproximadamente 55–60 MiB y PostgreSQL aproximadamente 50 MiB.

Las advertencias de XGBoost al cargar el artefacto son esperadas: el checkpoint
conserva configuración GPU y XGBoost la cambia explícitamente a CPU cuando no hay
una GPU visible. La inferencia y los tests finalizaron correctamente.

## Repetir las pruebas ML reales

Desde PowerShell en la raíz del repositorio:

```powershell
docker build --target test -f services/ml/Dockerfile -t oa-thesis-ml-test .
$modelPath = (Resolve-Path '.models\oa-final-2026-09-03').Path
docker run --rm -e MODEL_ROOT=/models --mount "type=bind,source=$modelPath,target=/models,readonly" oa-thesis-ml-test
```

Resultado esperado: `12 passed`. El smoke test funcional se repite con:

```powershell
node scripts/smoke-test.mjs
```

## Pendiente antes de uso clínico real

1. Validar el flujo E2E con muestras clínicas desidentificadas representativas:
   DICOM bilateral, PNG/JPG bilateral y ROI izquierda/derecha.
2. Hacer pruebas de interfaz en navegadores y dispositivos objetivo; actualmente
   no hay una suite automatizada de navegador.
3. Ejecutar el perfil CUDA en hardware NVIDIA y comparar paridad/latencia con CPU.
4. Completar revisión de permisos, sesiones, fuerza bruta y pruebas de seguridad.
5. Diseñar, cifrar y probar backup/restauración en un entorno descartable.
6. Obtener revisión clínica de la presentación, Grad-CAM y advertencias.
7. Completar la autorización institucional antes de ingresar información identificable.

Estos pendientes no impiden probar ahora el prototipo local con datos sintéticos
o correctamente desidentificados, pero sí impiden declararlo apto para atención
clínica o producción.
