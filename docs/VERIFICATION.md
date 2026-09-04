# Estado de verificación

## Ejecutado en la estación de desarrollo

- `npm run typecheck`: aprobado para contratos, React y NestJS.
- `npm test`: aprobadas pruebas de AES-GCM/HMAC y vector RFC 6238 TOTP.
- `npm run build`: aprobado; genera bundles de producción web y API.
- `npm audit --omit=dev --offline`: 0 vulnerabilidades conocidas en el índice local.
- Verificación SHA-256: aprobados los 51 archivos en la fuente inmutable y en `.models`.
- Compilación sintáctica Python: aprobada para aplicación y pruebas.
- Parseo de `compose.yaml` y archivos JSON: aprobado.

## Preparado, pendiente de infraestructura

- Las pruebas Python cubren PNG, JPG, DICOM, polaridad, espejo izquierdo, orden XGBoost, faltantes, antecedentes inválidos, elegibilidad LSTM e integridad de artefactos.
- La prueba marcada `models` carga el paquete completo y verifica suma de probabilidades y promedio CNN 50/50.
- CI ejecuta build y contratos sin incorporar modelos privados.

No se ejecutaron todavía `docker compose`, la inferencia completa PyTorch, el perfil CUDA, reinicio real durante inferencia, restauración de backup ni despliegue Railway: Docker no está instalado en esta estación y aún no existen los recursos privados de Railway/GitHub. Deben completarse antes de declarar el sistema listo para uso clínico.

## Criterios antes de staging

1. Ejecutar `pytest services/ml/tests -m models` dentro del contenedor con el volumen verificado.
2. Completar un flujo E2E con DICOM, PNG/JPG bilateral y ROI de ambos lados.
3. Interrumpir ML durante un trabajo y confirmar su recuperación.
4. Ejecutar revisión de permisos, sesiones, MFA, fuerza bruta y ausencia de PHI.
5. Medir memoria y latencia CPU; luego fijar límites Railway.
6. Probar backup y restauración en un ambiente descartable.

