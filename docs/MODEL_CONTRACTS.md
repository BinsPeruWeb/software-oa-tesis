# Contratos congelados de inferencia

Versión: `oa-final-2026-09-03`.

## KL radiográfico

Entradas: `DICOM_BILATERAL`, `RASTER_BILATERAL` y `RASTER_SINGLE_ROI`. El flujo está restringido a radiografías AP con soporte de peso y registra ese contrato de adquisición de forma implícita, sin un checkbox redundante; la lateralidad continúa siendo explícita. La ROI izquierda se espeja. La ROI final es gris, normalizada por percentiles 0.5/99.5 y redimensionada a 320 × 320.

El ensemble es siempre el promedio 50/50 de ResNet50 y DenseNet121. Se conservan las cinco probabilidades de cada miembro, las cinco del ensemble, confianza, KL, hashes, pipeline, dispositivo y latencia. Grad-CAM se genera por backbone; no se representa como explicación causal.

Una entrada bilateral puede evaluar derecha, izquierda o ambas. `BOTH` es una selección de la aplicación, nunca una lateralidad enviada a los modelos. Una carga de ambas crea dos episodios y dos estudios independientes, vinculados por `clinical_episodes.bilateral_group_id`. Comparten un único archivo cifrado; cada observación recibe exclusivamente `L` o `R`, su ROI, trabajo de inferencia, predicciones, revisión, interpretación y nota. Las entradas `RASTER_SINGLE_ROI` no permiten `BOTH`.

El PDF de episodio corresponde solo a la rodilla seleccionada. El longitudinal admite todas las rodillas o solo un lado; incluye una página de análisis por estudio y una sección final con la interpretación y nota general del paciente. Esa interpretación integra todos los análisis incluso cuando las páginas radiográficas se filtran por lateralidad. La síntesis clínica compara cada rodilla con su propio historial, sin tratar la diferencia entre lados como progresión temporal.

## XGBoost

Orden exacto:

```text
age_at_exam, KLG, pain_score, pain_missing, obesity, diabetes,
hypertension, nicotine_use, trauma_lower_extremity, sex_female,
sex_missing, knee_left, prior_KLG, years_since_prior,
kl_change_from_prior, prior_kl_rate, n_prior_exams,
years_since_first, kl_change_from_first
```

Solo dolor y sexo admiten ausencia. Los cinco indicadores son booleanos obligatorios. Los antecedentes deben ser anteriores, confirmados y de la misma rodilla. En el primer examen, las variables de antecedente son `NaN`, el conteo es 0 y los cambios desde el primero son 0. Umbral: `0.2574747475`; horizonte: 24 meses. Un tamiz positivo no indica cirugía.

## LSTM

Usa exactamente `t1` y `t2`, cronológicos y de una misma rodilla. Cada punto tiene KLG confirmado, edad, dolor opcional, cinco indicadores obligatorios y lateralidad. Sexo no participa. `t2=KL4` es inelegible. Umbral: `0.4802020202`; objetivo: aumento de al menos un grado KL observado en 3–12 meses. Con menos de dos observaciones se informa “predicción no disponible”.
