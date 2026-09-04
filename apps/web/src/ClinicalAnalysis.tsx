import { FormEvent, useState } from 'react';
import { api, post } from './api';
import { Notify, Patient } from './types';

type Prediction = { predictedKl: number; confidence: number; ensemble: Record<string, number>; members: Record<string, Record<string, number>> };
type Preflight = {
  preflightId: string; fileKind: 'DICOM' | 'RASTER'; examDate: string | null; previewDataUrl: string;
  reviewStatus: 'ACCEPTED' | 'REJECTED' | 'REVIEW_REQUIRED' | 'UNAVAILABLE'; suggestedLayout: 'bilateral' | 'single' | 'uncertain';
  supported: boolean; model: string; costUsd: number | null;
  assessment: null | { view: string; coverage: string; laterality: string; weight_bearing: string; quality: string; confidence: number };
};
type AnalysisIds = { episodeId: string; observationId: string; kneeSide: string };
const blankFlags = { obesity: '', diabetes: '', hypertension: '', nicotineUse: '', traumaLowerExtremity: '' };
const booleans = (value: typeof blankFlags) => ({ obesity: value.obesity === 'true', diabetes: value.diabetes === 'true', hypertension: value.hypertension === 'true', nicotineUse: value.nicotineUse === 'true', traumaLowerExtremity: value.traumaLowerExtremity === 'true' });
const percent = (value: number) => `${(value * 100).toFixed(1)} %`;

