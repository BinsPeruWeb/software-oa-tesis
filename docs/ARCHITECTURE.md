# Arquitectura y límites de confianza

```text
Navegador PWA
    │ HTTPS + cookie HttpOnly + CSRF
    ▼
web-api (NestJS, único servicio público)
    ├── PostgreSQL privado: entidades, cola y auditoría
    ├── volumen cifrado: radiografías, Grad-CAM y PDF
    └── red privada + token de servicio
             ▼
       ml-inference (FastAPI)
             ├── volumen de modelos verificados por SHA-256
             └── OpenRouter: prevalidación visual y orientación desidentificada
```

React nunca calcula features ni llama directamente a FastAPI. NestJS envía conceptos clínicos y FastAPI vuelve a validar y deriva el vector final. FastAPI y PostgreSQL no deben recibir un dominio público.

Para recomendaciones, NestJS transforma la cronología a números de secuencia e
intervalos relativos. OpenRouter no recibe nombres, documentos, historia clínica,
contacto, fechas exactas ni imágenes del paciente; la respuesta estructurada se
valida y se cifra antes de persistirse.

## Datos y cifrado

- Cada campo identificable y cada archivo se cifra con AES-256-GCM y contexto autenticado.
- DNI e historia clínica tienen índices HMAC-SHA-256 para búsqueda exacta; no hay índices de texto plano.
- Las claves de cifrado, índice y sesión son distintas.
- Los logs no incluyen cuerpos, nombres de archivo, tags DICOM ni datos del paciente.
- La PWA no guarda pacientes o resultados en `localStorage`, IndexedDB ni Cache Storage. El service worker excluye `/api`.
- `audit_events` tiene un trigger que impide `UPDATE` y `DELETE`.

El cifrado de aplicación no sustituye cifrado de volumen, TLS, controles del proveedor, rotación de claves ni backups cifrados.

## Cola

Los trabajos se reclaman con `FOR UPDATE SKIP LOCKED`. Antes de arrancar el worker, cualquier trabajo `RUNNING` se devuelve a `QUEUED`. La clave de idempotencia evita duplicar solicitudes. Un resultado CNN genera un segundo trabajo persistente para los dos Grad-CAM.

## Modelos

La imagen de aplicación no contiene modelos. El arranque verifica los hashes congelados antes de `torch.load` o `joblib.load`. En Railway, el contenedor puede descargar un ZIP privado a su volumen cuando `MODEL_PACKAGE_URL` está configurada. Un fallo mantiene `/v1/health/ready` en 503.
