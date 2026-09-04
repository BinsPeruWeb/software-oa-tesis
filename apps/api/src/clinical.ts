import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { AuthUser, ClinicianGuard, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';
import { PAGE_SIZE, pageNumber } from './pagination';
import { boundedNumber, isoDate, uuid } from './validation';

type Flags = { obesity: boolean; diabetes: boolean; hypertension: boolean; nicotineUse: boolean; traumaLowerExtremity: boolean };
type ContextRow = {
  observation_id: string; patient_id: string; episode_id: string; exam_date: string; knee_side: 'L' | 'R';
  confirmed_kl: number; pain_score: number | null; obesity: boolean; diabetes: boolean; hypertension: boolean;
  nicotine_use: boolean; trauma_lower_extremity: boolean; birth_date_cipher: Buffer; sex_cipher: Buffer | null;
  kl_origin: 'CLINICIAN' | 'MODEL';
};

const requiredBoolean = (value: unknown, name: string) => {
  if (typeof value !== 'boolean') throw new BadRequestException(`${name} debe marcarse Sí o No`);
  return value;
};
const validatePain = (value: unknown) => {
  if (value === null || value === undefined) return null;
  return boundedNumber(value, 'Dolor', 0, 10);
};
const yearsAt = (birth: string, exam: string) => (Date.parse(exam) - Date.parse(birth)) / (365.25 * 86400_000);

@Controller('api')
@UseGuards(SessionGuard, CsrfGuard, ClinicianGuard)
export class ClinicalController {
  constructor(
    private readonly db: DatabaseService, private readonly crypto: CryptoService,
    private readonly assets: AssetService, private readonly audit: AuditService,
  ) {}

  private flags(body: any): Flags {
    return {
      obesity: requiredBoolean(body.obesity, 'Obesidad'),
      diabetes: requiredBoolean(body.diabetes, 'Diabetes'),
      hypertension: requiredBoolean(body.hypertension, 'Hipertensión'),
      nicotineUse: requiredBoolean(body.nicotineUse, 'Consumo de nicotina'),
      traumaLowerExtremity: requiredBoolean(body.traumaLowerExtremity, 'Trauma de miembro inferior'),
    };
  }

  private async ensureObservation(observationId: string, userId: string) {
    const owned = await this.db.query(
      `SELECT 1 FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id JOIN clinical_episodes e ON e.id=s.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE k.id=$1 AND p.owner_clinician_id=$2 AND p.archived_at IS NULL`, [observationId, userId],
    );
    if (!owned.rowCount) throw new BadRequestException('Observación no encontrada');
  }

  private async ensurePatient(patientId: string, userId: string) {
    const owned = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND owner_clinician_id=$2 AND archived_at IS NULL', [patientId, userId]);
    if (!owned.rowCount) throw new BadRequestException('Paciente no encontrado');
  }

  @Get('patients/:patientId/clinical-profile')
  async clinicalProfile(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id);
    const row = (await this.db.query<any>(
      `SELECT pain_score "painScore",obesity,diabetes,hypertension,nicotine_use "nicotineUse",
       trauma_lower_extremity "traumaLowerExtremity",updated_at "updatedAt"
       FROM patient_clinical_profiles WHERE patient_id=$1`, [patientId],
    )).rows[0];
    return row ?? null;
  }

  @Patch('patients/:patientId/clinical-profile')
  async updateClinicalProfile(@Param('patientId') patientId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id);
    const flags = this.flags(body); const pain = validatePain(body.painScore);
    await this.db.query(
      `INSERT INTO patient_clinical_profiles(patient_id,pain_score,obesity,diabetes,hypertension,nicotine_use,trauma_lower_extremity,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(patient_id) DO UPDATE SET pain_score=EXCLUDED.pain_score,
       obesity=EXCLUDED.obesity,diabetes=EXCLUDED.diabetes,hypertension=EXCLUDED.hypertension,
       nicotine_use=EXCLUDED.nicotine_use,trauma_lower_extremity=EXCLUDED.trauma_lower_extremity,
       updated_by=EXCLUDED.updated_by,updated_at=now()`,
      [patientId, pain, flags.obesity, flags.diabetes, flags.hypertension, flags.nicotineUse, flags.traumaLowerExtremity, user.id],
    );
    await this.audit.record(user.id, 'PATIENT_CLINICAL_PROFILE_UPDATED', 'Patient', patientId);
    return { saved: true };
  }

  @Post('observations/:id/clinical')
  async clinical(@Param('id') observationId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    await this.ensureObservation(observationId, user.id);
    const flags = this.flags(body); const pain = validatePain(body.painScore);
    await this.db.query(
      `INSERT INTO clinical_observations(knee_observation_id,pain_score,obesity,diabetes,hypertension,nicotine_use,trauma_lower_extremity,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(knee_observation_id) DO UPDATE SET pain_score=EXCLUDED.pain_score,obesity=EXCLUDED.obesity,
       diabetes=EXCLUDED.diabetes,hypertension=EXCLUDED.hypertension,nicotine_use=EXCLUDED.nicotine_use,
       trauma_lower_extremity=EXCLUDED.trauma_lower_extremity,recorded_by=EXCLUDED.recorded_by,recorded_at=now()`,
      [observationId, pain, flags.obesity, flags.diabetes, flags.hypertension, flags.nicotineUse, flags.traumaLowerExtremity, user.id],
    );
    await this.audit.record(user.id, 'CLINICAL_OBSERVATION_RECORDED', 'KneeObservation', observationId);
    return { saved: true };
  }

  @Post('patients/:patientId/prior-exams')
  async prior(@Param('patientId') patientId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente');
    const owned = await this.db.query('SELECT 1 FROM patients WHERE id=$1 AND owner_clinician_id=$2 AND archived_at IS NULL', [patientId, user.id]);
    if (!owned.rowCount) throw new BadRequestException('Paciente no encontrado');
    const flags = this.flags(body); const pain = validatePain(body.painScore);
    if (!['L', 'R'].includes(body.kneeSide)) throw new BadRequestException('Lateralidad inválida');
    body.examDate = isoDate(body.examDate, 'Fecha del antecedente');
    boundedNumber(body.confirmedKl, 'KL confirmado', 0, 4, true);
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO prior_exams(patient_id,knee_side,exam_date,confirmed_kl,pain_score,obesity,diabetes,hypertension,nicotine_use,trauma_lower_extremity,recorded_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT(patient_id,knee_side,exam_date) DO UPDATE SET confirmed_kl=EXCLUDED.confirmed_kl,pain_score=EXCLUDED.pain_score,
       obesity=EXCLUDED.obesity,diabetes=EXCLUDED.diabetes,hypertension=EXCLUDED.hypertension,
       nicotine_use=EXCLUDED.nicotine_use,trauma_lower_extremity=EXCLUDED.trauma_lower_extremity,recorded_by=EXCLUDED.recorded_by
       RETURNING id`,
      [patientId, body.kneeSide, body.examDate, body.confirmedKl, pain, flags.obesity, flags.diabetes,
        flags.hypertension, flags.nicotineUse, flags.traumaLowerExtremity, user.id],
    );
    await this.audit.record(user.id, 'PRIOR_EXAM_RECORDED', 'PriorExam', result.rows[0].id);
    return { id: result.rows[0].id };
  }

  @Get('patients/:patientId/prior-exams')
  async priorExams(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id);
    return (await this.db.query(
      `SELECT id,knee_side "kneeSide",exam_date "examDate",confirmed_kl "confirmedKl",pain_score "painScore",
       obesity,diabetes,hypertension,nicotine_use "nicotineUse",trauma_lower_extremity "traumaLowerExtremity"
       FROM prior_exams WHERE patient_id=$1 ORDER BY exam_date DESC,knee_side`, [patientId],
    )).rows;
  }

  @Delete('patients/:patientId/prior-exams/:id')
  async deletePrior(@Param('patientId') patientId: string, @Param('id') id: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); id = uuid(id, 'Antecedente'); await this.ensurePatient(patientId, user.id);
    const deleted = await this.db.query('DELETE FROM prior_exams WHERE id=$1 AND patient_id=$2 RETURNING id', [id, patientId]);
    if (!deleted.rowCount) throw new BadRequestException('Antecedente no encontrado');
    await this.audit.record(user.id, 'PRIOR_EXAM_DELETED', 'PriorExam', id);
    return { deleted: true };
  }

  private async currentContext(observationId: string, userId: string): Promise<ContextRow> {
    const result = await this.db.query<ContextRow>(
      `SELECT k.id observation_id,e.patient_id,e.id episode_id,s.exam_date,k.knee_side,
       COALESCE(r.confirmed_kl,(mp.probabilities->>'predictedKl')::smallint) confirmed_kl,
       CASE WHEN r.confirmed_kl IS NULL THEN 'MODEL' ELSE 'CLINICIAN' END kl_origin,c.pain_score,
       c.obesity,c.diabetes,c.hypertension,c.nicotine_use,c.trauma_lower_extremity,p.birth_date_cipher,p.sex_cipher
       FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       JOIN LATERAL (SELECT id,probabilities FROM model_predictions WHERE observation_id=k.id AND model_name='Ensemble-v2' ORDER BY created_at DESC LIMIT 1) mp ON true
       LEFT JOIN LATERAL (SELECT confirmed_kl,decision FROM clinician_reviews WHERE prediction_id=mp.id ORDER BY reviewed_at DESC LIMIT 1) r ON true
       JOIN clinical_observations c ON c.knee_observation_id=k.id WHERE k.id=$1 AND p.owner_clinician_id=$2
       AND p.archived_at IS NULL AND (r.decision IS NULL OR r.decision<>'REJECTED')`, [observationId, userId],
    );
    if (!result.rows[0]) throw new BadRequestException('Se requiere una clasificación KL válida y el perfil clínico del paciente');
    return result.rows[0];
  }

  private async history(patientId: string, kneeSide: 'L' | 'R', before: string) {
    return (await this.db.query<any>(
      `WITH combined AS (
         SELECT pe.exam_date,pe.confirmed_kl,pe.pain_score,pe.obesity,pe.diabetes,pe.hypertension,
          pe.nicotine_use,pe.trauma_lower_extremity,2 priority
         FROM prior_exams pe WHERE pe.patient_id=$1 AND pe.knee_side=$2 AND pe.exam_date<$3
         UNION ALL
         SELECT s.exam_date,COALESCE(cr.confirmed_kl,(mp.probabilities->>'predictedKl')::smallint),co.pain_score,
          co.obesity,co.diabetes,co.hypertension,co.nicotine_use,co.trauma_lower_extremity,1 priority
         FROM radiographic_studies s JOIN clinical_episodes e ON e.id=s.episode_id
         JOIN knee_observations k ON k.study_id=s.id JOIN clinical_observations co ON co.knee_observation_id=k.id
         JOIN LATERAL (SELECT id,probabilities FROM model_predictions WHERE observation_id=k.id AND model_name='Ensemble-v2' ORDER BY created_at DESC LIMIT 1) mp ON true
         LEFT JOIN LATERAL (SELECT decision,confirmed_kl FROM clinician_reviews WHERE prediction_id=mp.id ORDER BY reviewed_at DESC LIMIT 1) cr ON true
         WHERE e.patient_id=$1 AND k.knee_side=$2 AND s.exam_date<$3 AND (cr.decision IS NULL OR cr.decision<>'REJECTED')
       ) SELECT DISTINCT ON (exam_date) * FROM combined ORDER BY exam_date,priority DESC`,
      [patientId, kneeSide, before],
    )).rows;
  }

  private async mlRisk(path: string, payload: unknown) {
    const started = performance.now();
    const response = await fetch(`${process.env.ML_SERVICE_URL}${path}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-service-token': process.env.SERVICE_TOKEN ?? '' },
      body: JSON.stringify(payload),
    });
    const result = await response.json() as any;
    if (!response.ok) throw new BadRequestException(result?.detail ?? 'Predicción de riesgo no disponible');
    return { result, latencyMs: performance.now() - started };
  }

  private semanticFlags(row: ContextRow | any) {
    return { obesity: row.obesity, diabetes: row.diabetes, hypertension: row.hypertension,
      nicotine_use: row.nicotine_use, trauma_lower_extremity: row.trauma_lower_extremity };
  }

  @Post('observations/:id/risks/arthroplasty')
  async arthroplasty(@Param('id') observationId: string, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    const current = await this.currentContext(observationId, user.id);
    const birth = this.crypto.decryptText(current.birth_date_cipher, `patient:${current.patient_id}:birth`);
    const sex = current.sex_cipher ? this.crypto.decryptText(current.sex_cipher, `patient:${current.patient_id}:sex`) : null;
    const history = await this.history(current.patient_id, current.knee_side, current.exam_date);
    const payload = {
      date_of_birth: birth, exam_date: current.exam_date, current_kl: current.confirmed_kl,
      pain_score: current.pain_score === null ? null : Number(current.pain_score), sex, knee_side: current.knee_side,
      ...this.semanticFlags(current),
      prior_exams: history.map((item) => ({ date: item.exam_date, KLG: item.confirmed_kl, knee_side: current.knee_side })),
    };
    const { result, latencyMs } = await this.mlRisk('/v1/risks/arthroplasty', payload);
    const id = await this.persistRisk(current, user, result, latencyMs, payload, 'XGBoost-v2');
    await this.audit.record(user.id, 'ARTHROPLASTY_RISK_COMPUTED', 'ModelPrediction', id);
    return { id, ...result, klOrigin: current.kl_origin, warning: 'Resultado experimental. No constituye indicación quirúrgica.' };
  }

  @Post('observations/:id/risks/progression')
  async progression(@Param('id') observationId: string, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    const current = await this.currentContext(observationId, user.id);
    if (current.confirmed_kl === 4) return { available: false, klOrigin: current.kl_origin, reason: 'No aplicable: el estudio actual (t2) es KL4, el grado máximo de la escala' };
    const prior = (await this.history(current.patient_id, current.knee_side, current.exam_date)).at(-1);
    if (!prior) return { available: false, klOrigin: current.kl_origin, reason: 'Se necesita un estudio anterior de la misma rodilla con una fecha diferente' };
    const birth = this.crypto.decryptText(current.birth_date_cipher, `patient:${current.patient_id}:birth`);
    const payload = {
      patient_reference: this.crypto.blindIndex(current.patient_id),
      observations: [
        { date: prior.exam_date, KLG: prior.confirmed_kl, age_at_exam: yearsAt(birth, prior.exam_date),
          pain_score: prior.pain_score === null ? null : Number(prior.pain_score), knee_side: current.knee_side, ...this.semanticFlags(prior) },
        { date: current.exam_date, KLG: current.confirmed_kl, age_at_exam: yearsAt(birth, current.exam_date),
          pain_score: current.pain_score === null ? null : Number(current.pain_score), knee_side: current.knee_side, ...this.semanticFlags(current) },
      ],
    };
    const { result, latencyMs } = await this.mlRisk('/v1/risks/progression', payload);
    const id = await this.persistRisk(current, user, result, latencyMs, payload, 'LSTM-v2');
    await this.audit.record(user.id, 'PROGRESSION_RISK_COMPUTED', 'ModelPrediction', id);
    return { available: true, id, ...result, klOrigin: current.kl_origin, warning: 'Resultado experimental; requiere interpretación médica.' };
  }

  private async persistRisk(current: ContextRow, user: AuthUser, result: any, latencyMs: number, payload: unknown, model: string) {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    await this.db.query('DELETE FROM model_predictions WHERE observation_id=$1 AND model_name=$2', [current.observation_id, model]);
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO model_predictions(observation_id,model_name,model_version,artifact_hashes,input_hash,input_source,
       knee_side,probabilities,threshold,screen_positive,kl_origin,latency_ms,device,correlation_id,created_by)
       VALUES($1,$2,$3,$4,$5,'STRUCTURED',$6,$7,$8,$9,$10,$11,'cpu-service',gen_random_uuid(),$12) RETURNING id`,
      [current.observation_id, model, result.model_version, JSON.stringify({ model: result.model_hash }), hash,
        current.knee_side, JSON.stringify({ probability: result.probability, target: result.target, horizon: result.horizon,
          features: result.features ?? null }), result.threshold, result.screen_positive, current.kl_origin, latencyMs, user.id],
    );
    return inserted.rows[0].id;
  }

  private async renderRadiograph(storageKey: string, contentType: string) {
    const image = await this.assets.read(storageKey); const form = new FormData();
    const bytes = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer;
    form.append('image', new Blob([bytes], { type: contentType }), 'radiograph');
    const response = await fetch(`${process.env.ML_SERVICE_URL}/v1/images/render`, {
      method: 'POST', body: form, signal: AbortSignal.timeout(30_000), headers: { 'x-service-token': process.env.SERVICE_TOKEN ?? '' },
    });
    if (!response.ok) return null;
    const result = await response.json() as { preview_base64_png: string };
    return Buffer.from(result.preview_base64_png, 'base64');
  }

  private async studySummary(study: any, includeGradcams = false) {
    const predictions = (await this.db.query<any>(
      `SELECT mp.id,mp.model_name "modelName",mp.model_version "modelVersion",mp.probabilities,mp.threshold,
       mp.screen_positive "screenPositive",mp.kl_origin "klOrigin",mp.latency_ms "latencyMs",mp.device,mp.created_at "createdAt",
       cr.decision,cr.confirmed_kl "confirmedKl",cr.reason,cr.reviewed_at "reviewedAt"
       FROM model_predictions mp LEFT JOIN LATERAL (
        SELECT decision,confirmed_kl,reason,reviewed_at FROM clinician_reviews WHERE prediction_id=mp.id ORDER BY reviewed_at DESC LIMIT 1
       ) cr ON true WHERE mp.observation_id=$1 ORDER BY mp.created_at`, [study.observationId],
    )).rows;
    const ensemble = predictions.find((item: any) => item.modelName === 'Ensemble-v2') ?? null;
    const currentKl = ensemble?.confirmedKl ?? ensemble?.probabilities?.predictedKl;
    const progression = predictions.find((item: any) => item.modelName === 'LSTM-v2')
      ?? (currentKl === 4 ? { available: false, reason: 'No aplicable: el estudio actual es KL4, el grado máximo de la escala.' } : null);
    const jobs = (await this.db.query<any>(
      `SELECT id,job_type "jobType",status,error_code "errorCode",started_at "startedAt",finished_at "finishedAt"
       FROM inference_jobs WHERE observation_id=$1 ORDER BY created_at`, [study.observationId],
    )).rows;
    const elapsed = jobs.filter((item: any) => item.startedAt && item.finishedAt)
      .reduce((sum: number, item: any) => sum + Math.max(0, new Date(item.finishedAt).getTime() - new Date(item.startedAt).getTime()), 0);
    const result: any = {
      ...study,
      previewUrl: `/api/studies/${study.studyId}/preview`,
      status: jobs.some((item: any) => item.status === 'FAILED') ? 'FAILED' : ensemble ? (jobs.some((item: any) => item.status !== 'SUCCEEDED') ? 'PROCESSING' : 'COMPLETED') : 'PROCESSING',
      ensemble,
      arthroplasty: predictions.find((item: any) => item.modelName === 'XGBoost-v2') ?? null,
      progression,
      radiologySeconds: ensemble?.latencyMs == null ? null : Number((Number(ensemble.latencyMs) / 1000).toFixed(2)),
      totalProcessingSeconds: Number((elapsed / 1000).toFixed(2)), jobs,
    };
    if (includeGradcams && ensemble) {
      const cams = await this.db.query<{ id: string; backbone: string; target_kl: number; storage_key: string }>(
        `SELECT g.id,g.backbone,g.target_kl,a.storage_key FROM gradcam_explanations g JOIN stored_assets a ON a.id=g.asset_id
         WHERE g.prediction_id=$1 ORDER BY g.backbone`, [ensemble.id],
      );
      result.gradcams = await Promise.all(cams.rows.map(async (item) => ({ id: item.id, backbone: item.backbone,
        targetKl: item.target_kl, dataUrl: `data:image/png;base64,${(await this.assets.read(item.storage_key)).toString('base64')}` })));
    }
    return result;
  }

  @Get('patients/:patientId/analyses')
  async analyses(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id);
    const rows = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",s.id "studyId",s.exam_date "examDate",s.source_type "sourceType",
       k.id "observationId",k.knee_side "kneeSide" FROM clinical_episodes e JOIN radiographic_studies s ON s.episode_id=e.id
       JOIN knee_observations k ON k.study_id=s.id WHERE e.patient_id=$1 ORDER BY s.exam_date DESC,s.created_at DESC`, [patientId],
    )).rows;
    return Promise.all(rows.map((row) => this.studySummary(row)));
  }

  @Get('episodes/:episodeId/analysis')
  async episodeAnalysis(@Param('episodeId') episodeId: string, @CurrentUser() user: AuthUser) {
    episodeId = uuid(episodeId, 'Episodio');
    const episode = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",e.status,p.id "patientId"
       FROM clinical_episodes e JOIN patients p ON p.id=e.patient_id
       WHERE e.id=$1 AND p.owner_clinician_id=$2 AND p.archived_at IS NULL`, [episodeId, user.id],
    )).rows[0];
    if (!episode) throw new BadRequestException('Episodio no encontrado');
    const studies = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",s.id "studyId",s.exam_date "examDate",s.source_type "sourceType",
       k.id "observationId",k.knee_side "kneeSide" FROM clinical_episodes e JOIN radiographic_studies s ON s.episode_id=e.id
       JOIN knee_observations k ON k.study_id=s.id WHERE e.id=$1 ORDER BY s.exam_date,s.created_at`, [episodeId],
    )).rows;
    const reports = (await this.db.query(
      `SELECT id,report_type "reportType",generated_at "generatedAt" FROM draft_reports WHERE episode_id=$1 ORDER BY generated_at DESC`, [episodeId],
    )).rows;
    return { ...episode, studies: await Promise.all(studies.map((row) => this.studySummary(row, true))), reports };
  }

  @Get('studies/:studyId/preview')
  async studyPreview(@Param('studyId') studyId: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    studyId = uuid(studyId, 'Estudio');
    const study = (await this.db.query<{ storage_key: string; content_type: string }>(
      `SELECT a.storage_key,a.content_type FROM radiographic_studies s JOIN stored_assets a ON a.id=s.asset_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       WHERE s.id=$1 AND p.owner_clinician_id=$2`, [studyId, user.id],
    )).rows[0];
    if (!study) throw new BadRequestException('Estudio no encontrado');
    const image = await this.renderRadiograph(study.storage_key, study.content_type);
    if (!image) throw new BadRequestException('No fue posible generar la vista del estudio');
    response.set({ 'content-type': 'image/png', 'cache-control': 'private, no-store' }); response.send(image);
  }

  @Post('episodes/:episodeId/reports')
  async report(@Param('episodeId') episodeId: string, @Body() body: { reportType?: string }, @CurrentUser() user: AuthUser) {
    episodeId = uuid(episodeId, 'Episodio');
    const reportType = body.reportType === 'LONGITUDINAL' ? 'LONGITUDINAL' : 'EPISODE';
    const patient = (await this.db.query<any>(
      `SELECT e.patient_id,e.opened_at,p.names_cipher,p.surnames_cipher,p.medical_record_cipher,p.dni_cipher,
       p.birth_date_cipher,p.sex_cipher FROM clinical_episodes e JOIN patients p ON p.id=e.patient_id
       WHERE e.id=$1 AND p.owner_clinician_id=$2 AND p.archived_at IS NULL`, [episodeId, user.id],
    )).rows[0];
    if (!patient) throw new BadRequestException('Episodio no encontrado');
    const studies = (await this.db.query<any>(
      `SELECT s.id,s.exam_date,s.source_type,a.storage_key,a.content_type,k.id observation_id,k.knee_side,e.id episode_id
       FROM radiographic_studies s JOIN stored_assets a ON a.id=s.asset_id JOIN knee_observations k ON k.study_id=s.id
       JOIN clinical_episodes e ON e.id=s.episode_id WHERE e.patient_id=$1 AND ($2='LONGITUDINAL' OR e.id=$3)
       ORDER BY s.exam_date,k.knee_side`, [patient.patient_id, reportType, episodeId],
    )).rows;
    if (!studies.length) throw new BadRequestException('No hay estudios para generar el reporte');
    for (const study of studies) {
      study.preview = await this.renderRadiograph(study.storage_key, study.content_type);
      study.clinical = (await this.db.query<any>('SELECT * FROM clinical_observations WHERE knee_observation_id=$1', [study.observation_id])).rows[0] ?? null;
      study.predictions = (await this.db.query<any>(
        `SELECT mp.id,mp.model_name,mp.model_version,mp.probabilities,mp.threshold,mp.screen_positive,mp.created_at,
         cr.decision,cr.confirmed_kl,cr.reason,cr.reviewed_at FROM model_predictions mp
         LEFT JOIN LATERAL (SELECT * FROM clinician_reviews WHERE prediction_id=mp.id ORDER BY reviewed_at DESC LIMIT 1) cr ON true
         WHERE mp.observation_id=$1 ORDER BY mp.created_at`, [study.observation_id],
      )).rows;
      const ensemble = study.predictions.find((item: any) => item.model_name === 'Ensemble-v2');
      study.gradcams = ensemble ? await Promise.all((await this.db.query<{ backbone: string; target_kl: number; storage_key: string }>(
        `SELECT g.backbone,g.target_kl,a.storage_key FROM gradcam_explanations g JOIN stored_assets a ON a.id=g.asset_id WHERE g.prediction_id=$1 ORDER BY g.backbone`, [ensemble.id],
      )).rows.map(async (item) => ({ ...item, image: await this.assets.read(item.storage_key) }))) : [];
    }
    const history = (await this.db.query<any>('SELECT * FROM prior_exams WHERE patient_id=$1 ORDER BY exam_date', [patient.patient_id])).rows;
    const organization = (await this.db.query<{ value: any }>("SELECT value FROM app_settings WHERE key='organization'")).rows[0]?.value ?? {};
    const context = {
      organization, reportType, episodeId, patientId: patient.patient_id, openedAt: patient.opened_at,
      patientName: `${this.crypto.decryptText(patient.names_cipher, `patient:${patient.patient_id}:names`)} ${this.crypto.decryptText(patient.surnames_cipher, `patient:${patient.patient_id}:surnames`)}`,
      mrn: this.crypto.decryptText(patient.medical_record_cipher, `patient:${patient.patient_id}:mrn`),
      dni: this.crypto.decryptText(patient.dni_cipher, `patient:${patient.patient_id}:dni`),
      birthDate: this.crypto.decryptText(patient.birth_date_cipher, `patient:${patient.patient_id}:birth`),
      sex: patient.sex_cipher ? this.crypto.decryptText(patient.sex_cipher, `patient:${patient.patient_id}:sex`) : null,
      clinician: user.displayName, studies, history,
    };
    const pdf = await this.makePdf(context);
    const stored = await this.assets.write(pdf);
    const asset = await this.db.query<{ id: string }>(
      `INSERT INTO stored_assets(patient_id,kind,storage_key,content_type,plaintext_sha256,size_bytes,created_by)
       VALUES($1,'REPORT',$2,'application/pdf',$3,$4,$5) RETURNING id`,
      [patient.patient_id, stored.storageKey, createHash('sha256').update(pdf).digest('hex'), pdf.length, user.id],
    );
    const report = await this.db.query<{ id: string }>(
      `INSERT INTO draft_reports(episode_id,asset_id,generated_by,report_type) VALUES($1,$2,$3,$4) RETURNING id`,
      [episodeId, asset.rows[0].id, user.id, reportType],
    );
    await this.audit.record(user.id, 'DRAFT_REPORT_GENERATED', 'DraftReport', report.rows[0].id, { reportType });
    return { id: report.rows[0].id, status: 'DRAFT', reportType };
  }

  private makePdf(context: any): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const document = new PDFDocument({ size: 'A4', margin: 46, bufferPages: true, info: { Title: 'Reporte OA — borrador experimental' } });
      const chunks: Buffer[] = []; const width = 503;
      const ensure = (height: number) => { if (document.y + height > 770) document.addPage(); };
      const heading = (title: string) => { ensure(42); document.moveDown(.7).fillColor('#173f3a').font('Helvetica-Bold').fontSize(13).text(title); document.moveDown(.35); };
      const field = (label: string, value: unknown, x: number, y: number, w: number) => {
        document.fillColor('#65736f').font('Helvetica').fontSize(7.5).text(label.toUpperCase(), x, y, { width: w });
        document.fillColor('#18312e').font('Helvetica-Bold').fontSize(9.5).text(String(value ?? 'No disponible'), x, y + 11, { width: w });
      };
      document.on('data', (chunk) => chunks.push(chunk)); document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.rect(0, 0, 595, 112).fill('#173f3a');
      document.fillColor('#e7b75f').font('Helvetica-Bold').fontSize(11).text(String(context.organization.name ?? 'Clínica OA').toUpperCase(), 46, 32);
      document.fillColor('#ffffff').fontSize(22).text(context.reportType === 'LONGITUDINAL' ? 'Reporte longitudinal' : 'Reporte del episodio', 46, 53);
      document.font('Helvetica').fontSize(9).fillColor('#c5d7d2').text(context.organization.reportSubtitle ?? 'Evaluación experimental de osteoartritis', 46, 83);
      document.roundedRect(465, 32, 82, 24, 4).fill('#f2dfb7').fillColor('#6b4b16').font('Helvetica-Bold').fontSize(8).text('BORRADOR', 478, 41);
      document.y = 132;
      field('Paciente', context.patientName, 46, 132, 245); field('Historia clínica', context.mrn, 310, 132, 120); field('DNI', context.dni, 447, 132, 100);
      field('Nacimiento', context.birthDate, 46, 172, 145); field('Sexo', context.sex === 'female' ? 'Femenino' : context.sex === 'male' ? 'Masculino' : 'No registrado', 210, 172, 130); field('Médico responsable', context.clinician, 358, 172, 189);
      document.y = 208;
      for (const study of context.studies) {
        ensure(260); heading(`Estudio ${String(study.exam_date).slice(0, 10)} · Rodilla ${study.knee_side === 'L' ? 'izquierda' : 'derecha'}`);
        const blockY = document.y;
        document.roundedRect(46, blockY, width, 190, 7).fillAndStroke('#f6f8f7', '#dce3df');
        document.roundedRect(58, blockY + 12, 205, 166, 5).fill('#15201e');
        if (study.preview) { try { document.image(study.preview, 58, blockY + 12, { fit: [205, 166], align: 'center', valign: 'center' }); } catch { /* vista textual */ } }
        document.fillColor('#65736f').font('Helvetica').fontSize(8).text(`Entrada: ${study.source_type}`, 280, blockY + 15, { width: 250 });
        const ensemble = study.predictions.find((item: any) => item.model_name === 'Ensemble-v2');
        if (ensemble) {
          const values = ensemble.probabilities ?? {}; const confirmed = ensemble.confirmed_kl;
          document.fillColor('#18312e').font('Helvetica-Bold').fontSize(12).text(`KL estimado: ${values.predictedKl ?? '—'}`, 280, blockY + 38);
          document.fontSize(10).text(`KL clínico: ${confirmed ?? 'Pendiente de revisión'}`, 280, blockY + 57);
          document.font('Helvetica').fontSize(8).fillColor('#65736f').text(`Confianza: ${values.confidence == null ? '—' : `${(Number(values.confidence) * 100).toFixed(1)} %`}`, 280, blockY + 75);
          let y = blockY + 97;
          for (let grade = 0; grade <= 4; grade += 1) {
            const probability = Number(values.ensemble?.[`KL${grade}`] ?? 0);
            document.fillColor('#40534f').fontSize(7).text(`KL${grade}`, 280, y + 1, { width: 25 });
            document.roundedRect(310, y, 145, 7, 3).fill('#dfe7e3');
            document.roundedRect(310, y, Math.max(1, 145 * probability), 7, 3).fill('#c5943d');
            document.fillColor('#40534f').text(`${(probability * 100).toFixed(1)} %`, 465, y, { width: 55, align: 'right' }); y += 15;
          }
          const memberSummary = Object.entries(values.members ?? {}).map(([model, member]: [string, any]) => {
            const probabilities = Object.entries(member ?? {}) as Array<[string, unknown]>;
            const best = probabilities.reduce((current, candidate) => Number(candidate[1]) > Number(current[1]) ? candidate : current, ['—', 0] as [string, unknown]);
            return `${model === 'resnet50' ? 'ResNet50' : model === 'densenet121' ? 'DenseNet121' : model}: ${best[0]} (${(Number(best[1]) * 100).toFixed(1)} %)`;
          }).join(' · ');
          if (memberSummary) document.fillColor('#65736f').font('Helvetica').fontSize(7).text(memberSummary, 280, blockY + 174, { width: 250 });
        } else document.fillColor('#8b5c34').fontSize(9).text('Clasificación KL aún no ejecutada.', 280, blockY + 42);
        document.y = blockY + 198;
        if (study.clinical) {
          ensure(102); const c = study.clinical; const clinicalY = document.y + 5;
          document.roundedRect(46, clinicalY, width, 88, 6).fillAndStroke('#f2f6f4', '#dce5e1');
          document.fillColor('#173f3a').font('Helvetica-Bold').fontSize(8.5).text('CONTEXTO CLÍNICO DEL ESTUDIO', 58, clinicalY + 10, { width: width - 24 });
          const clinicalFields = [
            ['Dolor', c.pain_score == null ? 'No disponible' : `${c.pain_score}/10`],
            ['Obesidad', c.obesity ? 'Sí' : 'No'], ['Diabetes', c.diabetes ? 'Sí' : 'No'],
            ['Hipertensión', c.hypertension ? 'Sí' : 'No'], ['Consumo de nicotina', c.nicotine_use ? 'Sí' : 'No'],
            ['Trauma de miembro inferior', c.trauma_lower_extremity ? 'Sí' : 'No'],
          ];
          clinicalFields.forEach(([label, value], index) => {
            const column = index % 3; const row = Math.floor(index / 3); const x = 58 + column * 161; const y = clinicalY + 30 + row * 27;
            document.fillColor('#74817d').font('Helvetica').fontSize(6.5).text(label.toUpperCase(), x, y, { width: 145, lineBreak: false });
            document.fillColor('#18312e').font('Helvetica-Bold').fontSize(9).text(value, x, y + 10, { width: 145, lineBreak: false });
          });
          document.y = clinicalY + 94;
        }
        for (const prediction of study.predictions.filter((item: any) => item.model_name !== 'Ensemble-v2')) {
          ensure(56); const p = prediction.probabilities ?? {}; const name = prediction.model_name.startsWith('XGBoost') ? 'Riesgo de artroplastia · 24 meses' : 'Riesgo de progresión KL · 3–12 meses';
          document.moveDown(.45).roundedRect(46, document.y, width, 42, 5).fill(prediction.screen_positive ? '#fbefd9' : '#e7f2ec');
          const y = document.y + 11; document.fillColor('#18312e').font('Helvetica-Bold').fontSize(9).text(name, 58, y, { width: 300 });
          document.fontSize(15).text(`${(Number(p.probability ?? 0) * 100).toFixed(1)} %`, 430, y - 2, { width: 100, align: 'right' }); document.y += 48;
        }
        if (study.gradcams.length) {
          ensure(220); heading('Mapas de explicación Grad-CAM'); const y = document.y;
          study.gradcams.slice(0, 2).forEach((cam: any, index: number) => { try { document.image(cam.image, 46 + index * 255, y, { fit: [238, 145] }); } catch { /* imagen incompatible */ } document.fillColor('#65736f').fontSize(8).text(`${cam.backbone} · objetivo KL${cam.target_kl}`, 46 + index * 255, y + 150, { width: 238, align: 'center' }); });
          document.y = y + 170;
        }
      }
      if (context.history.length) {
        heading('Antecedentes longitudinales registrados');
        for (const item of context.history) { ensure(20); document.fillColor('#40534f').font('Helvetica').fontSize(8.5).text(`${String(item.exam_date).slice(0, 10)} · Rodilla ${item.knee_side} · KL ${item.confirmed_kl} · Dolor ${item.pain_score ?? 'N/D'}`); }
      }
      ensure(58); const disclaimerY = document.y + 2;
      document.roundedRect(46, disclaimerY, width, 54, 5).fill('#fbe9e7');
      document.fillColor('#8b2e2e').font('Helvetica-Bold').fontSize(8.5).text('USO EXPERIMENTAL', 58, disclaimerY + 11);
      document.font('Helvetica').fontSize(8).text('Este documento requiere revisión médica. Los resultados no constituyen diagnóstico definitivo ni indicación automática de cirugía.', 58, disclaimerY + 25, { width: 475 });
      document.y = disclaimerY + 56;
      const pages = document.bufferedPageRange();
      for (let index = pages.start; index < pages.start + pages.count; index += 1) {
        document.switchToPage(index); document.fillColor('#7a8783').font('Helvetica').fontSize(7.5)
          .text(`Reporte ${context.episodeId.slice(0, 8)} · Generado ${new Date().toISOString().slice(0, 10)} · Página ${index + 1} de ${pages.count}`, 46, 780, { width, align: 'center', lineBreak: false });
      }
      document.end();
    });
  }

  @Get('patients/:patientId/reports')
  async reports(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente');
    return (await this.db.query(
      `SELECT r.id,r.report_type "reportType",r.status,r.generated_at "generatedAt",e.opened_at "episodeDate"
       FROM draft_reports r JOIN clinical_episodes e ON e.id=r.episode_id JOIN patients p ON p.id=e.patient_id
       WHERE p.id=$1 AND p.owner_clinician_id=$2 ORDER BY r.generated_at DESC LIMIT 10`, [patientId, user.id],
    )).rows;
  }

  @Get('reports')
  async allReports(@Query('page') pageValue: string | undefined, @CurrentUser() user: AuthUser) {
    const requested = pageNumber(pageValue);
    const total = Number((await this.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM draft_reports r JOIN clinical_episodes e ON e.id=r.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1`, [user.id],
    )).rows[0].count); const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const page = Math.min(requested, pages);
    const rows = (await this.db.query<any>(
      `SELECT r.id,r.report_type "reportType",r.status,r.generated_at "generatedAt",e.opened_at "episodeDate",p.id "patientId",
       p.names_cipher,p.surnames_cipher,p.medical_record_cipher FROM draft_reports r JOIN clinical_episodes e ON e.id=r.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1 ORDER BY r.generated_at DESC
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, [user.id],
    )).rows.map((row) => ({ id: row.id, reportType: row.reportType, status: row.status, generatedAt: row.generatedAt,
      episodeDate: row.episodeDate, patientId: row.patientId,
      patientName: `${this.crypto.decryptText(row.names_cipher, `patient:${row.patientId}:names`)} ${this.crypto.decryptText(row.surnames_cipher, `patient:${row.patientId}:surnames`)}`,
      medicalRecordNumber: this.crypto.decryptText(row.medical_record_cipher, `patient:${row.patientId}:mrn`) }));
    return { items: rows, page, pageSize: PAGE_SIZE, total, pages };
  }

  @Get('reports/:id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    id = uuid(id, 'Reporte');
    const row = (await this.db.query<{ storage_key: string }>(
      `SELECT a.storage_key FROM draft_reports r JOIN stored_assets a ON a.id=r.asset_id JOIN clinical_episodes e ON e.id=r.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE r.id=$1 AND p.owner_clinician_id=$2`, [id, user.id],
    )).rows[0];
    if (!row) throw new BadRequestException('Reporte no encontrado');
    const pdf = await this.assets.read(row.storage_key);
    await this.audit.record(user.id, 'DRAFT_REPORT_DOWNLOADED', 'DraftReport', id);
    response.set({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="oa-report-${id}.pdf"`, 'cache-control': 'no-store' });
    response.send(pdf);
  }
}
