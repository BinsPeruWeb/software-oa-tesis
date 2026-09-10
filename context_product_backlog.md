# Contexto para construir el Product Backlog — Plataforma OA

## 1. Propósito de este documento

Este archivo reúne el alcance funcional y técnico implementado en la plataforma
OA hasta el 4 de septiembre de 2026. Está preparado como fuente para que otra
herramienta genere un Product Backlog en Excel.

El backlog resultante debe representar capacidades del producto y criterios de
aceptación. No debe reconstruir conversaciones, iteraciones de diseño ni una
cronología de cambios.

## 2. Visión del producto

La Plataforma OA es una aplicación web de apoyo clínico experimental para la
gestión y seguimiento de pacientes con osteoartritis de rodilla. Centraliza la
historia clínica relevante, el análisis radiográfico, la explicación visual de
los modelos y dos estimaciones de riesgo longitudinal.

Objetivos principales:

- organizar pacientes y estudios por médico responsable;
- aceptar radiografías DICOM, PNG y JPG;
- clasificar el grado Kellgren-Lawrence de 0 a 4;
- mostrar probabilidades por clase y mapas Grad-CAM;
- estimar riesgo de artroplastia a 24 meses con XGBoost;
- estimar progresión de al menos un grado KL en 3 a 12 meses con LSTM;
- conservar trazabilidad de entradas, modelos, revisiones y reportes;
- ofrecer una experiencia administrativa y clínica adaptable a escritorio y
  móvil;
- permitir que el proyecto sea clonado y ejecutado con Docker.

## 3. Actores y permisos

### 3.1 Administrador técnico

Tiene acceso al espacio administrativo y puede:

- iniciar sesión en el panel;
- consultar indicadores operativos del dashboard;
- listar todas las cuentas de acceso, incluidas las cuentas de médicos;
- editar datos de una cuenta existente;
- activar o desactivar cuentas y cerrar sus sesiones al desactivarlas;
- consultar médicos en un módulo separado;
- registrar, editar, activar y desactivar médicos;
- crear automáticamente una cuenta de usuario al registrar un médico;
- registrar DNI, CMP y establecimiento de salud del médico;
- consultar la auditoría inmutable con búsqueda y paginación;
- configurar nombre institucional, subtítulo del reporte y prefijo de historia
  clínica.

El administrador técnico no accede al contenido clínico de pacientes, estudios
o reportes.

### 3.2 Médico

Tiene acceso al espacio clínico y puede:

- iniciar sesión en el panel;
- consultar el dashboard de su actividad;
- registrar, editar y archivar pacientes propios;
- buscar por nombre, DNI o número de historia clínica;
- consultar únicamente pacientes bajo su responsabilidad;
- completar y actualizar el perfil clínico del paciente;
- registrar exámenes históricos externos de la misma rodilla;
- crear episodios y cargar radiografías;
- consultar estudios, trabajos de inferencia y resultados;
- confirmar o corregir el KL estimado;
- consultar Grad-CAM y los riesgos disponibles;
- generar y descargar reportes por episodio y longitudinales.

Cada paciente tiene un solo médico responsable: el médico que lo registra.

## 4. Arquitectura del producto

El repositorio es un monorepo compuesto por:

- frontend PWA en React y TypeScript;
- API pública en NestJS;
- servicio privado de inferencia en FastAPI y Python 3.12;
- PostgreSQL 18;
- contratos TypeScript compartidos;
- almacenamiento de archivos cifrados;
- Docker Compose para ejecución local;
- Dockerfile CPU y perfil opcional NVIDIA/CUDA;
- migraciones SQL, pruebas y CI con GitHub Actions.

Flujo de comunicación:

```text
PWA React
  -> API NestJS
       -> PostgreSQL
       -> almacenamiento cifrado
       -> FastAPI ML
            -> modelos verificados por SHA-256
```

React envía datos semánticos. La construcción de features y el
preprocesamiento de imágenes se realizan en FastAPI.

