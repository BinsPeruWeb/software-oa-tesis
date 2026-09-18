import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { createHash, randomUUID } from 'node:crypto';
import { AuthUser, ClinicianGuard, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';
import { pageNumber, paged } from './pagination';
import { boundedNumber, isoDate, optionalText, uuid } from './validation';

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

  private async ensurePatient(patientId: string, userId: string, includeArchived = false) {
    const owned = await this.db.query(
      'SELECT 1 FROM patients WHERE id=$1 AND owner_clinician_id=$2 AND ($3::boolean OR archived_at IS NULL)',
      [patientId, userId, includeArchived],
    );
    if (!owned.rowCount) throw new BadRequestException('Paciente no encontrado');
  }

  @Get('patients/:patientId/clinical-profile')
  async clinicalProfile(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id, true);
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
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id, true);
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
    const refreshed = await this.refreshProgressions(current.patient_id, current.knee_side, user, observationId);
    return refreshed.get(observationId) ?? {
      available: false,
      klOrigin: current.kl_origin,
      reason: current.confirmed_kl === 4
        ? 'No aplicable: el estudio actual (t2) es KL4, el grado máximo de la escala'
        : 'Se necesita un estudio anterior de la misma rodilla con una fecha diferente',
    };
  }

  private async progressionFor(current: ContextRow, user: AuthUser) {
    if (current.confirmed_kl === 4) {
      await this.db.query("DELETE FROM model_predictions WHERE observation_id=$1 AND model_name='LSTM-v2'", [current.observation_id]);
      return { available: false, klOrigin: current.kl_origin, reason: 'No aplicable: el estudio actual (t2) es KL4, el grado máximo de la escala' };
    }
    const prior = (await this.history(current.patient_id, current.knee_side, current.exam_date)).at(-1);
    if (!prior) {
      await this.db.query("DELETE FROM model_predictions WHERE observation_id=$1 AND model_name='LSTM-v2'", [current.observation_id]);
      return { available: false, klOrigin: current.kl_origin, reason: 'Se necesita un estudio anterior de la misma rodilla con una fecha diferente' };
    }
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

  private async refreshProgressions(patientId: string, kneeSide: 'L' | 'R', user: AuthUser, requestedId: string) {
    const ids = (await this.db.query<{ id: string }>(
      `SELECT k.id FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       WHERE e.patient_id=$1 AND k.knee_side=$2 AND p.owner_clinician_id=$3 AND p.archived_at IS NULL
       ORDER BY s.exam_date ASC,k.knee_side ASC,k.id ASC`,
      [patientId, kneeSide, user.id],
    )).rows;
    const results = new Map<string, any>();
    for (const item of ids) {
      try {
        const context = await this.currentContext(item.id, user.id);
        results.set(item.id, await this.progressionFor(context, user));
      } catch (error) {
        if (item.id === requestedId) throw error;
      }
    }
    return results;
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

  private async recommendationStudies(patientId: string, userId: string) {
    return (await this.db.query<any>(
      `SELECT k.id "observationId",s.exam_date "examDate",k.knee_side "kneeSide",
       COALESCE(cr.confirmed_kl,(ensemble.probabilities->>'predictedKl')::smallint) "klGrade",
       cr.confirmed_kl "confirmedKl",p.birth_date_cipher "birthDateCipher",
       (ensemble.probabilities->>'confidence')::double precision confidence,co.pain_score "painScore",
       co.obesity,co.diabetes,co.hypertension,co.nicotine_use "nicotineUse",
       co.trauma_lower_extremity "traumaLowerExtremity",
       (xgb.probabilities->>'probability')::double precision "arthroplastyProbability",
       (lstm.probabilities->>'probability')::double precision "progressionProbability"
       FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       JOIN clinical_observations co ON co.knee_observation_id=k.id
       JOIN LATERAL (SELECT id,probabilities FROM model_predictions WHERE observation_id=k.id AND model_name='Ensemble-v2' ORDER BY created_at DESC LIMIT 1) ensemble ON true
       LEFT JOIN LATERAL (SELECT decision,confirmed_kl FROM clinician_reviews WHERE prediction_id=ensemble.id ORDER BY reviewed_at DESC LIMIT 1) cr ON true
       LEFT JOIN LATERAL (SELECT probabilities FROM model_predictions WHERE observation_id=k.id AND model_name='XGBoost-v2' ORDER BY created_at DESC LIMIT 1) xgb ON true
       LEFT JOIN LATERAL (SELECT probabilities FROM model_predictions WHERE observation_id=k.id AND model_name='LSTM-v2' ORDER BY created_at DESC LIMIT 1) lstm ON true
       WHERE e.patient_id=$1 AND p.owner_clinician_id=$2 AND (cr.decision IS NULL OR cr.decision<>'REJECTED')
       ORDER BY s.exam_date ASC,k.knee_side ASC,k.id ASC`,
      [patientId, userId],
    )).rows.map((row) => ({
      observationId: row.observationId,
      exam_date: String(row.examDate).slice(0, 10),
      knee_side: row.kneeSide,
      kl_grade: Number(row.klGrade),
      confidence: row.confidence == null ? null : Number(row.confidence),
      pain_score: row.painScore == null ? null : Number(row.painScore),
      obesity: row.obesity,
      diabetes: row.diabetes,
      hypertension: row.hypertension,
      nicotine_use: row.nicotineUse,
      trauma_lower_extremity: row.traumaLowerExtremity,
      arthroplasty_probability: row.arthroplastyProbability == null ? null : Number(row.arthroplastyProbability),
      progression_probability: row.progressionProbability == null ? null : Number(row.progressionProbability),
      age_at_exam: Number(yearsAt(
        this.crypto.decryptText(row.birthDateCipher, `patient:${patientId}:birth`),
        String(row.examDate).slice(0, 10),
      ).toFixed(2)),
      kl_source: row.confirmedKl == null ? 'MODEL' : 'CLINICIAN',
    }));
  }

  private async storedRecommendation(patientId: string, scope: 'STUDY' | 'PATIENT', observationId?: string) {
    const row = (await this.db.query<any>(
      `SELECT id,content_cipher,"provider_model","provider_request_id",cost_usd,input_hash,generated_at
       FROM clinical_recommendations WHERE patient_id=$1 AND scope=$2
       AND (($3::uuid IS NULL AND observation_id IS NULL) OR observation_id=$3) LIMIT 1`,
      [patientId, scope, observationId ?? null],
    )).rows[0];
    if (!row) return null;
    const storedContent = JSON.parse(this.crypto.decryptText(row.content_cipher, `recommendation:${row.id}:content`));
    return {
      id: row.id,
      scope,
      content: this.normalizeRecommendationContent(storedContent),
      providerModel: row.provider_model,
      providerRequestId: row.provider_request_id,
      costUsd: row.cost_usd == null ? null : Number(row.cost_usd),
      inputHash: row.input_hash,
      generatedAt: row.generated_at,
    };
  }

  private normalizeRecommendationContent(content: any) {
    const useOsteoarthritis = (value: unknown) => String(value ?? '').replace(
      /\bartrosis\b/gi,
      (term) => term[0] === term[0].toUpperCase() ? 'Osteoartritis' : 'osteoartritis',
    ).trim();
    const legacyActions = Array.isArray(content?.actions)
      ? content.actions.map(useOsteoarthritis).filter(Boolean).join(' ')
      : '';
    let recommendation = useOsteoarthritis(content?.recommendation) || legacyActions;
    if (recommendation && !/^Se recomienda\b/i.test(recommendation)) {
      recommendation = `Se recomienda ${recommendation.charAt(0).toLocaleLowerCase('es')}${recommendation.slice(1)}`;
    }
    return {
      headline: useOsteoarthritis(content?.headline),
      summary: useOsteoarthritis(content?.summary),
      recommendation,
      priority: ['routine', 'soon', 'prompt'].includes(content?.priority) ? content.priority : 'routine',
    };
  }

  private async generateRecommendation(
    patientId: string,
    scope: 'STUDY' | 'PATIENT',
    studies: any[],
    user: AuthUser,
    observationId?: string,
  ) {
    const firstDate = Date.parse(studies[0].exam_date);
    const semanticStudies = studies.map(({ observationId: _ignored, exam_date, ...study }, index) => ({
      sequence: index + 1,
      months_since_first: Number(((Date.parse(exam_date) - firstDate) / (365.25 / 12 * 86400_000)).toFixed(2)),
      ...study,
    }));
    const payload = { scope, studies: semanticStudies };
    const inputHash = createHash('sha256').update(JSON.stringify({ contractVersion: 'recommendation-v3', payload })).digest('hex');
    const existing = await this.storedRecommendation(patientId, scope, observationId);
    if (existing?.inputHash === inputHash) return existing;
    const { result } = await this.mlRisk('/v1/recommendations', payload);
    if (!result.available || !result.content) return existing ?? null;
    const id = existing?.id ?? randomUUID();
    const cipher = this.crypto.encrypt(JSON.stringify(result.content), `recommendation:${id}:content`);
    if (existing) {
      await this.db.query(
        `UPDATE clinical_recommendations SET content_cipher=$2,provider_model=$3,provider_request_id=$4,
         input_hash=$5,cost_usd=$6,generated_by=$7,generated_at=now() WHERE id=$1`,
        [id, cipher, result.provider_model, result.provider_request_id, inputHash, result.cost_usd, user.id],
      );
    } else {
      await this.db.query(
        `INSERT INTO clinical_recommendations(id,patient_id,observation_id,scope,content_cipher,provider_model,
         provider_request_id,input_hash,cost_usd,generated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, patientId, observationId ?? null, scope, cipher, result.provider_model, result.provider_request_id,
          inputHash, result.cost_usd, user.id],
      );
    }
    await this.audit.record(user.id, 'CLINICAL_RECOMMENDATION_GENERATED', 'ClinicalRecommendation', id, { scope });
    return this.storedRecommendation(patientId, scope, observationId);
  }

  @Post('observations/:id/recommendations')
  async recommendations(@Param('id') observationId: string, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    const current = await this.currentContext(observationId, user.id);
    const studies = await this.recommendationStudies(current.patient_id, user.id);
    const currentStudy = studies.find((study) => study.observationId === observationId);
    if (!currentStudy) throw new BadRequestException('El análisis no está disponible para generar orientación');
    const [individualResult, generalResult] = await Promise.allSettled([
      this.generateRecommendation(current.patient_id, 'STUDY', [currentStudy], user, observationId),
      studies.length >= 2
        ? this.generateRecommendation(current.patient_id, 'PATIENT', studies, user)
        : Promise.resolve(null),
    ]);
    const individual = individualResult.status === 'fulfilled' ? individualResult.value : null;
    const general = generalResult.status === 'fulfilled' ? generalResult.value : null;
    return {
      individual, general, studyCount: studies.length,
      individualUpdated: Boolean(individual), generalUpdated: studies.length < 2 || Boolean(general),
    };
  }

  @Get('patients/:patientId/recommendation')
  async patientRecommendation(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente');
    await this.ensurePatient(patientId, user.id, true);
    const studies = await this.recommendationStudies(patientId, user.id);
    if (!studies.length) return null;
    if (studies.length >= 2) return this.storedRecommendation(patientId, 'PATIENT');
    return this.storedRecommendation(patientId, 'STUDY', studies[0].observationId);
  }

  private validateClinicalNote(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('La nota clínica debe ser texto');
    const normalized = value.replace(/\r\n/g, '\n').trim();
    if (normalized.length > 1200) throw new BadRequestException('La nota clínica admite hasta 1200 caracteres');
    return normalized;
  }

  private async storedClinicalNote(patientId: string, scope: 'STUDY' | 'PATIENT', observationId?: string) {
    const row = (await this.db.query<any>(
      `SELECT id,content_cipher,updated_at "updatedAt" FROM clinical_notes
       WHERE patient_id=$1 AND scope=$2
       AND (($3::uuid IS NULL AND observation_id IS NULL) OR observation_id=$3) LIMIT 1`,
      [patientId, scope, observationId ?? null],
    )).rows[0];
    if (!row) return null;
    return {
      id: row.id,
      content: this.crypto.decryptText(row.content_cipher, `clinical-note:${row.id}:content`),
      updatedAt: row.updatedAt,
    };
  }

  private async saveClinicalNote(
    patientId: string, scope: 'STUDY' | 'PATIENT', content: string, user: AuthUser, observationId?: string,
  ) {
    const existing = (await this.db.query<{ id: string }>(
      `SELECT id FROM clinical_notes WHERE patient_id=$1 AND scope=$2
       AND (($3::uuid IS NULL AND observation_id IS NULL) OR observation_id=$3) LIMIT 1`,
      [patientId, scope, observationId ?? null],
    )).rows[0];
    if (!content) {
      if (existing) {
        await this.db.query('DELETE FROM clinical_notes WHERE id=$1', [existing.id]);
        await this.audit.record(user.id, 'CLINICAL_NOTE_DELETED', 'ClinicalNote', existing.id, { scope });
      }
      return null;
    }
    const id = existing?.id ?? randomUUID();
    const cipher = this.crypto.encrypt(content, `clinical-note:${id}:content`);
    if (existing) {
      await this.db.query(
        'UPDATE clinical_notes SET content_cipher=$2,updated_by=$3,updated_at=now() WHERE id=$1',
        [id, cipher, user.id],
      );
    } else {
      await this.db.query(
        `INSERT INTO clinical_notes(id,patient_id,observation_id,scope,content_cipher,updated_by)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [id, patientId, observationId ?? null, scope, cipher, user.id],
      );
    }
    await this.audit.record(user.id, existing ? 'CLINICAL_NOTE_UPDATED' : 'CLINICAL_NOTE_CREATED', 'ClinicalNote', id, { scope });
    return this.storedClinicalNote(patientId, scope, observationId);
  }

  @Get('patients/:patientId/clinical-note')
  async patientClinicalNote(@Param('patientId') patientId: string, @CurrentUser() user: AuthUser) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id, true);
    return this.storedClinicalNote(patientId, 'PATIENT');
  }

  @Patch('patients/:patientId/clinical-note')
  async updatePatientClinicalNote(
    @Param('patientId') patientId: string, @Body() body: { content?: unknown }, @CurrentUser() user: AuthUser,
  ) {
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id);
    return this.saveClinicalNote(patientId, 'PATIENT', this.validateClinicalNote(body.content), user);
  }

  @Patch('observations/:id/clinical-note')
  async updateStudyClinicalNote(
    @Param('id') observationId: string, @Body() body: { content?: unknown }, @CurrentUser() user: AuthUser,
  ) {
    observationId = uuid(observationId, 'Observación'); await this.ensureObservation(observationId, user.id);
    const context = await this.currentContext(observationId, user.id);
    return this.saveClinicalNote(
      context.patient_id, 'STUDY', this.validateClinicalNote(body.content), user, observationId,
    );
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
    const patientId = study.patientId ?? (await this.db.query<{ patient_id: string }>(
      `SELECT e.patient_id FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id WHERE k.id=$1`, [study.observationId],
    )).rows[0]?.patient_id;
    result.recommendation = patientId
      ? await this.storedRecommendation(patientId, 'STUDY', study.observationId)
      : null;
    result.note = patientId
      ? await this.storedClinicalNote(patientId, 'STUDY', study.observationId)
      : null;
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
    patientId = uuid(patientId, 'Paciente'); await this.ensurePatient(patientId, user.id, true);
    const rows = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",s.id "studyId",s.exam_date "examDate",s.source_type "sourceType",
       k.id "observationId",k.knee_side "kneeSide",e.patient_id "patientId" FROM clinical_episodes e JOIN radiographic_studies s ON s.episode_id=e.id
       JOIN knee_observations k ON k.study_id=s.id WHERE e.patient_id=$1 ORDER BY s.exam_date DESC,k.knee_side,k.id`, [patientId],
    )).rows;
    return Promise.all(rows.map((row) => this.studySummary(row)));
  }

  @Get('episodes/:episodeId/analysis')
  async episodeAnalysis(@Param('episodeId') episodeId: string, @CurrentUser() user: AuthUser) {
    episodeId = uuid(episodeId, 'Episodio');
    const episode = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",e.status,p.id "patientId",(p.archived_at IS NOT NULL) archived
       FROM clinical_episodes e JOIN patients p ON p.id=e.patient_id
       WHERE e.id=$1 AND p.owner_clinician_id=$2`, [episodeId, user.id],
    )).rows[0];
    if (!episode) throw new BadRequestException('Episodio no encontrado');
    const studies = (await this.db.query<any>(
      `SELECT e.id "episodeId",e.opened_at "episodeDate",s.id "studyId",s.exam_date "examDate",s.source_type "sourceType",
       k.id "observationId",k.knee_side "kneeSide",e.patient_id "patientId" FROM clinical_episodes e JOIN radiographic_studies s ON s.episode_id=e.id
       JOIN knee_observations k ON k.study_id=s.id WHERE e.id=$1 ORDER BY s.exam_date,k.knee_side,k.id`, [episodeId],
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
      study.note = await this.storedClinicalNote(patient.patient_id, 'STUDY', study.observation_id);
    }
    const history = (await this.db.query<any>('SELECT * FROM prior_exams WHERE patient_id=$1 ORDER BY exam_date', [patient.patient_id])).rows;
    const organization = (await this.db.query<{ value: any }>("SELECT value FROM app_settings WHERE key='organization'")).rows[0]?.value ?? {};
    const recommendationInput = await this.recommendationStudies(patient.patient_id, user.id);
    const episodeRecommendationInput = recommendationInput.find(
      (item) => item.observationId === studies[0].observation_id,
    );
    const recommendation = reportType === 'LONGITUDINAL' && recommendationInput.length >= 2
      ? await this.generateRecommendation(patient.patient_id, 'PATIENT', recommendationInput, user)
      : episodeRecommendationInput
        ? await this.generateRecommendation(
          patient.patient_id, 'STUDY', [episodeRecommendationInput], user, episodeRecommendationInput.observationId,
        )
        : null;
    if (!recommendation) {
      throw new BadRequestException('No fue posible generar la interpretación clínica. Inténtelo nuevamente.');
    }
    const note = reportType === 'LONGITUDINAL'
      ? await this.storedClinicalNote(patient.patient_id, 'PATIENT')
      : studies[0].note;
    const context = {
      organization, reportType, episodeId, patientId: patient.patient_id, openedAt: patient.opened_at,
      patientName: `${this.crypto.decryptText(patient.names_cipher, `patient:${patient.patient_id}:names`)} ${this.crypto.decryptText(patient.surnames_cipher, `patient:${patient.patient_id}:surnames`)}`,
      mrn: this.crypto.decryptText(patient.medical_record_cipher, `patient:${patient.patient_id}:mrn`),
      dni: this.crypto.decryptText(patient.dni_cipher, `patient:${patient.patient_id}:dni`),
      birthDate: this.crypto.decryptText(patient.birth_date_cipher, `patient:${patient.patient_id}:birth`),
      sex: patient.sex_cipher ? this.crypto.decryptText(patient.sex_cipher, `patient:${patient.patient_id}:sex`) : null,
      clinician: user.displayName, studies, history, recommendation, note,
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
      const document = new PDFDocument({
        size: 'A4',
        margin: 38,
        bufferPages: true,
        info: { Title: context.reportType === 'LONGITUDINAL' ? 'Reporte longitudinal OA' : 'Reporte de episodio OA' },
      });
      const chunks: Buffer[] = [];
      const pageWidth = 595;
      const contentX = 38;
      const contentWidth = 519;
      const reportTitle = context.reportType === 'LONGITUDINAL' ? 'Reporte longitudinal' : 'Reporte del episodio';
      const sideLabel = (value: string) => value === 'L' ? 'Izquierda' : 'Derecha';
      const sourceLabel = (value: string) => {
        const labels: Record<string, string> = {
          DICOM_BILATERAL: 'DICOM bilateral',
          RASTER_BILATERAL: 'Imagen bilateral',
          RASTER_SINGLE_ROI: 'Imagen de una rodilla',
        };
        return labels[value] ?? value;
      };
      const isoDate = (value: unknown) => {
        if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
        const source = String(value ?? '');
        const match = source.match(/\d{4}-\d{2}-\d{2}/);
        if (match) return match[0];
        const parsed = new Date(source);
        return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
      };
      const dateLabel = (value: unknown) => {
        const iso = isoDate(value);
        if (!iso) return 'Fecha no disponible';
        return new Intl.DateTimeFormat('es-PE', {
          day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
        }).format(new Date(`${iso}T12:00:00Z`));
      };
      const valueOrDash = (value: unknown) => value == null || value === '' ? '—' : String(value);
      const percentLabel = (value: unknown) => value == null ? '—' : `${(Number(value) * 100).toFixed(1)} %`;
      const field = (label: string, value: unknown, x: number, y: number, width: number) => {
        document.fillColor('#71817d').font('Helvetica').fontSize(6.4)
          .text(label.toUpperCase(), x, y, { width, lineBreak: false, ellipsis: true });
        document.fillColor('#17312d').font('Helvetica-Bold').fontSize(8.7)
          .text(valueOrDash(value), x, y + 10, { width, lineBreak: false, ellipsis: true });
      };
      const card = (x: number, y: number, width: number, height: number, fill = '#f7faf9', stroke = '#dde7e3') => {
        document.roundedRect(x, y, width, height, 8).fillAndStroke(fill, stroke);
      };

      document.on('data', (chunk) => chunks.push(chunk));
      document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));

      context.studies.forEach((study: any, index: number) => {
        if (index > 0) document.addPage();
        const studyNumber = index + 1;
        const totalStudies = context.studies.length;
        const ensemble = study.predictions.find((item: any) => item.model_name === 'Ensemble-v2');
        const values = ensemble?.probabilities ?? {};

        document.rect(0, 0, pageWidth, 94).fill('#123f38');
        document.fillColor('#e7ba64').font('Helvetica-Bold').fontSize(9)
          .text(String(context.organization.name ?? 'Clínica OA').toUpperCase(), contentX, 25, { width: 340 });
        document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(21)
          .text(reportTitle, contentX, 43, { width: 350 });
        document.font('Helvetica').fontSize(8.3).fillColor('#c7d9d4')
          .text(context.reportType === 'LONGITUDINAL'
            ? 'Comparación cronológica de estudios radiográficos'
            : 'Resultados radiográficos del episodio clínico', contentX, 70, { width: 360 });
        document.roundedRect(432, 24, 125, 27, 7).fill('#e9bd68');
        document.fillColor('#17312d').font('Helvetica-Bold').fontSize(8)
          .text(`ESTUDIO ${studyNumber} DE ${totalStudies}`, 443, 34, { width: 103, align: 'center', lineBreak: false });
        document.fillColor('#c7d9d4').font('Helvetica').fontSize(7.5)
          .text(context.reportType === 'LONGITUDINAL' ? 'REPORTE LONGITUDINAL' : 'REPORTE DE EPISODIO', 420, 66, { width: 137, align: 'right' });

        card(contentX, 108, contentWidth, 76, '#ffffff', '#dfe8e5');
        field('Paciente', context.patientName, 50, 119, 165);
        field('Historia clínica', context.mrn, 227, 119, 72);
        field('DNI', context.dni, 311, 119, 65);
        field('Nacimiento', dateLabel(context.birthDate), 388, 119, 92);
        field('Sexo', context.sex === 'female' ? 'Femenino' : context.sex === 'male' ? 'Masculino' : 'No registrado', 492, 119, 53);
        field('Médico responsable', context.clinician, 50, 151, 285);
        field('Antecedentes registrados', context.history.length, 350, 151, 195);

        document.fillColor('#a06f21').font('Helvetica-Bold').fontSize(7)
          .text('ESTUDIO RADIOGRÁFICO', contentX, 199, { width: 180 });
        document.fillColor('#17312d').font('Helvetica-Bold').fontSize(11.5)
          .text(dateLabel(study.exam_date), contentX, 211, { width: 280 });
        document.roundedRect(449, 197, 108, 25, 7).fill('#e8f2ef');
        document.fillColor('#17695e').font('Helvetica-Bold').fontSize(7.7)
          .text(`RODILLA ${sideLabel(study.knee_side).toUpperCase()}`, 458, 206, { width: 90, align: 'center', lineBreak: false });

        card(contentX, 232, contentWidth, 178, '#f6f9f8', '#dfe7e4');
        document.roundedRect(50, 244, 206, 154, 6).fill('#14221f');
        if (study.preview) {
          try { document.image(study.preview, 50, 244, { fit: [206, 154], align: 'center', valign: 'center' }); }
          catch { document.fillColor('#c8d7d3').font('Helvetica').fontSize(8).text('Vista radiográfica no disponible', 65, 317, { width: 176, align: 'center' }); }
        } else {
          document.fillColor('#c8d7d3').font('Helvetica').fontSize(8)
            .text('Vista radiográfica no disponible', 65, 317, { width: 176, align: 'center' });
        }
        document.fillColor('#71817d').font('Helvetica').fontSize(6.7)
          .text(`FORMATO · ${sourceLabel(study.source_type)}`, 274, 246, { width: 265, lineBreak: false, ellipsis: true });
        if (ensemble) {
          document.roundedRect(274, 268, 91, 104, 8).fill('#123f38');
          document.fillColor('#c8dbd5').font('Helvetica').fontSize(7)
            .text('KL ESTIMADO', 284, 280, { width: 71, align: 'center' });
          document.fillColor('#ebc370').font('Helvetica-Bold').fontSize(41)
            .text(valueOrDash(values.predictedKl), 284, 294, { width: 71, align: 'center', lineBreak: false });
          document.fillColor('#d5e3df').font('Helvetica').fontSize(6.8)
            .text(`${percentLabel(values.confidence)} confianza`, 280, 348, { width: 79, align: 'center', lineBreak: false });
          let barY = 270;
          for (let grade = 0; grade <= 4; grade += 1) {
            const probability = Math.max(0, Math.min(1, Number(values.ensemble?.[`KL${grade}`] ?? 0)));
            document.fillColor('#52645f').font('Helvetica-Bold').fontSize(7).text(`KL${grade}`, 383, barY + 2, { width: 23 });
            document.roundedRect(408, barY + 2, 91, 7, 3).fill('#dde6e3');
            if (probability > 0) document.roundedRect(408, barY + 2, 91 * probability, 7, 3).fill('#d4a34a');
            document.fillColor('#52645f').font('Helvetica').fontSize(6.7)
              .text(percentLabel(probability), 504, barY + 1, { width: 38, align: 'right', lineBreak: false });
            barY += 19;
          }
          field('KL validado por el médico', ensemble.confirmed_kl ?? 'Pendiente', 383, 373, 159);
        } else {
          document.fillColor('#835b2b').font('Helvetica-Bold').fontSize(9)
            .text('Clasificación KL aún no disponible', 285, 302, { width: 245, align: 'center' });
        }

        card(contentX, 422, contentWidth, 72, '#f8faf9', '#e1e9e6');
        document.fillColor('#17695e').font('Helvetica-Bold').fontSize(7.2)
          .text('CONTEXTO CLÍNICO', 50, 432, { width: 150 });
        const clinical = study.clinical;
        const clinicalFields = clinical ? [
          ['Dolor', clinical.pain_score == null ? 'No disponible' : `${clinical.pain_score}/10`],
          ['Obesidad', clinical.obesity ? 'Sí' : 'No'],
          ['Diabetes', clinical.diabetes ? 'Sí' : 'No'],
          ['Hipertensión', clinical.hypertension ? 'Sí' : 'No'],
          ['Nicotina', clinical.nicotine_use ? 'Sí' : 'No'],
          ['Trauma M. inferior', clinical.trauma_lower_extremity ? 'Sí' : 'No'],
        ] : [['Datos clínicos', 'No disponibles']];
        clinicalFields.forEach(([label, value], fieldIndex) => {
          const column = fieldIndex % 3;
          const row = Math.floor(fieldIndex / 3);
          field(label, value, 50 + column * 169, 449 + row * 22, 153);
        });

        const riskModels = [
          { model: 'XGBoost-v2', title: 'Artroplastia', horizon: 'Horizonte · 24 meses' },
          { model: 'LSTM-v2', title: 'Progresión radiográfica', horizon: 'Horizonte · 3–12 meses' },
        ];
        riskModels.forEach((risk, riskIndex) => {
          const prediction = study.predictions.find((item: any) => item.model_name.startsWith(risk.model.split('-')[0]));
          const x = contentX + riskIndex * 263;
          const probability = prediction?.probabilities?.probability;
          const positive = Boolean(prediction?.screen_positive);
          card(x, 506, 256, 62, prediction ? (positive ? '#fff7e8' : '#eef7f3') : '#f7f9f8', prediction ? (positive ? '#ecd6a8' : '#d7e8e1') : '#e2e8e6');
          document.fillColor('#17312d').font('Helvetica-Bold').fontSize(9).text(risk.title, x + 12, 518, { width: 150, lineBreak: false });
          document.fillColor('#71817d').font('Helvetica').fontSize(6.8).text(risk.horizon, x + 12, 533, { width: 150, lineBreak: false });
          document.fillColor(positive ? '#966019' : '#17695e').font('Helvetica-Bold').fontSize(15)
            .text(percentLabel(probability), x + 166, 516, { width: 76, align: 'right', lineBreak: false });
          document.fillColor('#71817d').font('Helvetica').fontSize(6.5)
            .text(prediction ? (positive ? 'Tamiz positivo' : 'Tamiz negativo') : 'No disponible', x + 150, 539, { width: 92, align: 'right', lineBreak: false });
        });

        document.fillColor('#a06f21').font('Helvetica-Bold').fontSize(7)
          .text('MAPAS DE EXPLICACIÓN GRAD-CAM', contentX, 586, { width: 230 });
        const gradcams = study.gradcams.slice(0, 2);
        [0, 1].forEach((camIndex) => {
          const cam = gradcams[camIndex];
          const x = contentX + camIndex * 263;
          card(x, 601, 256, 151, '#f7faf9', '#dfe8e5');
          document.roundedRect(x + 8, 609, 240, 119, 5).fill('#14221f');
          if (cam) {
            try { document.image(cam.image, x + 8, 609, { fit: [240, 119], align: 'center', valign: 'center' }); }
            catch { document.fillColor('#c8d7d3').font('Helvetica').fontSize(7.5).text('Mapa no disponible', x + 20, 665, { width: 216, align: 'center' }); }
            document.fillColor('#5f716c').font('Helvetica').fontSize(7)
              .text(`${cam.backbone} · objetivo KL${cam.target_kl}`, x + 10, 736, { width: 236, align: 'center', lineBreak: false, ellipsis: true });
          } else {
            document.fillColor('#c8d7d3').font('Helvetica').fontSize(7.5)
              .text('Mapa no disponible', x + 20, 665, { width: 216, align: 'center' });
          }
        });
      });

      document.addPage();
      const recommendation = context.recommendation?.content ?? {};
      const isGeneral = context.recommendation?.scope === 'PATIENT';
      document.rect(0, 0, pageWidth, 94).fill('#123f38');
      document.fillColor('#e7ba64').font('Helvetica-Bold').fontSize(9)
        .text(String(context.organization.name ?? 'Clínica OA').toUpperCase(), contentX, 25, { width: 340 });
      document.fillColor('#ffffff').font('Helvetica-Bold').fontSize(21)
        .text(isGeneral ? 'Interpretación longitudinal' : 'Interpretación del análisis', contentX, 43, { width: 370 });
      document.fillColor('#c7d9d4').font('Helvetica').fontSize(8.3)
        .text(
          isGeneral ? 'Síntesis integral de la evolución radiográfica' : 'Síntesis clínica del estudio radiográfico',
          contentX, 70, { width: 370 },
        );
      document.roundedRect(432, 24, 125, 27, 7).fill('#e9bd68');
      document.fillColor('#17312d').font('Helvetica-Bold').fontSize(8)
        .text(isGeneral ? 'VISIÓN GENERAL' : 'ESTUDIO ACTUAL', 443, 34, { width: 103, align: 'center', lineBreak: false });

      card(contentX, 108, contentWidth, 76, '#ffffff', '#dfe8e5');
      field('Paciente', context.patientName, 50, 119, 190);
      field('Historia clínica', context.mrn, 252, 119, 95);
      field('DNI', context.dni, 359, 119, 75);
      field('Médico responsable', context.clinician, 446, 119, 99);
      const priorityLabels: Record<string, string> = {
        routine: 'Seguimiento habitual', soon: 'Revisión próxima', prompt: 'Revisión prioritaria',
      };
      field(
        'Tipo de interpretación',
        `${isGeneral ? 'Longitudinal' : 'Por episodio'} · ${isGeneral ? context.studies.length : 1} estudio(s)`,
        50, 151, 250,
      );
      field('Prioridad orientativa', priorityLabels[recommendation.priority] ?? 'Seguimiento habitual', 312, 151, 110);
      field('Generado', dateLabel(new Date()), 434, 151, 111);

      let narrativeY = 204;
      const narrativeCard = (
        label: string, text: string, y: number, options: { headline?: string; fill?: string; stroke?: string } = {},
      ) => {
        const x = contentX;
        const innerWidth = contentWidth - 24;
        document.font('Helvetica').fontSize(8.5);
        const headlineHeight = options.headline
          ? document.font('Helvetica-Bold').fontSize(12).heightOfString(options.headline, { width: innerWidth }) + 8
          : 0;
        const bodyHeight = document.font('Helvetica').fontSize(8.5).heightOfString(text, { width: innerWidth, lineGap: 2 });
        const height = Math.max(78, 34 + headlineHeight + bodyHeight);
        card(x, y, contentWidth, height, options.fill ?? '#f7faf9', options.stroke ?? '#dfe8e5');
        document.fillColor('#a06f21').font('Helvetica-Bold').fontSize(7)
          .text(label, x + 12, y + 12, { width: innerWidth, lineBreak: false });
        let textY = y + 29;
        if (options.headline) {
          document.fillColor('#17312d').font('Helvetica-Bold').fontSize(12)
            .text(options.headline, x + 12, textY, { width: innerWidth });
          textY += headlineHeight;
        }
        document.fillColor('#405550').font('Helvetica').fontSize(8.5)
          .text(text, x + 12, textY, { width: innerWidth, lineGap: 2 });
        return y + height + 14;
      };

      narrativeY = narrativeCard(
        'INTERPRETACIÓN CLÍNICA ASISTIDA',
        recommendation.summary,
        narrativeY,
        { headline: recommendation.headline, fill: '#f4f9f7', stroke: '#d6e6e1' },
      );
      narrativeY = narrativeCard(
        'RECOMENDACIÓN CON IA',
        recommendation.recommendation,
        narrativeY,
        { fill: '#fffaf0', stroke: '#eadbbd' },
      );
      if (context.note?.content) {
        narrativeCard(
          isGeneral ? 'NOTA CLÍNICA GENERAL DEL MÉDICO' : 'NOTA CLÍNICA DEL ANÁLISIS',
          context.note.content,
          narrativeY,
          { fill: '#f8f9fb', stroke: '#dfe3e8' },
        );
      }

      const pages = document.bufferedPageRange();
      for (let index = pages.start; index < pages.start + pages.count; index += 1) {
        document.switchToPage(index);
        document.moveTo(contentX, 778).lineTo(557, 778).strokeColor('#dde6e3').lineWidth(.6).stroke();
        document.fillColor('#71817d').font('Helvetica').fontSize(6.8)
          .text(`${reportTitle} · Generado ${dateLabel(new Date())}`, contentX, 789, { width: 350, lineBreak: false });
        document.fillColor('#52645f').font('Helvetica-Bold').fontSize(7)
          .text(`Página ${index + 1} de ${pages.count}`, 457, 789, { width: 100, align: 'right', lineBreak: false });
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
  async allReports(
    @Query('page') pageValue: string | undefined,
    @Query('search') searchValue: string | undefined,
    @Query('dateFrom') dateFromValue: string | undefined,
    @Query('dateTo') dateToValue: string | undefined,
    @Query('reportType') reportTypeValue: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    const page = pageNumber(pageValue);
    const search = optionalText(searchValue, 'Búsqueda', 100)?.toLocaleLowerCase('es') ?? '';
    const dateFrom = dateFromValue ? isoDate(dateFromValue, 'Fecha desde') : null;
    const dateTo = dateToValue ? isoDate(dateToValue, 'Fecha hasta') : null;
    if (dateFrom && dateTo && dateFrom > dateTo) throw new BadRequestException('La fecha desde no puede ser posterior a la fecha hasta');
    const reportType = reportTypeValue && reportTypeValue !== 'ALL' ? optionalText(reportTypeValue, 'Tipo de reporte', 20) : null;
    if (reportType && !['EPISODE', 'LONGITUDINAL'].includes(reportType)) throw new BadRequestException('Tipo de reporte inválido');
    const rows = (await this.db.query<any>(
      `SELECT r.id,r.report_type "reportType",r.status,r.generated_at "generatedAt",e.opened_at "episodeDate",e.id "episodeId",p.id "patientId",
       p.names_cipher,p.surnames_cipher,p.medical_record_cipher FROM draft_reports r JOIN clinical_episodes e ON e.id=r.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1 ORDER BY e.opened_at DESC,r.generated_at DESC`, [user.id],
    )).rows.map((row) => ({ id: row.id, reportType: row.reportType, status: row.status, generatedAt: row.generatedAt,
      episodeDate: row.episodeDate, episodeId: row.episodeId, patientId: row.patientId,
      patientName: `${this.crypto.decryptText(row.names_cipher, `patient:${row.patientId}:names`)} ${this.crypto.decryptText(row.surnames_cipher, `patient:${row.patientId}:surnames`)}`,
      medicalRecordNumber: this.crypto.decryptText(row.medical_record_cipher, `patient:${row.patientId}:mrn`) }));
    const filtered = rows.filter((row) => {
      const date = String(row.episodeDate).slice(0, 10);
      return (!search || [row.patientName, row.medicalRecordNumber, row.reportType].some((value) => String(value).toLocaleLowerCase('es').includes(search)))
        && (!dateFrom || date >= dateFrom) && (!dateTo || date <= dateTo) && (!reportType || row.reportType === reportType);
    });
    return paged(filtered, page);
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
