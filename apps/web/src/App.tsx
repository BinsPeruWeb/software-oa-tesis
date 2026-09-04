import { FormEvent, useEffect, useState } from 'react';
import { api, post } from './api';

type User = { id: string; displayName: string; role: string };
type Patient = { id: string; names: string; surnames: string; medicalRecordNumber: string; dni: string; birthDate: string; sex: string | null };
type Prediction = { predictedKl: number; confidence: number; ensemble: Record<string, number>; members: Record<string, Record<string, number>> };
type Preflight = {
  preflightId: string; fileKind: 'DICOM' | 'RASTER'; examDate: string | null; previewDataUrl: string;
  reviewStatus: 'ACCEPTED' | 'REJECTED' | 'REVIEW_REQUIRED' | 'UNAVAILABLE';
  suggestedLayout: 'bilateral' | 'single' | 'uncertain'; supported: boolean; model: string; costUsd: number | null;
  assessment: null | { view: string; coverage: string; laterality: string; weight_bearing: string; quality: string; confidence: number };
};

const blankFlags = { obesity: '', diabetes: '', hypertension: '', nicotineUse: '', traumaLowerExtremity: '' };
const booleans = (value: typeof blankFlags) => ({ obesity: value.obesity === 'true', diabetes: value.diabetes === 'true', hypertension: value.hypertension === 'true', nicotineUse: value.nicotineUse === 'true', traumaLowerExtremity: value.traumaLowerExtremity === 'true' });
const percent = (value: number) => `${(value * 100).toFixed(1)} %`;

function Login({ onDone }: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [challenge, setChallenge] = useState<any>(); const [code, setCode] = useState('');
  const [error, setError] = useState('');
  async function login(event: FormEvent) {
    event.preventDefault(); setError('');
    try { setChallenge(await post('/api/auth/login', { email, password })); } catch (reason: any) { setError(reason.message); }
  }
  async function verify(event: FormEvent) {
    event.preventDefault(); setError('');
    try { await post('/api/auth/mfa/verify', { challengeToken: challenge.challengeToken, code }); onDone(await api('/api/auth/me')); }
    catch (reason: any) { setError(reason.message); }
  }
  return <main className="login-shell">
    <section className="brand-panel"><div className="brand-mark">OA</div><p>Apoyo experimental para evaluación radiográfica de rodilla.</p><small>No reemplaza el criterio médico.</small></section>
    <section className="login-card">
      <p className="eyebrow">Acceso clínico seguro</p><h1>{challenge ? 'Verificación en dos pasos' : 'Iniciar sesión'}</h1>
      {!challenge ? <form onSubmit={login} className="stack">
        <label>Correo<input type="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value.slice(0,254))} required autoComplete="username" /></label>
        <label>Contraseña<input type="password" maxLength={128} value={password} onChange={(e) => setPassword(e.target.value.slice(0,128))} required autoComplete="current-password" /></label>
        <button>Continuar</button>
      </form> : <form onSubmit={verify} className="stack">
        {challenge.enrollment && <div className="enrollment"><strong>Configure su autenticador</strong><p>Ingrese esta clave una única vez:</p><code>{challenge.enrollment.secret}</code></div>}
        <label>Código TOTP de 6 dígitos<input inputMode="numeric" minLength={6} maxLength={6} pattern="[0-9]{6}" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g,'').slice(0,6))} required autoFocus /></label>
        <button>Verificar e ingresar</button><button type="button" className="ghost" onClick={() => setChallenge(undefined)}>Volver</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </main>;
}

