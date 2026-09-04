# Estado de verificación local

Fecha de ejecución: 2026-09-04. El despliegue externo está fuera de esta etapa.

## Resultado actual

- `npm run typecheck`: aprobado para contratos, React y NestJS.
- `npm test`: 3 suites y 8 pruebas NestJS aprobadas (validaciones, paginación,
  AES-256-GCM/HMAC y vector RFC 6238 TOTP).
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

## Automatización de ingreso — 2026-09-04

- OpenRouter respondió correctamente con `google/gemini-2.5-flash-lite`, salida
  estructurada, identificador de solicitud y costo informado, usando una imagen
  sintética y la ruta de proveedor sin recolección/ZDR.
- PeruDevs respondió HTTP 200 con JSON usando una consulta técnica; no se
  imprimió ni almacenó el resultado personal devuelto.
- Suite NestJS: 6/6 pruebas aprobadas, incluidas DNI, celular, nombres, correo,
  historia clínica y fechas.
- Suite ML en Python 3.12/CPU: 13/13 pruebas aprobadas, incluida conversión DICOM
  a PNG sin metadatos y enmascaramiento de bordes.
- Compilación completa de contratos, React y NestJS: aprobada.
- Compose reconstruido; PostgreSQL, FastAPI y `web-api` iniciaron sanos y la
  migración de prevalidación fue aplicada.

El smoke test ahora utiliza exclusivamente una cuenta médica indicada mediante
`SMOKE_CLINICIAN_EMAIL` y `SMOKE_CLINICIAN_PASSWORD`; nunca modifica ni
deshabilita el MFA del administrador.

## Panel por roles y reporte v2 — 2026-09-04

- Acceso médico sin MFA local: HTTP 201 y cookies de sesión/CSRF correctas.
- Un médico autenticado recibió HTTP 403 al consultar una ruta administrativa.
- Listado paginado y filtrado por médico responsable: aprobado.
- Reporte enriquecido por episodio: HTTP 200, firma `%PDF` y 599 010 bytes con
  los recursos gráficos del estudio de prueba.
- Migración de propiedad, perfiles, configuración y tipo de reporte: aplicada.
- Limpieza solicitada: 6 pacientes, 23 assets, 6 reportes y 88 eventos de
  auditoría eliminados; la cuenta administrativa original fue conservada.

## Flujo automático y expediente clínico — 2026-09-04

- Usuarios administrativos y médicos separados en el panel.
- Perfil clínico persistente por paciente y copia trazable por estudio.
- Inferencia CNN encolada automáticamente al guardar la radiografía.
- Smoke test: CNN CPU con 5 probabilidades, 2 Grad-CAM, XGBoost con 19
  variables, LSTM disponible, resumen de episodio y PDF válido.
- Tiempo radiológico observado en la prueba sintética: 0.24 s.
- La LSTM integra tanto antecedentes externos como episodios anteriores de la
  misma rodilla, siempre con fecha estrictamente anterior.

## Autenticación local temporal — 2026-09-04

- MFA deshabilitado temporalmente para administradores y médicos mediante
  `ADMIN_MFA_REQUIRED=false` y `CLINICIAN_MFA_REQUIRED=false`.
- Los secretos TOTP existentes no se eliminan, por lo que MFA puede reactivarse
  cambiando las variables de entorno a `true`.
- Inicio de sesión administrativo con contraseña y sin desafío MFA: aprobado.
- Creación de una cuenta con contraseña de exactamente 8 caracteres: aprobada.
- Creación de una cuenta con contraseña de 7 caracteres: rechazada con HTTP 400.
- Estado final de prueba: solo permanece el administrador base; no quedan
  sesiones, eventos de auditoría ni registros clínicos de la validación.

## Listado de cuentas y elegibilidad LSTM — 2026-09-04

- El endpoint administrativo de usuarios lista todas las cuentas de acceso,
  incluidos administradores y médicos, con paginación y búsqueda.
- Verificación local: 2 cuentas totales; la única cuenta médica aparece tanto
  en Usuarios como en Médicos.
- La edición desde Usuarios conserva el rol y los datos profesionales; el alta
  de médicos continúa disponible exclusivamente en la sección Médicos.
- Para un estudio actual KL4, la progresión LSTM se presenta como “No
  aplicable”, porque KL4 es el máximo de la escala y fue excluido como `t2` del
  entrenamiento.

## Validación visual y reporte PDF — 2026-09-04

- El resultado explícito `is_radiograph=false` o `anatomy=other` bloquea el
  estudio, incluso con baja confianza; no existe excepción manual en cliente ni
  servidor. Una anatomía incierta se conserva para revisión humana.
- Pruebas ML: 16 aprobadas y 1 omitida; incluyen tres combinaciones de rechazo
  de contenido y un caso incierto permitido para revisión.
- Las barras KL usan porcentajes CSS válidos y reflejan la probabilidad real.
- La ficha limita cada tarjeta de estudio a 330 px y usa carrusel con ajuste;
  la radiografía del episodio mide 360 px de alto y 270 px en móvil.
- El PDF distribuye el contexto clínico en seis campos, contiene imágenes en
  marcos fijos y mantiene el pie dentro del área imprimible.
- Prueba PDF sintética: un estudio completo genera una sola página; la falla
  anterior generaba páginas adicionales durante la numeración.