## 5. Módulos funcionales implementados

### 5.1 Autenticación y sesión

- acceso por correo y contraseña;
- contraseñas con longitud de 8 a 128 caracteres;
- hash Argon2id;
- cookies de sesión HttpOnly;
- protección CSRF;
- expiración, revocación y seguimiento de último uso de sesiones;
- conteo de intentos fallidos y bloqueo temporal;
- cierre de sesión;
- MFA TOTP configurable por rol mediante variables de entorno;
- cuenta administrativa bootstrap creada al iniciar una base nueva.

### 5.2 Navegación y diseño

- panel administrativo y panel médico diferenciados;
- sidebar de escritorio plegable;
- menú hamburguesa móvil con fondo de cierre;
- dashboard con métricas y accesos rápidos;
- tarjetas, badges, estados vacíos y componentes reutilizables;
- tablas adaptables: cambian a presentación vertical en pantallas pequeñas;
- paginación de 10 registros;
- formularios de registro y edición en modales;
- confirmaciones para acciones de estado y archivo;
- toasts en la esquina inferior derecha;
- diseño sin desplazamiento horizontal en escritorio o móvil.

### 5.3 Administración de usuarios

- listado de todas las cuentas de acceso;
- búsqueda por nombre o correo;
- visualización de rol, estado y último acceso;
- edición de nombre, correo y contraseña opcional;
- activación y desactivación;
- inclusión de usuarios médicos creados desde el módulo Médicos.

### 5.4 Administración de médicos

- listado y búsqueda de médicos;
- registro de DNI peruano, nombre, correo, CMP, establecimiento de salud y
  contraseña inicial;
- autocompletado del nombre mediante PeruDevs a partir del DNI;
- almacenamiento cifrado del DNI e índice HMAC para búsqueda exacta;
- generación de una contraseña legible que cumple la longitud mínima;
- visualización y copia de la contraseña antes de guardar;
- creación atómica del perfil médico y su cuenta de acceso;
- edición de identidad profesional y credenciales;
- activación y desactivación con confirmación;
- contraseña mínima de 8 caracteres.

### 5.5 Pacientes e historia clínica

- listado paginado de pacientes propios;
- búsqueda por nombre, DNI o historia clínica;
- registro y edición mediante modal;
- DNI peruano de exactamente 8 dígitos;
- nombres y apellidos entre 2 y 80 caracteres con caracteres de nombre válidos;
- fecha de nacimiento válida, no futura y con antigüedad máxima de 130 años;
- sexo femenino, masculino o no registrado;
- celular de 9 dígitos que comienza con 9;
- correo opcional válido de hasta 254 caracteres;
- generación automática correlativa del número de historia clínica;
- prefijo institucional de historia clínica configurable;
- ficha del paciente con identidad, contacto y médico propietario;
- edición de datos y archivado lógico;
- separación de pacientes por médico responsable.

### 5.6 Autocompletado por DNI

- consulta manual mediante botón Autocompletar;
- consumo de PeruDevs desde NestJS;
- envío del DNI y token únicamente desde el backend;
- autocompletado de nombres, apellidos, sexo y fecha de nacimiento;
- datos retornados editables antes de guardar;
- validación local y de backend posterior a la consulta.

### 5.7 Perfil clínico del paciente

Se registra una vez en la historia clínica y puede actualizarse:

- dolor entre 0 y 10, opcional y con decimales;
- obesidad: Sí/No;
- diabetes: Sí/No;
- hipertensión: Sí/No;
- consumo de nicotina: Sí/No;
- trauma de miembro inferior: Sí/No.

Los cinco indicadores deben seleccionarse explícitamente. Al crear un análisis,
el sistema toma una fotografía de estos valores para conservar su contexto
temporal. La ficha clínica debe estar completa antes de abrir el flujo de nuevo
análisis.

### 5.8 Exámenes históricos