function StudyUpload({ patient, onReady, notify }: { patient: Patient; onReady: (ids: AnalysisIds) => void; notify: Notify }) {
  const [file, setFile] = useState<File>(); const [side, setSide] = useState('R'); const [layout, setLayout] = useState<'bilateral' | 'single' | ''>('');
  const [examDate, setExamDate] = useState(new Date().toISOString().slice(0, 10)); const [confirmed, setConfirmed] = useState(false);
  const [advanced, setAdvanced] = useState({ invert: false, swap: false }); const [overrideReason, setOverrideReason] = useState('');
  const [preflight, setPreflight] = useState<Preflight>(); const [checking, setChecking] = useState(false); const [busy, setBusy] = useState(false);

  async function chooseFile(selected?: File) {
    setFile(selected); setPreflight(undefined); setLayout(''); setOverrideReason(''); if (!selected) return; setChecking(true);
    try {
      const data = new FormData(); data.append('image', selected);
      const result = await api<Preflight>('/api/studies/preflight', { method: 'POST', body: data }); setPreflight(result);
      if (result.examDate) setExamDate(result.examDate);
      if (result.fileKind === 'DICOM' && result.suggestedLayout !== 'single') setLayout('bilateral'); else if (result.suggestedLayout !== 'uncertain') setLayout(result.suggestedLayout);
      if (result.assessment?.laterality === 'left') setSide('L'); else if (result.assessment?.laterality === 'right') setSide('R');
      notify(result.reviewStatus === 'ACCEPTED' ? 'Radiografía reconocida correctamente' : 'Revise la sugerencia automática antes de continuar', result.reviewStatus === 'ACCEPTED' ? 'success' : 'warning');
    } catch (error: any) { notify(error.message, 'error'); } finally { setChecking(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!file || !preflight || !layout) return; setBusy(true);
    try {
      const episode = await post<{ id: string }>(`/api/patients/${patient.id}/episodes`, { openedAt: examDate });
      const data = new FormData(); data.append('image', file); data.append('examDate', examDate); data.append('preflightId', preflight.preflightId);
      data.append('imageLayout', layout); data.append('kneeSide', side); data.append('acquisitionConfirmed', String(confirmed));
      data.append('invertPolarity', String(advanced.invert)); data.append('swapSides', String(advanced.swap)); if (overrideReason) data.append('manualOverrideReason', overrideReason);
      const study = await api<{ observationId: string }>(`/api/episodes/${episode.id}/studies`, { method: 'POST', body: data });
      notify('Estudio cifrado y registrado', 'success'); onReady({ episodeId: episode.id, observationId: study.observationId, kneeSide: side });
    } catch (error: any) { notify(error.message, 'error'); } finally { setBusy(false); }
  }
  return <section className="surface analysis-card">
    <div className="step-heading"><span>01</span><div><p className="overline">Nuevo estudio</p><h2>Cargar radiografía</h2><p>El formato y el contenido se verifican automáticamente.</p></div></div>
    <form onSubmit={submit} className="form-grid">
      <label className="span upload-zone"><input type="file" accept=".dcm,application/dicom,image/png,image/jpeg" onChange={(event) => void chooseFile(event.target.files?.[0])} required /><b>{file ? file.name : 'Seleccione o arrastre un archivo'}</b><small>DICOM, PNG o JPG · máximo 64 MB</small></label>
      {checking && <div className="analysis-loading span"><i /> Analizando formato y contenido con el revisor visual…</div>}
      {preflight && <div className="preflight span"><img src={preflight.previewDataUrl} alt="Vista previa del estudio" /><div>
        <span className={`badge badge-${preflight.reviewStatus === 'ACCEPTED' ? 'success' : preflight.reviewStatus === 'REJECTED' ? 'danger' : 'warning'}`}>{preflight.reviewStatus}</span>
        <h3>{preflight.reviewStatus === 'ACCEPTED' ? 'Radiografía frontal reconocida' : preflight.reviewStatus === 'REJECTED' ? 'Imagen no reconocida' : 'Revisión manual necesaria'}</h3>
        <p>{preflight.fileKind === 'DICOM' ? 'DICOM detectado' : 'Imagen raster detectada'} · {preflight.model}</p>
        <small>Solo se envió una miniatura sin metadatos DICOM y con bordes enmascarados.</small>
      </div></div>}
      {preflight && <>
        <label>Fecha del examen<input type="date" max={new Date().toISOString().slice(0, 10)} value={examDate} onChange={(event) => setExamDate(event.target.value)} required /></label>
        <fieldset><legend>Contenido</legend><div className="segment"><button type="button" className={layout === 'bilateral' ? 'active' : ''} onClick={() => setLayout('bilateral')}>Ambas rodillas</button><button type="button" disabled={preflight.fileKind === 'DICOM'} className={layout === 'single' ? 'active' : ''} onClick={() => setLayout('single')}>Una rodilla</button></div></fieldset>
        <fieldset><legend>Rodilla a analizar</legend><div className="segment"><button type="button" className={side === 'R' ? 'active' : ''} onClick={() => setSide('R')}>Derecha</button><button type="button" className={side === 'L' ? 'active' : ''} onClick={() => setSide('L')}>Izquierda</button></div></fieldset>
        <label className="confirm-row span"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} required /><span><b>Confirmo radiografía frontal con apoyo de peso</b><small>El soporte de peso requiere confirmación humana.</small></span></label>
        {preflight.reviewStatus === 'REJECTED' && <label className="span">Justificación para continuar<textarea minLength={20} maxLength={500} value={overrideReason} onChange={(event) => setOverrideReason(event.target.value.slice(0, 500))} required /></label>}
        <details className="span advanced"><summary>Opciones avanzadas de orientación</summary><div className="check-grid"><label><input type="checkbox" checked={advanced.invert} disabled={preflight.fileKind !== 'DICOM'} onChange={(event) => setAdvanced({ ...advanced, invert: event.target.checked })} /> Invertir polaridad DICOM</label><label><input type="checkbox" checked={advanced.swap} disabled={layout !== 'bilateral'} onChange={(event) => setAdvanced({ ...advanced, swap: event.target.checked })} /> Intercambiar lados</label></div></details>
      </>}
      <button className="button primary span" disabled={busy || checking || !preflight || !layout || !confirmed}>{busy ? 'Guardando estudio…' : 'Guardar y continuar'}</button>
    </form>
  </section>;
}

