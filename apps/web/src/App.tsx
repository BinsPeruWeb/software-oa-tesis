import { FormEvent, useEffect, useState } from 'react';
import { api, post } from './api';

type User = { id: string; displayName: string; role: string };
type Patient = { id: string; names: string; surnames: string; medicalRecordNumber: string; dni: string; birthDate: string; sex: string | null };
type Prediction = { predictedKl: number; confidence: number; ensemble: Record<string, number>; members: Record<string, Record<string, number>> };

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
        <label>Correo<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
        <label>Contraseña<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        <button>Continuar</button>
      </form> : <form onSubmit={verify} className="stack">
        {challenge.enrollment && <div className="enrollment"><strong>Configure su autenticador</strong><p>Ingrese esta clave una única vez:</p><code>{challenge.enrollment.secret}</code></div>}
        <label>Código TOTP de 6 dígitos<input inputMode="numeric" pattern="[0-9]{6}" value={code} onChange={(e) => setCode(e.target.value)} required autoFocus /></label>
        <button>Verificar e ingresar</button><button type="button" className="ghost" onClick={() => setChallenge(undefined)}>Volver</button>
      </form>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  </main>;
}

function PatientStep({ onSelect }: { onSelect: (patient: Patient) => void }) {
  const [identifier, setIdentifier] = useState(''); const [mode, setMode] = useState<'search' | 'create'>('search'); const [error, setError] = useState('');
  const [form, setForm] = useState({ medicalRecordNumber: '', dni: '', names: '', surnames: '', birthDate: '', sex: '', phone: '', email: '' });
  async function search(event: FormEvent) { event.preventDefault(); setError(''); try { const patient = await api<Patient | null>(`/api/patients/search?identifier=${encodeURIComponent(identifier)}`); patient ? onSelect(patient) : setError('No se encontró el paciente.'); } catch (e: any) { setError(e.message); } }
  async function create(event: FormEvent) { event.preventDefault(); setError(''); try { onSelect(await post('/api/patients', { ...form, sex: form.sex || null, email: form.email || null })); } catch (e: any) { setError(e.message); } }
  return <section className="card wide">
    <div className="section-title"><span>01</span><div><p className="eyebrow">Identificación</p><h2>Paciente</h2></div></div>
    <div className="tabs"><button className={mode === 'search' ? 'active' : ''} onClick={() => setMode('search')}>Buscar</button><button className={mode === 'create' ? 'active' : ''} onClick={() => setMode('create')}>Registrar</button></div>
    {mode === 'search' ? <form onSubmit={search} className="inline-form"><label>DNI o historia clínica<input value={identifier} onChange={(e) => setIdentifier(e.target.value)} required /></label><button>Buscar</button></form> :
      <form onSubmit={create} className="form-grid">
        {([['medicalRecordNumber','Historia clínica'],['dni','DNI'],['names','Nombres'],['surnames','Apellidos'],['birthDate','Nacimiento'],['phone','Teléfono'],['email','Correo opcional']] as const).map(([key,label]) =>
          <label key={key}>{label}<input type={key === 'birthDate' ? 'date' : key === 'email' ? 'email' : 'text'} value={form[key]} required={key !== 'email'} onChange={(e) => setForm({ ...form, [key]: e.target.value })} /></label>)}
        <label>Sexo<select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}><option value="">No registrado</option><option value="female">Femenino</option><option value="male">Masculino</option></select></label>
        <button className="span">Registrar paciente</button>
      </form>}
    {error && <p className="error">{error}</p>}
  </section>;
}

function StudyStep({ patient, onReady }: { patient: Patient; onReady: (ids: { episodeId: string; observationId: string; kneeSide: string }) => void }) {
  const [file, setFile] = useState<File>(); const [source, setSource] = useState('DICOM_BILATERAL'); const [side, setSide] = useState('R');
  const [examDate, setExamDate] = useState(new Date().toISOString().slice(0,10)); const [checks, setChecks] = useState({ projection: false, weight: false, orientation: false, inverted: false, flip: false });
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!file) return; setBusy(true); setError('');
    try {
      const episode = await post<{ id: string }>(`/api/patients/${patient.id}/episodes`, { openedAt: examDate });
      const data = new FormData(); data.append('image', file); data.append('examDate', examDate); data.append('sourceType', source); data.append('kneeSide', side);
      data.append('projectionConfirmed', String(checks.projection)); data.append('weightBearingConfirmed', String(checks.weight)); data.append('orientationConfirmed', String(checks.orientation));
      data.append('metadataInverted', String(checks.inverted)); data.append('horizontalFlip', String(checks.flip));
      const study = await api<{ observationId: string }>(`/api/episodes/${episode.id}/studies`, { method: 'POST', body: data });
      onReady({ episodeId: episode.id, observationId: study.observationId, kneeSide: side });
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="card wide">
    <div className="patient-chip"><strong>{patient.surnames}, {patient.names}</strong><span>HC {patient.medicalRecordNumber}</span></div>
    <div className="section-title"><span>02</span><div><p className="eyebrow">Estudio índice</p><h2>Cargar radiografía</h2></div></div>
    <form onSubmit={submit} className="form-grid">
      <label>Formato<select value={source} onChange={(e) => setSource(e.target.value)}><option>DICOM_BILATERAL</option><option>RASTER_BILATERAL</option><option>RASTER_SINGLE_ROI</option></select></label>
      <label>Rodilla<select value={side} onChange={(e) => setSide(e.target.value)}><option value="R">Derecha</option><option value="L">Izquierda</option></select></label>
      <label>Fecha del examen<input type="date" value={examDate} onChange={(e) => setExamDate(e.target.value)} required /></label>
      <label>Archivo<input type="file" accept={source === 'DICOM_BILATERAL' ? '.dcm,application/dicom' : 'image/png,image/jpeg'} onChange={(e) => setFile(e.target.files?.[0])} required /></label>
      <div className="checks span"><label><input type="checkbox" checked={checks.projection} onChange={(e) => setChecks({...checks,projection:e.target.checked})} required /> Confirmo proyección AP</label><label><input type="checkbox" checked={checks.weight} onChange={(e) => setChecks({...checks,weight:e.target.checked})} required /> Confirmo soporte de peso</label><label><input type="checkbox" checked={checks.orientation} onChange={(e) => setChecks({...checks,orientation:e.target.checked})} required /> Confirmo orientación y lateralidad</label><label><input type="checkbox" checked={checks.inverted} onChange={(e) => setChecks({...checks,inverted:e.target.checked})} /> Invertir polaridad declarada</label><label><input type="checkbox" checked={checks.flip} onChange={(e) => setChecks({...checks,flip:e.target.checked})} /> Corrección horizontal global</label></div>
      {source === 'RASTER_SINGLE_ROI' && <p className="notice span">Debe ser una ROI ya recortada alrededor de la articulación. La aplicación no detecta ni recorta una rodilla automáticamente.</p>}
      <button className="span" disabled={busy}>{busy ? 'Cifrando y cargando…' : 'Crear episodio y cargar'}</button>
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