- registro de estudios anteriores que no fueron procesados en la plataforma;
- fecha del examen;
- rodilla izquierda o derecha;
- KL confirmado entre 0 y 4;
- dolor histórico opcional;
- cinco indicadores clínicos históricos;
- listado por paciente y orden cronológico;
- eliminación mediante confirmación;
- uso automático como antecedente para riesgos longitudinales;
- separación estricta por rodilla y fecha.

### 5.9 Episodios y carga de radiografías

- creación automática del episodio al guardar una carga válida;
- selección de fecha del examen;
- selección explícita de rodilla izquierda o derecha;
- carga mediante selector o arrastrar y soltar;
- aceptación de DICOM, PNG y JPG;
- límite de archivo y validación de extensión, MIME y contenido;
- detección automática del tipo de entrada:
  - DICOM bilateral;
  - raster bilateral;
  - raster de una sola rodilla ya recortada;
- opciones avanzadas disponibles cuando corresponden:
  - inversión de polaridad declarada;
  - corrección horizontal global;
- extracción de fecha DICOM cuando está disponible;
- identidad del paciente tomada siempre de la ficha registrada;
- inicio automático del análisis después de guardar.

### 5.10 Revisión visual previa con OpenRouter

- integración backend con OpenRouter;
- modelo configurable, con Gemini Flash Lite como configuración inicial;
- conversión de DICOM a miniatura PNG apta para revisión visual;
- eliminación de metadatos DICOM de la solicitud;
- reducción y enmascarado de bordes de la miniatura;
- clasificación previa del contenido como radiografía de rodilla admitida;
- identificación sugerida de diseño bilateral o de una sola rodilla;
- rechazo del estudio cuando no es una radiografía o no contiene una rodilla;
- almacenamiento del estado, modelo proveedor, hash de entrada, evaluación y
  vencimiento de la revisión;
- reutilización temporal por hash, usuario y vigencia;
- funcionamiento configurable mediante variables de entorno.

### 5.11 Clasificación KL con ensemble CNN

- preprocesamiento determinista de DICOM, PNG y JPG;
- lectura de píxeles DICOM, VOI LUT, polaridad y orientación;
- conversión raster a escala de grises;
- normalización por percentiles 0.5 y 99.5;
- división bilateral y selección de la rodilla solicitada;
- espejo de la rodilla izquierda para la orientación entrenada;
- redimensionamiento final a 320 x 320;
- inferencia con ResNet50 y DenseNet121;
- ensemble fijo 50/50;
- predicción KL de 0 a 4;
- confianza y cinco probabilidades del ensemble;
- cinco probabilidades individuales por backbone;
- probabilidades normalizadas que suman uno;
- registro de versión, hashes, entrada, pipeline, dispositivo y latencia;
- ejecución CPU predeterminada y GPU NVIDIA opcional.

### 5.12 Grad-CAM

- generación automática después de la clasificación KL;
- un mapa para ResNet50 y otro para DenseNet121;
- objetivo asociado al KL estimado;
- almacenamiento cifrado de las imágenes;
- visualización conjunta en el análisis completo;
- inclusión en reportes cuando están disponibles.

### 5.13 Revisión clínica de KL

- visualización inmediata del resultado automatizado;
- confirmación del KL estimado por el médico;
- corrección a un KL de 0 a 4;
- registro de decisión, profesional y fecha;
- actualización del KL clínico usado por los riesgos y reportes;
- conservación de la predicción original.

### 5.14 Riesgo de artroplastia con XGBoost

Objetivo: riesgo calibrado a 24 meses. Umbral congelado:
`0.2574747475`.

El servicio construye exactamente estas 19 features y en este orden:

1. `age_at_exam`
2. `KLG`
3. `pain_score`
4. `pain_missing`
5. `obesity`
6. `diabetes`
7. `hypertension`
8. `nicotine_use`
9. `trauma_lower_extremity`
10. `sex_female`
11. `sex_missing`
12. `knee_left`
13. `prior_KLG`
14. `years_since_prior`
15. `kl_change_from_prior`
16. `prior_kl_rate`
17. `n_prior_exams`
18. `years_since_first`
19. `kl_change_from_first`

Reglas funcionales:

- la edad se deriva de nacimiento y fecha índice;
- KLG proviene del KL clínico actual;
- dolor y sexo admiten ausencia mediante indicadores específicos;
- los cinco indicadores clínicos no tienen valores predeterminados silenciosos;
- solo se consideran antecedentes anteriores de la misma rodilla;
- en el primer examen, las variables previas son nulas, el conteo es cero y
  los cambios desde el primero son cero;
- se muestra riesgo porcentual, umbral, clasificación de tamiz, versión y
  horizonte;
- el cálculo se ejecuta y registra automáticamente cuando el episodio es
  elegible.

### 5.15 Riesgo de progresión con LSTM

Objetivo: riesgo de aumentar al menos un grado KL en 3 a 12 meses. Umbral
congelado: `0.4802020202`.

Datos utilizados por cada tiempo:

- KLG confirmado;
- edad en el examen;
- dolor o indicador de dolor faltante;
- intervalo temporal;
- obesidad;
- diabetes;
- hipertensión;
- consumo de nicotina;
- trauma de miembro inferior;
- lateralidad.

Reglas funcionales:

- utiliza exactamente dos observaciones cronológicas, t1 y t2;
- t2 es el episodio actual y t1 es la observación previa más reciente;
- ambas observaciones pertenecen al mismo paciente y rodilla;
- las fechas deben ser distintas;
- ambos KL deben estar confirmados;
- t2 con KL4 no es elegible;
- puede usar un análisis previo interno o un examen histórico externo;
- sexo no forma parte de las features;
- normalizadores, mediana y umbral se cargan desde el checkpoint;
- se deriva cambio KL, tasa anual KL, cambio de dolor e intervalo t1-t2;
- se muestra la disponibilidad del resultado y su razón funcional;
- el cálculo se ejecuta y registra automáticamente cuando existen los datos.

### 5.16 Cola persistente de inferencia

- estados `QUEUED`, `RUNNING`, `SUCCEEDED` y `FAILED`;
- tipos de trabajo KL y Grad-CAM;
- claves de idempotencia para evitar duplicados;
- correlation ID por trabajo;
- registro de intentos, inicio, fin y código de error;
- reclamación concurrente mediante `FOR UPDATE SKIP LOCKED`;
- recuperación de trabajos en ejecución después de reiniciar;
- consulta de estado desde el frontend;
- actualización automática de resultados durante el procesamiento.

### 5.17 Ficha del paciente y seguimiento visual

- cabecera con datos demográficos y contacto;
- edición y archivo mediante acciones controladas;
- acceso al perfil clínico y exámenes históricos;
- acción de nuevo análisis condicionada por historia clínica completa;
- línea de tiempo visual de análisis por episodio;
- tarjetas con ancho máximo cuando existe un solo estudio;
- carrusel cuando existen varios estudios;
- imagen radiográfica contenida en dimensiones fijas sin recorte;
- fecha, lateralidad, KL, confianza y riesgos resumidos por tarjeta;
- botón Ver análisis para abrir el detalle del episodio.

### 5.18 Vista completa de análisis por episodio

- radiografía original en un visor de tamaño controlado;
- ajuste `contain` para imágenes bilaterales y de una sola rodilla;
- fecha y lateralidad;
- estado de procesamiento;
- KL estimado y KL clínico confirmado;
- tiempo de evaluación radiológica en segundos;
- tiempo total de procesamiento en segundos;
- dispositivo de inferencia;
- barras KL0 a KL4 proporcionales a cada probabilidad;
- riesgo de artroplastia a 24 meses;
- riesgo de progresión KL a 3-12 meses;
- dos mapas Grad-CAM;
- acceso a revisión médica;
- generación y descarga de reportes.

