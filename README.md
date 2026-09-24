# Plataforma OA para apoyo clínico experimental

Aplicación web para gestionar pacientes y episodios radiográficos de rodilla,
clasificar el grado de osteoartritis Kellgren-Lawrence (KL), generar mapas
Grad-CAM y estimar por separado los riesgos de artroplastia y progresión.

## Arquitectura

- `apps/web`: PWA en React y TypeScript.
- `apps/api`: API NestJS, autenticación, reglas clínicas, auditoría y PDF.
- `services/ml`: FastAPI con Python 3.12 para CNN, Grad-CAM, XGBoost y LSTM.
- `packages/contracts`: contratos compartidos entre frontend y backend.
- PostgreSQL 18: persistencia de usuarios, pacientes, estudios y resultados.
- Docker Compose: ejecución reproducible sin instalar Node, Python ni PostgreSQL.

La aplicación maneja dos roles:

- **Administrador técnico:** dashboard, cuentas de usuario, CRUD de médicos,
  auditoría y configuración. Al registrar un médico se crea su usuario.
- **Médico:** dashboard clínico, pacientes propios, historia clínica, estudios,
  análisis, revisiones y reportes.

Cada paciente pertenece a un único médico responsable. Su número de historia
clínica se genera automáticamente con el formato `OA-000001`.

## Imagen autónoma para presentación

La variante de presentación incorpora en una sola imagen la aplicación web, la
API, PostgreSQL, el servicio de inferencia, los modelos entrenados y la
configuración de las integraciones. El equipo receptor solo necesita Docker;
no requiere clonar el repositorio, descargar los modelos ni proporcionar un
archivo `.env`.

Una vez publicada la imagen, se inicia con un único comando:

```bash
docker run -d --name software-oa -p 3000:3000 \
  -v software-oa-data:/data --restart unless-stopped \
  diegovj24/software-oa-presentacion:1.0.2
```

En PowerShell puede escribirse en una sola línea. Después se abre
`http://localhost:3000` y se utilizan estas credenciales iniciales:

```text
Usuario: admin@local.com
Contraseña: admin12345
```

Cada volumen nuevo comienza con un único administrador y sin pacientes,
estudios ni reportes. El volumen `software-oa-data` conserva la base de datos y
los archivos al detener, eliminar o actualizar el contenedor.

Para construir la imagen de presentación desde el equipo autorizado que posee
el `.env` y los modelos locales:

```bash
docker build -f Dockerfile.presentation \
  -t diegovj24/software-oa-presentacion:1.0.2 .
docker push diegovj24/software-oa-presentacion:1.0.2
```

Esta variante incluye deliberadamente la configuración privada dentro de la
imagen y está destinada únicamente a la presentación controlada. La
arquitectura Compose descrita a continuación continúa siendo la opción de
desarrollo y despliegue normal.

## Requisitos para ejecutar una copia clonada

En el dispositivo se necesita:

1. Windows 10/11, macOS o Linux de 64 bits.
2. [Git](https://git-scm.com/downloads).
3. Docker Desktop con Docker Compose v2, o Docker Engine + el complemento
   Compose v2 en Linux.
4. Acceso a este repositorio privado y al Release privado de modelos.
5. Al menos 8 GB de RAM y 10 GB de espacio libre. Se recomiendan 16 GB de RAM
   para una inferencia CPU más cómoda.

No se necesita instalar Node.js, npm, Python, una `venv`, PyTorch ni PostgreSQL
en el sistema anfitrión: todos se ejecutan dentro de contenedores.

## Instalación paso a paso

### 1. Clonar el repositorio

```bash
git clone https://github.com/BinsPeruWeb/software-oa-tesis.git
cd software-oa-tesis
```

Por tratarse de un repositorio privado, GitHub solicitará iniciar sesión o usar
una credencial personal autorizada.

### 2. Crear la configuración local

En Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/setup-env.ps1
```

En macOS o Linux:

```bash
chmod +x scripts/setup-env.sh scripts/models.sh
./scripts/setup-env.sh
```

El script crea `.env`, genera claves aleatorias independientes y muestra la
contraseña inicial del administrador. Guarde esa contraseña para el primer
inicio de sesión. El correo inicial se configura en
`BOOTSTRAP_ADMIN_EMAIL` dentro de `.env`.

Las integraciones externas son opcionales. Para habilitarlas, edite `.env`:

```text
PERUDEVS_API_KEY=
OPENROUTER_ENABLED=true
OPENROUTER_API_KEY=
OPENROUTER_MODEL=google/gemini-2.5-flash-lite
OPENROUTER_RECOMMENDATION_MODEL=google/gemini-3.8-flash
```

Las claves solo se usan en el backend y nunca se envían al navegador.

### 3. Instalar el paquete privado de modelos

Los modelos no están en Git. Descargue desde la sección **Releases** del
repositorio el archivo `models-oa-final-2026-09-03.zip` y manténgalo comprimido.

En Windows PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/models.ps1 `
  -PackageZip "$HOME\Downloads\models-oa-final-2026-09-03.zip"
```

En macOS o Linux:

```bash
./scripts/models.sh "$HOME/Downloads/models-oa-final-2026-09-03.zip"
```

Si ya se recibió la carpeta original sin comprimir, también puede importarse:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/models.ps1 `
  -SourceDirectory "C:\ruta\entrega_software_oa_final"
```

```bash
./scripts/models.sh /ruta/entrega_software_oa_final
```

Ambos scripts instalan el paquete en `.models/oa-final-2026-09-03`, comprueban
el Release esperado y verifican los 51 hashes SHA-256 antes de aceptar los
artefactos. La carpeta `.models` permanece fuera de Git.

### 4. Construir e iniciar la aplicación

Compruebe que Docker esté iniciado y ejecute:

```bash
docker compose up --build -d
```

La primera construcción descarga imágenes y dependencias, por lo que puede
tardar varios minutos. Consulte el estado con:

```bash
docker compose ps
```

Cuando `postgres` y `ml-inference` aparezcan saludables y `web-api` esté en
ejecución, abra:

```text
http://localhost:3000
```

Inicie sesión con `BOOTSTRAP_ADMIN_EMAIL` y la contraseña mostrada en el paso
2. Las migraciones se aplican automáticamente sobre una base nueva.

### 5. Detener y reanudar

Para detener los contenedores sin eliminar pacientes ni archivos locales:

```bash
docker compose stop
```

Para reanudarlos:

```bash
docker compose start
```

Para ver registros de ejecución:

```bash
docker compose logs -f web-api ml-inference
```

## Uso funcional resumido

1. El administrador registra un médico con DNI, CMP y establecimiento de
   salud; PeruDevs puede completar el nombre y la cuenta se crea automáticamente.
2. El médico registra un paciente o usa PeruDevs para autocompletar el DNI.
3. Completa el perfil clínico del paciente: dolor, obesidad, diabetes,
   hipertensión, nicotina y trauma de miembro inferior.
4. Carga una radiografía DICOM, PNG o JPG y selecciona la rodilla.
5. El sistema valida la imagen, ejecuta KL y Grad-CAM, y calcula los riesgos
   que estén disponibles.
6. OpenRouter genera una orientación individual desidentificada; con dos o más
   estudios también genera una orientación longitudinal en la ficha.
7. El médico consulta el análisis del episodio, confirma o corrige KL y genera
   un PDF por episodio o longitudinal.

La LSTM se habilita cuando existen dos observaciones confirmadas de la misma
rodilla con fechas diferentes y el KL actual no es 4. Puede usar un análisis
anterior del sistema o un examen histórico registrado en la ficha. Los estudios
se ordenan siempre por la fecha del examen: pueden cargarse en cualquier orden y
los riesgos posteriores se recalculan automáticamente.

Los pacientes archivados continúan visibles con sus análisis y reportes, pero
quedan en modo de solo lectura y no admiten nuevos estudios ni modificaciones.

## Formatos de imagen

- `DICOM_BILATERAL`: radiografía bilateral DICOM.
- `RASTER_BILATERAL`: radiografía bilateral PNG o JPG.
- `RASTER_SINGLE_ROI`: PNG o JPG ya recortado a una rodilla.

La fecha del estudio se registra siempre en el formulario y no se reemplaza con
la fecha incluida en los metadatos DICOM. Esa fecha registrada y la fecha de
nacimiento de la ficha determinan `age_at_exam` para XGBoost y LSTM. La
identidad del paciente se toma siempre de su ficha. PNG y JPG no requieren
campos clínicos adicionales.
La revisión visual opcional mediante OpenRouter recibe una miniatura sin
metadatos y bloquea archivos que no correspondan a una radiografía de rodilla.
Las orientaciones reciben únicamente grados, probabilidades, indicadores
clínicos y tiempos relativos: no se envían nombres, DNI, historia clínica,
contacto, fechas exactas ni imágenes.

## Verificación para desarrollo

Con Node.js instalado localmente, las comprobaciones rápidas son:

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Node local solo es necesario para desarrollar o ejecutar estas comprobaciones;
no es necesario para usar la aplicación con Docker.

El smoke test recorre autenticación médica, paciente sintético, carga PNG, CNN,
Grad-CAM, revisión, XGBoost, LSTM y PDF:

```bash
node scripts/smoke-test.mjs
```

Antes debe crear una cuenta médica de prueba y configurar en `.env`:

```text
SMOKE_CLINICIAN_EMAIL=medico-pruebas@example.invalid
SMOKE_CLINICIAN_PASSWORD=una-contraseña-de-pruebas
```

Los contratos ML y las pruebas registradas están en
[`docs/MODEL_CONTRACTS.md`](docs/MODEL_CONTRACTS.md) y
[`docs/VERIFICATION.md`](docs/VERIFICATION.md).

## Perfil NVIDIA opcional

El perfil CPU es el predeterminado. Para una GPU NVIDIA se necesita NVIDIA
Container Toolkit. Después configure en `.env`:

```text
ML_SERVICE_URL=http://ml-inference-gpu:8000
```

E inicie el perfil:

```bash
docker compose --profile gpu up --build -d
```

## Modelo de base de datos y backlog

- [`docs/database.dbml`](docs/database.dbml): esquema listo para pegar o
  importar en dbdiagram.io.
- [`docs/software_oa_sql_server.sql`](docs/software_oa_sql_server.sql): creación
  completa del modelo equivalente para Microsoft SQL Server 2019/2022.
- [`docs/modelo_datos_explicado.txt`](docs/modelo_datos_explicado.txt):
  explicación breve y sencilla de las tablas y sus relaciones.
- [`context_product_backlog.md`](context_product_backlog.md): contexto funcional
  y técnico para generar el product backlog en una hoja de cálculo.

## Datos locales y secretos

`.env`, `.models`, `.data`, radiografías, Grad-CAM, PDF y volúmenes de
PostgreSQL están excluidos del repositorio. No confirme tokens, contraseñas,
imágenes clínicas, exportaciones ni copias de seguridad.

El entorno local actual permite configurar MFA por rol mediante
`ADMIN_MFA_REQUIRED` y `CLINICIAN_MFA_REQUIRED`. El despliegue externo se
mantiene fuera de esta etapa.
