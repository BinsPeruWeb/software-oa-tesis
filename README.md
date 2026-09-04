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

### Servicios opcionales de automatización

El formulario puede completar nombres, apellidos, sexo y nacimiento mediante
PeruDevs cuando el usuario pulsa **Autocompletar**. También puede revisar la
imagen con OpenRouter y `google/gemini-2.5-flash-lite` antes de almacenarla. Las
claves se configuran exclusivamente en `.env`:

```text
PERUDEVS_API_KEY=...
OPENROUTER_ENABLED=true
OPENROUTER_API_KEY=...
```

El navegador nunca recibe esas claves. La revisión visual envía solamente una
miniatura PNG reducida, sin etiquetas DICOM y con sus bordes enmascarados; no
envía el archivo DICOM original. Se solicita una ruta sin retención ni
recolección de datos. El resultado solo filtra y sugiere formato/orientación:
no estima KL, no diagnostica y siempre puede requerir revisión humana.

No use esos servicios con información clínica identificable hasta que la
institución autorice expresamente a ambos proveedores y el flujo de datos.

No es necesario instalar Node, Python, crear una `venv` ni instalar PostgreSQL
en la laptop: esas versiones y dependencias se ejecutan dentro de los
contenedores. Las credenciales iniciales están en `.env`; en el primer acceso la
interfaz pedirá enrolar MFA con una aplicación autenticadora TOTP.

Para detener o volver a iniciar el entorno sin perder los datos locales:

```bash
docker compose stop
docker compose start
```

## Verificación local

El smoke test automatizado recorre autenticación, paciente sintético, revisión
visual de carga PNG,
CNN, Grad-CAM, revisión clínica, XGBoost, LSTM y reporte PDF:

```bash
node scripts/smoke-test.mjs
```

En entorno `local`, si el script tuvo que enrolar MFA, lo deja nuevamente
pendiente para que el propietario configure su propio autenticador. Para las
pruebas Python con los modelos reales se usa el objetivo Docker `test`; consulte
`docs/VERIFICATION.md` para los comandos y los resultados registrados.

El perfil NVIDIA local requiere NVIDIA Container Toolkit. Configure
`ML_SERVICE_URL=http://ml-inference-gpu:8000` y ejecute
`docker compose --profile gpu up --build`.

## Seguridad de datos

Nunca confirme DICOM, PNG/JPG clínicos, exportaciones, backups, `.env`, tokens o
claves. Las pruebas actuales deben usar únicamente datos sintéticos o
desidentificados. El despliegue externo se ha dejado deliberadamente para una
etapa posterior. Consulte `docs/SECURITY_CHECKLIST.md` antes de usar datos reales.
