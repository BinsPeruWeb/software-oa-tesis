# Evaluación bilateral de rodilla

## Registro y navegación

Al cargar una imagen bilateral, el médico puede elegir Derecha, Izquierda o Ambas.
Ambas registra dos episodios en la misma transacción, uno por rodilla. Cada episodio
tiene su estudio, observación, trabajo CNN, Grad-CAM, riesgos, revisión, interpretación
y nota. Se conserva un único archivo cifrado para la radiografía compartida.

Los dos episodios se vinculan mediante `bilateral_group_id`. Esa relación permite
consultar ambos lados desde el detalle con pestañas. No se agrupan registros antiguos
por coincidencia de fecha: únicamente se vinculan los creados en una misma carga bilateral.
Los registros previos conservan su funcionamiento.

El seguimiento visual muestra un carrusel independiente por rodilla, ordenado por la
fecha del examen. XGBoost y LSTM reciben únicamente el historial del lado evaluado.
Dos rodillas evaluadas el mismo día no satisfacen el requisito longitudinal de la LSTM:
se necesita una fecha anterior de la misma rodilla y un KL actual menor que 4.

Las dos evaluaciones se inician automáticamente y siguen procesándose aunque el
médico cambie de pestaña. La síntesis del paciente se actualiza con los resultados
disponibles de todos los análisis. Las peticiones de interpretación y reporte se
serializan por paciente en el servicio API para evitar actualizaciones concurrentes
que reemplacen una síntesis reciente con otra anterior.

## Reportes

- PDF del episodio: rodilla seleccionada, una página de análisis y otra de interpretación
  individual y nota propia, si existe.
- Longitudinal desde el detalle: solo los estudios de la rodilla seleccionada.
- Generar Reporte en la ficha: General, Rodilla Derecha y Rodilla Izquierda cuando hay
  estudios de ambos lados; descarga directa cuando hay un único lado.
- Longitudinal: una página por estudio, en orden cronológico, y una sección final de
  interpretación general y nota general. Por decisión funcional, esa interpretación
  considera todos los análisis del paciente aun cuando se filtran las páginas de
  resultados por lateralidad.

El campo `draft_reports.knee_side` identifica el filtro utilizado. NULL representa
un reporte general. El listado de reportes muestra esa distinción.

## Migración

`008_bilateral_episodes.sql` agrega columnas e índices sin eliminar ni modificar los
datos clínicos previos. Se aplica automáticamente al iniciar la API. Los tipos de
imagen, las features, los umbrales y los artefactos de inferencia permanecen iguales.

## Verificación

- `npm test`: carga bilateral DICOM/raster, compatibilidad individual, protección del
  preflight, acceso al episodio vinculado, filtros del reporte y concurrencia de IA.
- `npm run typecheck` y `npm run build`: contratos, frontend y API.
- Suite Python: contratos de imágenes y modelos, incluida paridad 50/50 del ensemble.
- `scripts/bilateral-smoke-test.mjs`: prueba integrada en un contenedor aislado con
  PostgreSQL y los modelos reales. OpenRouter debe apuntar a la fixture local
  `http://127.0.0.1:8090/v1`, con modelos `isolated-vision` e `isolated-recommendation`.
  La prueba valida esta condición y rechaza ejecutar su flujo con otra configuración.
  Utiliza imágenes y pacientes sintéticos; no consulta proveedores externos.
  `scripts/fixtures/bilateral-test.env.example` contiene la configuración sintética
  que debe montarse como `/opt/oa/config/presentation.env` en ese contenedor separado.
- `scripts/bilateral-browser-test.mjs`: navegador con Playwright sobre la instancia
  aislada, después del smoke test y con la fixture del proveedor activa. Prueba
  carruseles, pestañas, descarga por lateralidad, carga bilateral automática,
  actualización de la síntesis general y ausencia de desbordamiento móvil. Requiere
  Playwright instalado para pruebas; `BROWSER_EXECUTABLE` permite usar Chrome/Edge
  existente y `PLAYWRIGHT_MODULE` permite indicar la ruta del módulo instalado.
  `BILATERAL_TEST_URL` cambia la URL local; por defecto usa el puerto 3011.

La prueba integrada cubre dos cargas bilaterales en orden de registro inverso a sus
fechas, cuatro interpretaciones y notas independientes, XGBoost de 19 variables,
LSTM por ambos lados, PDF por episodio y longitudinal general/filtrado, conservación
de interpretaciones ante error del proveedor y compatibilidad de la ROI individual.

Verificación realizada el 9 de octubre de 2026: 32 pruebas de API y 27 pruebas ML
aprobadas, compilación y tipos correctos, smoke test integrado aprobado y navegador
sin errores ni scroll horizontal a 360, 390 y 768 píxeles. El flujo de navegador
también verifica el procesamiento automático de las dos rodillas y la actualización
de la interpretación general al finalizar.