function PatientStep({ onSelect }: { onSelect: (patient: Patient) => void }) {
  const [identifier, setIdentifier] = useState(''); const [mode, setMode] = useState<'search' | 'create'>('search'); const [error, setError] = useState('');
  const [form, setForm] = useState({ medicalRecordNumber: '', dni: '', names: '', surnames: '', birthDate: '', sex: '', phone: '', email: '' });
  const [lookupBusy, setLookupBusy] = useState(false); const [lookupMessage, setLookupMessage] = useState('');
  async function search(event: FormEvent) { event.preventDefault(); setError(''); try { const patient = await api<Patient | null>(`/api/patients/search?identifier=${encodeURIComponent(identifier)}`); patient ? onSelect(patient) : setError('No se encontró el paciente.'); } catch (e: any) { setError(e.message); } }
  async function create(event: FormEvent) { event.preventDefault(); setError(''); try { onSelect(await post('/api/patients', { ...form, sex: form.sex || null, email: form.email || null })); } catch (e: any) { setError(e.message); } }
  async function lookupDni() {
    if (!/^\d{8}$/.test(form.dni)) { setError('El DNI debe contener exactamente 8 dígitos.'); return; }
    setLookupBusy(true); setError(''); setLookupMessage('');
    try {
      const value = await api<any>(`/api/patients/lookup-dni?dni=${form.dni}`);
      if (!value.found) { setLookupMessage('No se encontraron datos para ese DNI. Puede completar el formulario manualmente.'); return; }
      setForm((current) => ({ ...current, names: value.names ?? '', surnames: value.surnames ?? '', birthDate: value.birthDate ?? '', sex: value.sex ?? '' }));
      setLookupMessage('Datos encontrados. Revíselos antes de registrar.');
    } catch (e: any) { setError(e.message); } finally { setLookupBusy(false); }
  }
  return <section className="card wide">
    <div className="section-title"><span>01</span><div><p className="eyebrow">Identificación</p><h2>Paciente</h2></div></div>
    <div className="tabs"><button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>Buscar</button><button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Registrar</button></div>
    {mode === 'search' ? <form onSubmit={search} className="inline-form"><label>DNI o historia clínica<input value={identifier} maxLength={30} onChange={(e) => setIdentifier(e.target.value.slice(0,30))} required /></label><button>Buscar</button></form> :
      <form onSubmit={create} className="form-grid">
        <label>Historia clínica<input value={form.medicalRecordNumber} minLength={1} maxLength={30} pattern="[A-Za-z0-9._/-]+" onChange={(e)=>setForm({...form,medicalRecordNumber:e.target.value.slice(0,30)})} required /></label>
        <label>DNI<div className="field-action"><input value={form.dni} inputMode="numeric" minLength={8} maxLength={8} pattern="[0-9]{8}" onChange={(e)=>setForm({...form,dni:e.target.value.replace(/\D/g,'').slice(0,8)})} required /><button type="button" className="secondary" disabled={lookupBusy || form.dni.length!==8} onClick={lookupDni}>{lookupBusy?'Consultando…':'Autocompletar'}</button></div><small>La consulta se realiza en PeruDevs solo al pulsar el botón.</small></label>
        <label>Nombres<input value={form.names} minLength={2} maxLength={80} onChange={(e)=>setForm({...form,names:e.target.value.slice(0,80)})} required /></label>
        <label>Apellidos<input value={form.surnames} minLength={2} maxLength={80} onChange={(e)=>setForm({...form,surnames:e.target.value.slice(0,80)})} required /></label>
        <label>Nacimiento<input type="date" max={new Date().toISOString().slice(0,10)} value={form.birthDate} onChange={(e)=>setForm({...form,birthDate:e.target.value})} required /></label>
        <label>Celular<input value={form.phone} inputMode="numeric" minLength={9} maxLength={9} pattern="9[0-9]{8}" placeholder="9XXXXXXXX" onChange={(e)=>setForm({...form,phone:e.target.value.replace(/\D/g,'').slice(0,9)})} required /></label>
        <label>Correo opcional<input type="email" maxLength={254} value={form.email} onChange={(e)=>setForm({...form,email:e.target.value.slice(0,254)})} /></label>
        <label>Sexo<select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="">No registrado</option><option value="female">Femenino</option><option value="male">Masculino</option></select></label>
        {lookupMessage && <p className="success span">{lookupMessage}</p>}
        <button className="span">Registrar paciente</button>
      </form>}
    {error && <p className="error">{error}</p>}
  </section>;
}

