import { FormEvent, useEffect, useState } from "react";
import {
  ArrowLeft,
  BrainCircuit,
  ScanEye,
  ScanLine,
  Sparkles,
  UploadCloud,
} from "lucide-react";
import { api, post } from "./api";
import { Notify, Patient } from "./types";
import { Badge } from "./ui";

type Prediction = {
  predictedKl: number;
  confidence: number;
  ensemble: Record<string, number>;
  members: Record<string, Record<string, number>>;
};
type Preflight = {
  preflightId: string;
  fileKind: "DICOM" | "RASTER";
  previewDataUrl: string;
  reviewStatus: "ACCEPTED" | "REJECTED" | "REVIEW_REQUIRED" | "UNAVAILABLE";
  suggestedLayout: "bilateral" | "single" | "uncertain";
  supported: boolean;
  model: string;
  costUsd: number | null;
  assessment: null | {
    view: string;
    coverage: string;
    laterality: string;
    weight_bearing: string;
    quality: string;
    confidence: number;
  };
};
type AnalysisIds = {
  episodeId: string;
  studyId: string;
  observationId: string;
  jobId: string;
  kneeSide: string;
};
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;

function StudyUpload({
  patient,
  onReady,
  notify,
}: {
  patient: Patient;
  onReady: (ids: AnalysisIds) => void;
  notify: Notify;
}) {
  const [file, setFile] = useState<File>();
  const [side, setSide] = useState("R");
  const [layout, setLayout] = useState<"bilateral" | "single" | "">("");
  const [examDate, setExamDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [advanced, setAdvanced] = useState({ invert: false, swap: false });
  const [preflight, setPreflight] = useState<Preflight>();
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const blocked =
    preflight?.reviewStatus === "REJECTED" || preflight?.supported === false;

  async function chooseFile(selected?: File) {
    setFile(selected);
    setPreflight(undefined);
    setLayout("");
    if (!selected) return;
    setChecking(true);
    try {
      const data = new FormData();
      data.append("image", selected);
      const result = await api<Preflight>("/api/studies/preflight", {
        method: "POST",
        body: data,
      });
      setPreflight(result);
      if (result.fileKind === "DICOM") setLayout("bilateral");
      else if (result.suggestedLayout !== "uncertain")
        setLayout(result.suggestedLayout);
      if (result.assessment?.laterality === "left") setSide("L");
      else if (result.assessment?.laterality === "right") setSide("R");
      notify(
        result.reviewStatus === "ACCEPTED"
          ? "Radiografía reconocida correctamente"
          : result.reviewStatus === "REJECTED"
            ? "Archivo rechazado: no corresponde a una radiografía de rodilla"
            : "Revise la sugerencia automática antes de continuar",
        result.reviewStatus === "ACCEPTED"
          ? "success"
          : result.reviewStatus === "REJECTED"
            ? "error"
            : "warning",
      );
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setChecking(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || !preflight || !layout) return;
    setBusy(true);
    try {
      const episode = await post<{ id: string }>(
        `/api/patients/${patient.id}/episodes`,
        { openedAt: examDate },
      );
      const data = new FormData();
      data.append("image", file);
      data.append("examDate", examDate);
      data.append("preflightId", preflight.preflightId);
      data.append("imageLayout", layout);
      data.append("kneeSide", side);
      data.append("invertPolarity", String(advanced.invert));
      data.append("swapSides", String(advanced.swap));
      const study = await api<{
        studyId: string;
        observationId: string;
        jobId: string;
      }>(`/api/episodes/${episode.id}/studies`, { method: "POST", body: data });
      notify(
        "Estudio guardado. El análisis comenzó automáticamente.",
        "success",
      );
      onReady({
        episodeId: episode.id,
        studyId: study.studyId,
        observationId: study.observationId,
        jobId: study.jobId,
        kneeSide: side,
      });
    } catch (error: any) {
      notify(error.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface analysis-card upload-card">
      <div className="step-heading">
        <span>
          <UploadCloud size={20} />
        </span>
        <div>
          <p className="overline">Nuevo estudio</p>
          <h2>Cargar radiografía</h2>
          <p>
            El formato, el contenido y la orientación se revisan antes de
            iniciar.
          </p>
        </div>
      </div>
      <form onSubmit={submit} className="form-grid analysis-form">
        <label className="span upload-zone">
          <input
            type="file"
            accept=".dcm,application/dicom,image/png,image/jpeg"
            onChange={(event) => void chooseFile(event.target.files?.[0])}
            required
          />
          <UploadCloud className="upload-icon" size={30} />
          <b>{file ? file.name : "Seleccione o arrastre un archivo"}</b>
          <small>DICOM, PNG o JPG · máximo 64 MB</small>
        </label>
        {checking && (
          <div className="analysis-loading span">
            <i /> Verificando formato y contenido…
          </div>
        )}
        {preflight && (
          <div className="preflight span">
            <img
              src={preflight.previewDataUrl}
              alt="Vista previa del estudio"
            />
            <div>
              <Badge
                tone={
                  preflight.reviewStatus === "ACCEPTED"
                    ? "success"
                    : preflight.reviewStatus === "REJECTED"
                      ? "danger"
                      : "warning"
                }
              >
                {preflight.reviewStatus === "ACCEPTED"
                  ? "Compatible"
                  : preflight.reviewStatus === "REJECTED"
                    ? "No reconocida"
                    : "Revisar"}
              </Badge>
              <h3>
                {preflight.reviewStatus === "ACCEPTED"
                  ? "Radiografía frontal reconocida"
                  : preflight.reviewStatus === "REJECTED"
                    ? "La imagen no parece una radiografía válida"
                    : "Confirme los datos sugeridos"}
              </h3>
              <p>
                {preflight.fileKind === "DICOM"
                  ? "DICOM detectado"
                  : "PNG/JPG detectado"}{" "}
                · revisión visual automática
              </p>
              <small>
                La miniatura externa no contiene metadatos DICOM y tiene sus
                bordes enmascarados.
              </small>
            </div>
          </div>
        )}
        {preflight && !blocked && (
          <>
            <label>
              Fecha registrada para el estudio
              <input
                type="date"
                max={new Date().toISOString().slice(0, 10)}
                value={examDate}
                onChange={(event) => setExamDate(event.target.value)}
                required
              />
              <small>
                Esta fecha se usará para calcular la edad del paciente y no
                se reemplazará con metadatos de la imagen o del DICOM.
              </small>
            </label>
            <fieldset>
              <legend>Contenido detectado</legend>
              <div className="segment">
                <button
                  type="button"
                  className={layout === "bilateral" ? "active" : ""}
                  onClick={() => setLayout("bilateral")}
                >
                  Ambas rodillas
                </button>
                <button
                  type="button"
                  disabled={preflight.fileKind === "DICOM"}
                  className={layout === "single" ? "active" : ""}
                  onClick={() => setLayout("single")}
                >
                  Una rodilla
                </button>
              </div>
            </fieldset>
            <fieldset>
              <legend>Rodilla a evaluar</legend>
              <div className="segment">
                <button
                  type="button"
                  className={side === "R" ? "active" : ""}
                  onClick={() => setSide("R")}
                >
                  Derecha
                </button>
                <button
                  type="button"
                  className={side === "L" ? "active" : ""}
                  onClick={() => setSide("L")}
                >
                  Izquierda
                </button>
              </div>
            </fieldset>
            <div className="study-contract span">
              <b>Uso previsto</b>
              <span>
                El análisis está diseñado para radiografías frontales de rodilla
                con apoyo de peso.
              </span>
            </div>
            <details className="span advanced">
              <summary>Correcciones avanzadas de orientación</summary>
              <div className="check-grid orientation-options">
                <label className="orientation-option">
                  <input
                    type="checkbox"
                    checked={advanced.invert}
                    disabled={preflight.fileKind !== "DICOM"}
                    onChange={(event) =>
                      setAdvanced({ ...advanced, invert: event.target.checked })
                    }
                  />
                  <span>Invertir polaridad DICOM</span>
                </label>
                <label className="orientation-option">
                  <input
                    type="checkbox"
                    checked={advanced.swap}
                    disabled={layout !== "bilateral"}
                    onChange={(event) =>
                      setAdvanced({ ...advanced, swap: event.target.checked })
                    }
                  />
                  <span>Intercambiar lados</span>
                </label>
              </div>
            </details>
          </>
        )}
        {blocked ? (
          <div className="alert danger-alert span">
            {preflight?.reviewStatus === "REJECTED"
              ? "No se puede crear el estudio con este archivo. Seleccione una radiografía frontal de rodilla."
              : "La disposición detectada no es compatible con DICOM; use una radiografía bilateral o convierta una ROI válida a PNG/JPG."}
          </div>
        ) : (
          <button
            className="button primary span"
            disabled={busy || checking || !preflight || !layout}
          >
            {busy ? "Guardando e iniciando…" : "Guardar e iniciar análisis"}
          </button>
        )}
      </form>
    </section>
  );
}

function RiskResult({ title, value }: { title: string; value: any }) {
  const notApplicable =
    value?.available === false && /KL4|grado máximo/i.test(value.reason ?? "");
  return (
    <article className="risk-card">
      <span className="overline">Estimación automática</span>
      <h3>{title}</h3>
      {!value ? (
        <div className="skeleton-line" />
      ) : value.available === false ? (
        <>
          <Badge tone="neutral">
            {notApplicable ? "No aplicable" : "No disponible"}
          </Badge>
          <p className="muted">{value.reason}</p>
        </>
      ) : (
        <>
          <strong>{percent(value.probability)}</strong>
          <Badge tone={value.screen_positive ? "warning" : "success"}>
            {value.screen_positive ? "Tamiz positivo" : "Tamiz negativo"}
          </Badge>
          <small>
            Umbral {Number(value.threshold).toFixed(3)} · KL de entrada{" "}
            {value.klOrigin === "CLINICIAN"
              ? "revisado"
              : "estimado por el modelo"}
          </small>
        </>
      )}
    </article>
  );
}

function AutomaticWorkflow({
  ids,
  notify,
  openAnalysis,
}: {
  ids: AnalysisIds;
  notify: Notify;
  openAnalysis: (episodeId: string) => void;
}) {
  const [job, setJob] = useState<any>();
  const [prediction, setPrediction] = useState<Prediction>();
  const [cams, setCams] = useState<
    Array<{ backbone: string; targetKl: number; dataUrl: string }>
  >([]);
  const [risk, setRisk] = useState<any>({});
  const [recommendation, setRecommendation] = useState<any>();
  const [stage, setStage] = useState("Clasificando la radiografía…");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const wait = (ms: number) =>
      new Promise((resolve) => window.setTimeout(resolve, ms));
    async function process() {
      try {
        let completed: any;
        for (let attempt = 0; attempt < 240 && !cancelled; attempt += 1) {
          const state = await api<any>(`/api/inference-jobs/${ids.jobId}`);
          setJob(state);
          if (state.status === "SUCCEEDED") {
            completed = state;
            break;
          }
          if (state.status === "FAILED")
            throw new Error(
              `No se pudo completar la clasificación (${state.errorCode})`,
            );
          await wait(1000);
        }
        if (!completed || cancelled) return;
        setPrediction(completed.probabilities);
        setStage("Generando explicaciones y riesgos…");
        const camTask = async () => {
          for (let n = 0; n < 120 && !cancelled; n += 1) {
            const values = await api<any[]>(
              `/api/predictions/${completed.predictionId}/explanations`,
            );
            if (values.length >= 2) return values;
            await wait(1000);
          }
          return [];
        };
        const [camResult, arthroplasty, progression] = await Promise.allSettled(
          [
            camTask(),
            post(
              `/api/observations/${ids.observationId}/risks/arthroplasty`,
              {},
            ),
            post(
              `/api/observations/${ids.observationId}/risks/progression`,
              {},
            ),
          ],
        );
        if (cancelled) return;
        if (camResult.status === "fulfilled") setCams(camResult.value);
        setRisk({
          arthroplasty:
            arthroplasty.status === "fulfilled"
              ? arthroplasty.value
              : {
                  available: false,
                  reason:
                    (arthroplasty.reason as Error)?.message ?? "No disponible",
                },
          progression:
            progression.status === "fulfilled"
              ? progression.value
              : {
                  available: false,
                  reason:
                    (progression.reason as Error)?.message ?? "No disponible",
                },
        });
        setStage("Preparando orientación clínica…");
        let recommendationWarning = "";
        try {
          const generated = await post<any>(
            `/api/observations/${ids.observationId}/recommendations`,
            {},
          );
          if (!cancelled) {
            setRecommendation(generated.individual);
            recommendationWarning = Array.isArray(generated.errors)
              ? generated.errors.map((item: any) => item?.message).filter(Boolean).join(" · ")
              : "";
            if (!generated.individual && !recommendationWarning) {
              recommendationWarning = "OpenRouter no devolvió una interpretación para este análisis.";
            }
          }
        } catch (reason: any) {
          recommendationWarning = reason?.message ?? "No fue posible generar la interpretación con IA.";
        }
        setStage(recommendationWarning ? "Análisis completo con una observación" : "Análisis completo");
        notify(
          recommendationWarning
            ? `El análisis y los riesgos se guardaron, pero la IA informó: ${recommendationWarning}`
            : "Análisis, riesgos e interpretación registrados automáticamente",
          recommendationWarning ? "warning" : "success",
        );
      } catch (reason: any) {
        if (!cancelled) {
          setError(reason.message);
          setStage("Análisis interrumpido");
          notify(reason.message, "error");
        }
      }
    }
    void process();
    return () => {
      cancelled = true;
    };
  }, [ids.jobId, ids.observationId]);

  return (
    <div className="workflow-stack">
      <section className="surface analysis-card processing-card">
        <div className="processing-head">
          <div>
            <span className={`status-orb ${prediction ? "done" : ""}`} />
            <div>
              <p className="overline">Procesamiento automático</p>
              <h2>{stage}</h2>
            </div>
          </div>
          {job?.status && (
            <Badge tone={error ? "danger" : prediction ? "success" : "info"}>
              {job.status}
            </Badge>
          )}
        </div>
        {!prediction && !error && (
          <div className="analysis-progress">
            <i />
          </div>
        )}
        {error && <div className="alert danger-alert">{error}</div>}
      </section>
      {prediction && (
        <section className="surface analysis-card result-card">
          <div className="step-heading">
            <span>
              <ScanLine size={20} />
            </span>
            <div>
              <p className="overline">Evaluación radiológica</p>
              <h2>Clasificación de Kellgren–Lawrence</h2>
              <p>
                Resultado disponible de inmediato; la revisión médica puede
                realizarse después desde el episodio.
              </p>
            </div>
          </div>
          <div className="prediction-layout">
            <div className="kl-score">
              <span>KL estimado</span>
              <strong>{prediction.predictedKl}</strong>
              <small>Confianza {percent(prediction.confidence)}</small>
            </div>
            <div className="probability-bars">
              {Object.entries(prediction.ensemble).map(([label, value]) => (
                <div key={label}>
                  <span>{label}</span>
                  <i>
                    <b style={{ width: percent(value) }} />
                  </i>
                  <em>{percent(value)}</em>
                </div>
              ))}
            </div>
            <div className="duration-card">
              <span>Tiempo de evaluación radiológica</span>
              <strong>
                {job?.latencyMs == null
                  ? "—"
                  : `${(Number(job.latencyMs) / 1000).toFixed(2)} s`}
              </strong>
              <small>{job?.device ?? "Procesamiento CPU"}</small>
            </div>
          </div>
        </section>
      )}
      {prediction && (
        <section className="surface analysis-card">
          <div className="step-heading">
            <span>
              <ScanEye size={20} />
            </span>
            <div>
              <p className="overline">Explicabilidad</p>
              <h2>Regiones relevantes para los modelos</h2>
            </div>
          </div>
          {cams.length ? (
            <div className="cam-grid">
              {cams.map((cam) => (
                <figure key={cam.backbone}>
                  <img src={cam.dataUrl} alt={`Grad-CAM ${cam.backbone}`} />
                  <figcaption>
                    {cam.backbone} · objetivo KL{cam.targetKl}
                  </figcaption>
                </figure>
              ))}
            </div>
          ) : (
            <div className="analysis-loading">
              <i /> Generando mapas Grad-CAM…
            </div>
          )}
        </section>
      )}
      {recommendation && (
        <section className="surface analysis-card recommendation-card workflow-recommendation">
          <div className="recommendation-icon"><Sparkles size={20} /></div>
          <div>
            <div className="recommendation-heading">
              <span className="overline">Orientación del análisis</span>
              <Badge tone={recommendation.content.priority === "prompt" ? "warning" : "info"}>
                {recommendation.content.priority === "prompt" ? "Revisión prioritaria" : recommendation.content.priority === "soon" ? "Revisión próxima" : "Seguimiento habitual"}
              </Badge>
            </div>
            <h2>{recommendation.content.headline}</h2>
            <p>{recommendation.content.summary}</p>
            <p className="recommendation-guidance">{recommendation.content.recommendation}</p>
            <small>Orientación automática de apoyo. Debe validarse con el criterio clínico responsable.</small>
          </div>
        </section>
      )}
      {prediction && (
        <section className="surface analysis-card">
          <div className="step-heading">
            <span>
              <BrainCircuit size={20} />
            </span>
            <div>
              <p className="overline">Riesgos complementarios</p>
              <h2>Resultados longitudinales</h2>
            </div>
          </div>
          <div className="risk-grid">
            <RiskResult
              title="Artroplastia · 24 meses"
              value={risk.arthroplasty}
            />
            <RiskResult
              title="Progresión KL · 3–12 meses"
              value={risk.progression}
            />
          </div>
          <div className="report-actions">
            <button
              className="button primary"
              disabled={!prediction || Boolean(error)}
              onClick={() => openAnalysis(ids.episodeId)}
            >
              Ver análisis completo
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export default function ClinicalAnalysis({
  patient,
  notify,
  onDone,
  openAnalysis,
}: {
  patient: Patient;
  notify: Notify;
  onDone: () => void;
  openAnalysis: (episodeId: string) => void;
}) {
  const [ids, setIds] = useState<AnalysisIds>();
  return (
    <div className="analysis-page">
      <div className="page-head">
        <div>
          <button className="text-link" onClick={onDone}>
            <ArrowLeft size={16} /> Volver a {patient.medicalRecordNumber}
          </button>
          <h1>Nuevo análisis</h1>
          <p>
            {patient.surnames}, {patient.names}
          </p>
        </div>
      </div>
      {!ids ? (
        <StudyUpload patient={patient} notify={notify} onReady={setIds} />
      ) : (
        <AutomaticWorkflow
          ids={ids}
          notify={notify}
          openAnalysis={openAnalysis}
        />
      )}
    </div>
  );
}