function ModelWorkflow({ ids, patient, notify, onDone }: { ids: AnalysisIds; patient: Patient; notify: Notify; onDone: () => void }) {
  const [job, setJob] = useState<any>(); const [prediction, setPrediction] = useState<Prediction>(); const [predictionId, setPredictionId] = useState('');
  const [cams, setCams] = useState<Array<{ backbone: string; targetKl: number; dataUrl: string }>>([]); const [confirmedKl, setConfirmedKl] = useState(0); const [reviewed, setReviewed] = useState(false);
  const [flags, setFlags] = useState(blankFlags); const [pain, setPain] = useState(''); const [clinicalSaved, setClinicalSaved] = useState(false); const [risk, setRisk] = useState<any>({});
  const [prior, setPrior] = useState({ examDate: '', confirmedKl: '0', painScore: '', ...blankFlags }); const [reportId, setReportId] = useState('');
  const flagFields = [['obesity', 'Obesidad'], ['diabetes', 'Diabetes'], ['hypertension', 'Hipertensión'], ['nicotineUse', 'Consumo de nicotina'], ['traumaLowerExtremity', 'Trauma de miembro inferior']] as const;
  async function run() {
    try {
      const queued = await post<any>(`/api/observations/${ids.observationId}/inference`, {}); setJob(queued);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); const state = await api<any>(`/api/inference-jobs/${queued.id}`); setJob(state);
        if (state.status === 'SUCCEEDED') { setPrediction(state.probabilities); setPredictionId(state.predictionId); setConfirmedKl(state.probabilities.predictedKl); notify('Clasificación KL completada', 'success'); return; }
        if (state.status === 'FAILED') throw new Error(`Inferencia fallida (${state.errorCode})`);
      } throw new Error('La inferencia excedió el tiempo esperado');
    } catch (error: any) { notify(error.message, 'error'); }
  }
  async function review(decision: 'CONFIRMED' | 'CORRECTED' | 'REJECTED') { try { await post(`/api/predictions/${predictionId}/review`, { decision, confirmedKl: decision === 'REJECTED' ? null : confirmedKl }); setReviewed(decision !== 'REJECTED'); notify('Revisión clínica registrada', 'success'); } catch (error: any) { notify(error.message, 'error'); } }
  async function loadCams() { try { for (let n = 0; n < 30; n += 1) { const values = await api<any[]>(`/api/predictions/${predictionId}/explanations`); if (values.length === 2) { setCams(values); return; } await new Promise((resolve) => setTimeout(resolve, 1000)); } throw new Error('Grad-CAM aún está procesándose'); } catch (error: any) { notify(error.message, 'error'); } }
  async function saveClinical() { try { if (Object.values(flags).some((value) => value === '')) throw new Error('Marque Sí o No en cada indicador'); await post(`/api/observations/${ids.observationId}/clinical`, { painScore: pain === '' ? null : Number(pain), ...booleans(flags) }); setClinicalSaved(true); notify('Datos clínicos guardados', 'success'); } catch (error: any) { notify(error.message, 'error'); } }
  async function savePrior() { try { const missingFlag = (Object.keys(blankFlags) as Array<keyof typeof blankFlags>).some((key) => prior[key] === ''); if (!prior.examDate || missingFlag) throw new Error('Complete la fecha y marque Sí o No en cada indicador del antecedente'); await post(`/api/patients/${patient.id}/prior-exams`, { examDate: prior.examDate, confirmedKl: Number(prior.confirmedKl), painScore: prior.painScore === '' ? null : Number(prior.painScore), kneeSide: ids.kneeSide, ...booleans(prior) }); notify('Antecedente incorporado a la línea de tiempo', 'success'); } catch (error: any) { notify(error.message, 'error'); } }
  async function getRisk(kind: string) { try { setRisk({ ...risk, [kind]: await post(`/api/observations/${ids.observationId}/risks/${kind}`, {}) }); } catch (error: any) { notify(error.message, 'error'); } }
  async function report(type: 'EPISODE' | 'LONGITUDINAL') { try { const value = await post<any>(`/api/episodes/${ids.episodeId}/reports`, { reportType: type }); setReportId(value.id); notify('Reporte borrador generado', 'success'); } catch (error: any) { notify(error.message, 'error'); } }
  return <div className="workflow-stack">
    <section className="surface analysis-card"><div className="step-heading"><span>02</span><div><p className="overline">Ensemble 50/50</p><h2>Clasificación radiográfica</h2></div></div>
      {!prediction ? <div className="center-action"><button className="button primary" onClick={run} disabled={job && !['FAILED', 'SUCCEEDED'].includes(job.status)}>Ejecutar inferencia</button>{job && <span className="badge badge-info">{job.status}</span>}</div> : <div className="prediction-layout">
        <div className="kl-score"><span>KL estimado</span><strong>{prediction.predictedKl}</strong><small>Confianza {percent(prediction.confidence)}</small></div>
        <div className="probability-bars">{Object.entries(prediction.ensemble).map(([label, value]) => <div key={label}><span>{label}</span><i><b style={{ width: percent(value) }} /></i><em>{percent(value)}</em></div>)}</div>
        <div className="review-panel"><label>KL confirmado<select value={confirmedKl} onChange={(event) => setConfirmedKl(Number(event.target.value))}>{[0, 1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label><button className="button primary" onClick={() => review(confirmedKl === prediction.predictedKl ? 'CONFIRMED' : 'CORRECTED')}>Confirmar revisión</button><button className="button danger-soft" onClick={() => review('REJECTED')}>Rechazar</button><button className="button secondary" onClick={loadCams}>Ver Grad-CAM</button></div>
        {cams.length > 0 && <div className="cam-grid span">{cams.map((cam) => <figure key={cam.backbone}><img src={cam.dataUrl} alt={`Grad-CAM ${cam.backbone}`} /><figcaption>{cam.backbone} · objetivo KL{cam.targetKl}</figcaption></figure>)}</div>}
      </div>}
    </section>
    {reviewed && <section className="surface analysis-card"><div className="step-heading"><span>03</span><div><p className="overline">Contexto</p><h2>Datos clínicos y antecedentes</h2></div></div>
      <div className="form-grid"><label>Dolor 0–10, opcional<input type="number" min="0" max="10" step="0.1" value={pain} onChange={(event) => setPain(event.target.value)} /></label>{flagFields.map(([key, label]) => <label key={key}>{label}<select value={(flags as any)[key]} onChange={(event) => setFlags({ ...flags, [key]: event.target.value })}><option value="">Seleccione…</option><option value="true">Sí</option><option value="false">No</option></select></label>)}<button className="button primary span" onClick={saveClinical}>Guardar datos actuales</button></div>
      <details className="timeline-entry"><summary>Agregar antecedente de la misma rodilla</summary><p className="muted">Habilita la LSTM y aporta cambios longitudinales al riesgo de artroplastia. Use únicamente un examen anterior confirmado.</p><div className="form-grid"><label>Fecha anterior<input type="date" max={new Date().toISOString().slice(0, 10)} value={prior.examDate} onChange={(event) => setPrior({ ...prior, examDate: event.target.value })} /></label><label>KL confirmado<select value={prior.confirmedKl} onChange={(event) => setPrior({ ...prior, confirmedKl: event.target.value })}>{[0, 1, 2, 3, 4].map((value) => <option key={value}>{value}</option>)}</select></label><label>Dolor opcional<input type="number" min="0" max="10" value={prior.painScore} onChange={(event) => setPrior({ ...prior, painScore: event.target.value })} /></label>{flagFields.map(([key, label]) => <label key={key}>{label}<select value={(prior as any)[key]} onChange={(event) => setPrior({ ...prior, [key]: event.target.value })}><option value="">Seleccione…</option><option value="true">Sí</option><option value="false">No</option></select></label>)}<button className="button secondary span" onClick={savePrior}>Guardar antecedente</button></div></details>
    </section>}
    {clinicalSaved && <section className="surface analysis-card"><div className="step-heading"><span>04</span><div><p className="overline">Modelos longitudinales</p><h2>Riesgos y reporte</h2></div></div>
      <div className="risk-grid"><Risk title="Artroplastia · 24 meses" value={risk.arthroplasty} onRun={() => getRisk('arthroplasty')} /><Risk title="Progresión KL · 3–12 meses" value={risk.progression} onRun={() => getRisk('progression')} /></div>
      <div className="report-actions"><button className="button primary" onClick={() => report('EPISODE')}>Reporte del episodio</button><button className="button secondary" onClick={() => report('LONGITUDINAL')}>Reporte longitudinal</button>{reportId && <a className="button secondary" href={`/api/reports/${reportId}/download`}>Descargar PDF</a>}<button className="button ghost-button" onClick={onDone}>Volver al paciente</button></div>
    </section>}
  </div>;
}

function Risk({ title, value, onRun }: { title: string; value: any; onRun: () => void }) {
  return <article className="risk-card"><span className="overline">Estimación independiente</span><h3>{title}</h3>{!value ? <button className="button secondary" onClick={onRun}>Calcular riesgo</button> : value.available === false ? <p className="muted">{value.reason}</p> : <><strong>{percent(value.probability)}</strong><span className={`badge badge-${value.screen_positive ? 'warning' : 'success'}`}>{value.screen_positive ? 'Tamiz positivo' : 'Tamiz negativo'}</span><small>Umbral {Number(value.threshold).toFixed(3)}</small></>}</article>;
}

export default function ClinicalAnalysis({ patient, notify, onDone }: { patient: Patient; notify: Notify; onDone: () => void }) {
  const [ids, setIds] = useState<AnalysisIds>();
  return <div><div className="page-head"><div><button className="text-link" onClick={onDone}>← Volver a {patient.medicalRecordNumber}</button><h1>Nuevo análisis</h1><p>{patient.surnames}, {patient.names}</p></div></div>{!ids ? <StudyUpload patient={patient} notify={notify} onReady={setIds} /> : <ModelWorkflow ids={ids} patient={patient} notify={notify} onDone={onDone} />}</div>;
}