function StudyStep({ patient, onReady }: { patient: Patient; onReady: (ids: { episodeId: string; observationId: string; kneeSide: string }) => void }) {
  const [file, setFile] = useState<File>(); const [side, setSide] = useState('R'); const [layout,setLayout]=useState<'bilateral'|'single'|''>('');
  const [examDate, setExamDate] = useState(new Date().toISOString().slice(0,10)); const [confirmed,setConfirmed]=useState(false);
  const [advanced,setAdvanced]=useState({invert:false,swap:false}); const [overrideReason,setOverrideReason]=useState('');
  const [preflight,setPreflight]=useState<Preflight>(); const [checking,setChecking]=useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function chooseFile(selected?:File) {
    setFile(selected); setPreflight(undefined); setLayout(''); setError(''); setOverrideReason('');
    if(!selected) return;
    setChecking(true);
    try {
      const data=new FormData(); data.append('image',selected);
      const result=await api<Preflight>('/api/studies/preflight',{method:'POST',body:data});
      setPreflight(result);
      if(result.examDate) setExamDate(result.examDate);
      if(result.fileKind==='DICOM' && result.suggestedLayout!=='single') setLayout('bilateral');
      else if(result.suggestedLayout!=='uncertain') setLayout(result.suggestedLayout);
      if(result.assessment?.laterality==='left') setSide('L'); else if(result.assessment?.laterality==='right') setSide('R');
    } catch(e:any){setError(e.message);} finally{setChecking(false);}
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!file || !preflight || !layout) return; setBusy(true); setError('');
    try {
      const episode = await post<{ id: string }>(`/api/patients/${patient.id}/episodes`, { openedAt: examDate });
      const data = new FormData(); data.append('image', file); data.append('examDate', examDate); data.append('preflightId',preflight.preflightId); data.append('imageLayout',layout); data.append('kneeSide', side);
      data.append('acquisitionConfirmed',String(confirmed)); data.append('invertPolarity',String(advanced.invert)); data.append('swapSides',String(advanced.swap));
      if(overrideReason) data.append('manualOverrideReason',overrideReason);
      const study = await api<{ observationId: string }>(`/api/episodes/${episode.id}/studies`, { method: 'POST', body: data });
      onReady({ episodeId: episode.id, observationId: study.observationId, kneeSide: side });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="card wide">
    <div className="patient-chip"><strong>{patient.surnames}, {patient.names}</strong><span>HC {patient.medicalRecordNumber}</span></div>
    <div className="section-title"><span>02</span><div><p className="eyebrow">Estudio índice</p><h2>Cargar radiografía</h2></div></div>
    <form onSubmit={submit} className="form-grid">
      <label className="span upload-box">Archivo DICOM, PNG o JPG<input type="file" accept=".dcm,application/dicom,image/png,image/jpeg" onChange={(e)=>void chooseFile(e.target.files?.[0])} required /><small>La aplicación detectará el formato. Para revisar el contenido enviará a OpenRouter una miniatura reducida, sin metadatos DICOM y con bordes enmascarados.</small></label>
      {checking && <p className="analysis-state span">Verificando que sea una radiografía de rodilla…</p>}
      {preflight && <div className="preflight span">
        <img src={preflight.previewDataUrl} alt="Vista previa de la radiografía seleccionada" />
        <div><strong>{preflight.reviewStatus==='ACCEPTED'?'Radiografía frontal de rodilla reconocida':preflight.reviewStatus==='REJECTED'?'La imagen no fue reconocida como radiografía de rodilla':preflight.reviewStatus==='UNAVAILABLE'?'Revisión automática no disponible':'La imagen necesita confirmación manual'}</strong>
          <p>{preflight.fileKind==='DICOM'?'Archivo DICOM detectado':'Imagen PNG/JPG detectada'} · revisión con {preflight.model}</p>
          <small>Se envió al proveedor una miniatura sin metadatos DICOM y con bordes enmascarados. Esta revisión no realiza diagnóstico.</small>
        </div>
      </div>}
      {preflight && <>
        <label>Fecha del examen<input type="date" max={new Date().toISOString().slice(0,10)} value={examDate} onChange={(e) => setExamDate(e.target.value)} required /></label>
        <fieldset><legend>¿Qué contiene la imagen?</legend><div className="segments"><button type="button" className={layout==='bilateral'?'active':''} onClick={()=>setLayout('bilateral')}>Ambas rodillas</button><button type="button" className={layout==='single'?'active':''} disabled={preflight.fileKind==='DICOM'} onClick={()=>setLayout('single')}>Una rodilla</button></div></fieldset>
        <fieldset><legend>Rodilla a analizar</legend><div className="segments"><button type="button" className={side==='R'?'active':''} onClick={()=>setSide('R')}>Derecha</button><button type="button" className={side==='L'?'active':''} onClick={()=>setSide('L')}>Izquierda</button></div></fieldset>
        <label className="confirm-box span"><input type="checkbox" checked={confirmed} onChange={(e)=>setConfirmed(e.target.checked)} required /><span><strong>Confirmo que es una radiografía frontal tomada con apoyo de peso</strong><small>Esta condición no puede comprobarse con total fiabilidad mediante la imagen.</small></span></label>
        {preflight.reviewStatus==='REJECTED' && <label className="span">Motivo para continuar después de revisión manual<textarea minLength={20} maxLength={500} value={overrideReason} onChange={(e)=>setOverrideReason(e.target.value.slice(0,500))} required placeholder="Explique por qué considera que el archivo sí corresponde al estudio…" /></label>}
        {!preflight.supported && preflight.fileKind==='DICOM' && <p className="notice span">El revisor sugirió que este DICOM contiene una sola rodilla. Verifique la vista previa: el contrato DICOM requiere una imagen bilateral.</p>}
        <details className="span advanced"><summary>Opciones avanzadas de orientación</summary><div className="checks"><label><input type="checkbox" checked={advanced.invert} disabled={preflight.fileKind!=='DICOM'} onChange={(e)=>setAdvanced({...advanced,invert:e.target.checked})} /> La imagen DICOM se ve con polaridad invertida</label><label><input type="checkbox" checked={advanced.swap} disabled={layout!=='bilateral'} onChange={(e)=>setAdvanced({...advanced,swap:e.target.checked})} /> Intercambiar los lados de la imagen bilateral</label></div></details>
      </>}
      <button className="span" disabled={busy||checking||!preflight||!layout||!confirmed}>{busy ? 'Cifrando y cargando…' : 'Continuar con esta radiografía'}</button>
    </form>{error && <p className="error">{error}</p>}
  </section>;
}

function ModelStep({ ids, patient }: { ids: { episodeId: string; observationId: string; kneeSide: string }; patient: Patient }) {
  const [job, setJob] = useState<any>(); const [prediction, setPrediction] = useState<Prediction>(); const [predictionId, setPredictionId] = useState('');
  const [cams, setCams] = useState<Array<{backbone:string;targetKl:number;dataUrl:string}>>([]);
  const [confirmedKl, setConfirmedKl] = useState(0); const [reviewed, setReviewed] = useState(false); const [flags, setFlags] = useState(blankFlags); const [pain, setPain] = useState('');
  const [clinicalSaved, setClinicalSaved] = useState(false); const [risk, setRisk] = useState<any>({}); const [prior, setPrior] = useState({ examDate: '', confirmedKl: '0', painScore: '', ...blankFlags });
  const [reportId, setReportId] = useState(''); const [error, setError] = useState('');
  async function run() {
    try {
      const queued = await post<any>(`/api/observations/${ids.observationId}/inference`, {}); setJob(queued);
      for (let n = 0; n < 240; n++) {
        await new Promise((resolve) => setTimeout(resolve, 1000)); const state = await api<any>(`/api/inference-jobs/${queued.id}`); setJob(state);
        if (state.status === 'SUCCEEDED') { setPrediction(state.probabilities); setPredictionId(state.predictionId); setConfirmedKl(state.probabilities.predictedKl); return; }
        if (state.status === 'FAILED') throw new Error(`Inferencia fallida (${state.errorCode})`);
      } throw new Error('La inferencia excedió el tiempo esperado');
    } catch (e: any) { setError(e.message); }
  }
  async function review(decision: 'CONFIRMED'|'CORRECTED'|'REJECTED') { try { await post(`/api/predictions/${predictionId}/review`, { decision, confirmedKl: decision === 'REJECTED' ? null : confirmedKl }); setReviewed(decision !== 'REJECTED'); } catch(e:any){setError(e.message);} }
  async function loadCams() { try { for(let n=0;n<30;n++){ const values=await api<any[]>(`/api/predictions/${predictionId}/explanations`); if(values.length===2){setCams(values);return;} await new Promise(resolve=>setTimeout(resolve,1000)); } throw new Error('Grad-CAM aún está procesándose; inténtelo nuevamente'); } catch(e:any){setError(e.message);} }
  async function saveClinical() { try { if (Object.values(flags).some((v) => v === '')) throw new Error('Marque Sí o No en cada indicador clínico'); await post(`/api/observations/${ids.observationId}/clinical`, { painScore: pain === '' ? null : Number(pain), ...booleans(flags) }); setClinicalSaved(true); } catch(e:any){setError(e.message);} }
  async function savePrior() { try { if (!prior.examDate || ['obesity','diabetes','hypertension','nicotineUse','traumaLowerExtremity'].some((key) => (prior as any)[key] === '')) throw new Error('Complete el antecedente'); await post(`/api/patients/${patient.id}/prior-exams`, { examDate: prior.examDate, confirmedKl: Number(prior.confirmedKl), painScore: prior.painScore === '' ? null : Number(prior.painScore), kneeSide: ids.kneeSide, ...booleans(prior as any) }); } catch(e:any){setError(e.message);} }
  async function getRisk(kind: string) { try { setRisk({...risk,[kind]:await post(`/api/observations/${ids.observationId}/risks/${kind}`,{})}); } catch(e:any){setError(e.message);} }
  async function report() { try { const value=await post<any>(`/api/episodes/${ids.episodeId}/reports`,{});setReportId(value.id);}catch(e:any){setError(e.message);} }
  const flagFields = [['obesity','Obesidad'],['diabetes','Diabetes'],['hypertension','Hipertensión'],['nicotineUse','Consumo de nicotina'],['traumaLowerExtremity','Trauma de miembro inferior']] as const;
  return <div className="flow">
    <section className="card wide"><div className="section-title"><span>03</span><div><p className="eyebrow">Ensemble 50/50</p><h2>Clasificación KL</h2></div></div>
      {!prediction ? <><button onClick={run} disabled={job && !['FAILED','SUCCEEDED'].includes(job.status)}>Ejecutar inferencia</button>{job && <p className="status">Estado: <strong>{job.status}</strong></p>}</> : <div className="prediction">
        <div className="score"><small>KL estimado</small><strong>{prediction.predictedKl}</strong><span>Confianza {percent(prediction.confidence)}</span></div>
        <div className="bars">{Object.entries(prediction.ensemble).map(([label,value])=><div key={label}><span>{label}</span><i><b style={{width:percent(value)}} /></i><em>{percent(value)}</em></div>)}</div>
        <p className="notice">Revise todas las probabilidades y los mapas Grad-CAM. La confirmación médica es obligatoria antes de calcular riesgos.</p>
        <div className="explanations"><button className="ghost" onClick={loadCams}>Mostrar Grad-CAM</button>{cams.map(cam=><figure key={cam.backbone}><img src={cam.dataUrl} alt={`Grad-CAM ${cam.backbone} para KL${cam.targetKl}`}/><figcaption>{cam.backbone} · objetivo KL{cam.targetKl}</figcaption></figure>)}</div>
        <div className="review"><label>KL clínico<select value={confirmedKl} onChange={(e)=>setConfirmedKl(Number(e.target.value))}>{[0,1,2,3,4].map(v=><option key={v}>{v}</option>)}</select></label><button onClick={()=>review(confirmedKl===prediction.predictedKl?'CONFIRMED':'CORRECTED')}>Confirmar revisión</button><button className="danger" onClick={()=>review('REJECTED')}>Rechazar</button></div>
      </div>}
    </section>
    {reviewed && <section className="card wide"><div className="section-title"><span>04</span><div><p className="eyebrow">Variables semánticas</p><h2>Clínica e historial</h2></div></div>
      <div className="form-grid"><label>Dolor 0–10 (opcional)<input type="number" min="0" max="10" step="0.1" value={pain} onChange={(e)=>setPain(e.target.value)} placeholder="No disponible" /></label>{flagFields.map(([key,label])=><label key={key}>{label}<select value={flags[key]} onChange={(e)=>setFlags({...flags,[key]:e.target.value})}><option value="">Seleccione…</option><option value="true">Sí</option><option value="false">No</option></select></label>)}<button className="span" onClick={saveClinical}>Guardar clínica actual</button></div>
      <details><summary>Agregar antecedente de la misma rodilla</summary><div className="form-grid compact"><label>Fecha<input type="date" value={prior.examDate} onChange={(e)=>setPrior({...prior,examDate:e.target.value})}/></label><label>KL confirmado<select value={prior.confirmedKl} onChange={(e)=>setPrior({...prior,confirmedKl:e.target.value})}>{[0,1,2,3,4].map(v=><option key={v}>{v}</option>)}</select></label><label>Dolor opcional<input type="number" min="0" max="10" value={prior.painScore} onChange={(e)=>setPrior({...prior,painScore:e.target.value})}/></label>{flagFields.map(([key,label])=><label key={key}>{label}<select value={(prior as any)[key]} onChange={(e)=>setPrior({...prior,[key]:e.target.value})}><option value="">Seleccione…</option><option value="true">Sí</option><option value="false">No</option></select></label>)}<button className="span" onClick={savePrior}>Guardar antecedente</button></div></details>
    </section>}
    {clinicalSaved && <section className="card wide"><div className="section-title"><span>05</span><div><p className="eyebrow">Resultados separados</p><h2>Riesgos experimentales</h2></div></div><div className="risk-grid"><Result title="Artroplastia · 24 meses" value={risk.arthroplasty} action={()=>getRisk('arthroplasty')} /><Result title="Progresión KL · 3–12 meses" value={risk.progression} action={()=>getRisk('progression')} /></div><p className="notice">Un tamiz positivo no es una indicación quirúrgica. Interprete cada modelo por separado.</p><button onClick={report}>Generar reporte borrador</button>{reportId && <a className="button-link" href={`/api/reports/${reportId}/download`}>Descargar PDF</a>}</section>}
    {error && <p className="error floating">{error}<button onClick={()=>setError('')}>×</button></p>}
  </div>;
}

function Result({title,value,action}:{title:string;value:any;action:()=>void}) { return <article className="result"><h3>{title}</h3>{!value?<button onClick={action}>Calcular</button>:value.available===false?<p>{value.reason}</p>:<><strong>{percent(value.probability)}</strong><span>Umbral {percent(value.threshold)}</span><mark className={value.screen_positive?'positive':'negative'}>{value.screen_positive?'Tamiz positivo':'Tamiz negativo'}</mark><small>{value.warning}</small></>}</article>; }

export default function App() {
  const [user,setUser]=useState<User>(); const [patient,setPatient]=useState<Patient>(); const [ids,setIds]=useState<{episodeId:string;observationId:string;kneeSide:string}>();
  useEffect(()=>{api<User>('/api/auth/me').then(setUser).catch(()=>undefined)},[]);
  if(!user) return <Login onDone={setUser}/>;
  return <><header><div className="wordmark"><b>OA</b><span>Clínica experimental</span></div><div><span>{user.displayName}</span><button className="ghost" onClick={async()=>{await post('/api/auth/logout',{});setUser(undefined)}}>Salir</button></div></header><main className="workspace"><div className="intro"><p className="eyebrow">Nuevo análisis</p><h1>Evaluación integral de rodilla</h1><p>Clasificación radiográfica, revisión clínica y riesgos longitudinales con trazabilidad completa.</p></div>{!patient?<PatientStep onSelect={setPatient}/>:!ids?<StudyStep patient={patient} onReady={setIds}/>:<ModelStep patient={patient} ids={ids}/>}</main><footer>Herramienta de investigación · Resultados sujetos a revisión médica · No usar como único fundamento diagnóstico</footer></>;
}