### 5.19 Reportes PDF

- reporte borrador de un episodio;
- reporte longitudinal de un paciente;
- identidad institucional configurable;
- datos del paciente e historia clínica;
- médico generador;
- fecha y lateralidad de cada estudio;
- radiografía contenida y proporcionada;
- KL, confianza y distribución KL0-KL4;
- contexto clínico organizado por campos;
- riesgo de artroplastia y progresión con horizontes separados;
- revisión clínica de KL;
- Grad-CAM cuando existe;
- antecedentes para reportes longitudinales;
- encabezado, pie y numeración real de páginas;
- control de saltos para evitar páginas adicionales y texto cortado;
- almacenamiento cifrado y descarga autenticada;
- múltiples reportes conservados por episodio y fecha.

### 5.20 Auditoría

- registro de actor, acción, entidad, identificador, fecha y correlation ID;
- metadatos estructurados en JSON;
- tabla append-only;
- trigger de PostgreSQL que impide actualización y eliminación;
- consulta administrativa paginada;
- filtro textual;
- registro de accesos, cambios, inferencias, revisiones y exportaciones.

### 5.21 Configuración institucional

- nombre de la organización de 2 a 100 caracteres;
- subtítulo del reporte de 2 a 160 caracteres;
- prefijo alfanumérico de historia clínica de 1 a 8 caracteres;
- persistencia en PostgreSQL;
- uso de la configuración en nuevas historias y reportes.

## 6. Datos y entidades persistentes

Entidades principales:

- `Role`
- `User`
- `MfaCredential`
- `Session`
- `Patient`
- `PatientContact`
- `PatientClinicalProfile`
- `ClinicalEpisode`
- `StoredAsset`
- `ImagePreflightReview`
- `RadiographicStudy`
- `KneeObservation`
- `ClinicalObservation`
- `PriorExam`
- `InferenceJob`
- `ModelPrediction`
- `GradCamExplanation`
- `ClinicianReview`
- `DraftReport`
- `AuditEvent`
- `AppSetting`

El modelo relacional completo se encuentra en `docs/database.dbml` y las
migraciones ejecutables en `apps/api/migrations`.

## 7. Seguridad y privacidad implementadas

- cifrado AES-256-GCM por campo sensible y por archivo;
- contexto autenticado por entidad/activo;
- índices HMAC-SHA-256 para DNI e historia clínica;
- separación entre clave de cifrado, clave de índice, JWT, CSRF y token de
  servicio;
- contraseñas Argon2id;
- cookies HttpOnly y SameSite;
- protección CSRF;
- limitación de intentos y bloqueo de acceso;
- autorización basada en rol y propiedad clínica;
- API ML protegida con token de servicio;
- PWA sin persistencia de información clínica en cachés web;
- exclusión de cuerpos clínicos, nombres de archivo y metadatos DICOM en logs;
- almacenamiento cifrado de radiografías, Grad-CAM y PDF;
- descarga de reportes autenticada y auditada;
- secretos y datos locales excluidos de Git;
- auditoría append-only.

## 8. Portabilidad y operación local

- repositorio privado en GitHub;
- modelos excluidos de Git ordinario;
- paquete privado versionado `oa-final-2026-09-03`;
- manifiesto con 51 hashes SHA-256;
- scripts PowerShell y shell para importar carpeta o ZIP y verificar modelos;
- script para generar `.env` con secretos aleatorios;
- entorno CPU predeterminado con Docker Compose;
- perfil GPU NVIDIA opcional;
- base y archivos conservados en volúmenes Docker;
- migraciones automáticas al iniciar;
- instrucciones de clonación y ejecución en `README.md`;
- CI para TypeScript, build, pruebas Python y validación de Compose.

## 9. Pruebas y criterios transversales

El catálogo de pruebas comprende:

- compilación y typecheck del monorepo;
- pruebas unitarias NestJS;
- pruebas de validación y paginación;
- pruebas de contratos ML;
- integración con artefactos reales;
- paridad numérica del runtime;
- promedio CNN 50/50;
- probabilidades normalizadas;
- DICOM bilateral;
- PNG y JPG bilateral;
- PNG y JPG de una rodilla;
- polaridad, orientación y espejo izquierdo;
- vector XGBoost de 19 features en orden exacto;
- primer examen sin antecedentes;
- dolor y sexo faltantes;
- exclusión de antecedentes futuros o de otra rodilla;
- LSTM con disponibilidad e indisponibilidad según historia;
- exclusión de t2 KL4;
- detección de artefactos faltantes o modificados;
- recuperación de cola después de reinicios;
- permisos por rol y propietario;
- sesiones, contraseñas y MFA configurable;
- ausencia de datos clínicos en logs y caché del navegador;
- cifrado y descifrado de campos y archivos;
- PDF por episodio y longitudinal;
- tablas, modales, toasts, carrusel y menú móvil;
- construcción limpia después de clonar;
- ejecución Compose CPU sin GPU;
- perfil CUDA local;
- smoke test integral con datos sintéticos.

## 10. Definition of Done aplicable al backlog

Una historia se considera terminada cuando:

- cumple todos sus criterios de aceptación;
- respeta los permisos ADMIN/CLINICIAN y la propiedad del paciente;
- valida datos en frontend y backend cuando recibe entrada del usuario;
- no expone secretos ni información clínica en respuestas, logs o caché;
- conserva auditoría cuando la acción es relevante;
- mantiene el cifrado de datos identificables y activos;
- funciona en el perfil Docker Compose CPU;
- no introduce desplazamiento horizontal en móvil;
- incluye estado vacío, carga, éxito y error cuando hay interacción asíncrona;
- tiene pruebas proporcionales al comportamiento;
- supera typecheck, build y suite automatizada;
- mantiene documentación y contratos compartidos consistentes.

## 11. Estructura solicitada para el Excel del Product Backlog

Generar una hoja principal llamada `Product Backlog` con una fila por historia y
estas columnas:

1. ID
2. Épica
3. Módulo
4. Historia de usuario
5. Descripción funcional
6. Actor
7. Criterios de aceptación
8. Reglas de negocio
9. Prioridad
10. Story points
11. Dependencias
12. Estado
13. Evidencia o componente implementado
14. Sprint sugerido

Convenciones para generar las historias:

- redactar como “Como [actor], quiero [capacidad], para [beneficio]”;
- crear criterios verificables en formato Dado/Cuando/Entonces;
- separar historias cuando puedan desarrollarse o validarse de forma
  independiente;
- conservar los contratos exactos de CNN, XGBoost y LSTM;
- utilizar únicamente los roles Administrador técnico y Médico;
- marcar como `Completado` las capacidades descritas como implementadas en este
  documento;
- agrupar por épicas: autenticación, administración, pacientes, historia
  clínica, imágenes, inferencia KL, explicabilidad, riesgos, reportes,
  auditoría, UX responsive, seguridad, pruebas y portabilidad;
- asignar prioridad MoSCoW y story points Fibonacci;
- agregar una segunda hoja `Épicas` con objetivo, alcance y dependencias;
- agregar una tercera hoja `Criterios ML` con modelo, entrada, salida, horizonte,
  umbral, elegibilidad y pruebas;
- agregar una cuarta hoja `Modelo de datos` con entidad, propósito y relaciones.

## 12. Alcance no incorporado en este incremento

- reentrenamiento o fine-tuning de modelos;
- integración con PACS o historia clínica electrónica externa;
- fusión de los resultados XGBoost y LSTM;
- recomendación automática de cirugía;
- firma clínica digital del PDF;
- funcionamiento offline con sincronización clínica;
- despliegue externo de producción.
