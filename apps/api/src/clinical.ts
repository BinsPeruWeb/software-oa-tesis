import { BadRequestException, Body, Controller, Get, Param, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import PDFDocument from 'pdfkit';
import { createHash } from 'node:crypto';
import { AuthUser, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';
import { boundedNumber, isoDate, uuid } from './validation';

type Flags = { obesity: boolean; diabetes: boolean; hypertension: boolean; nicotineUse: boolean; traumaLowerExtremity: boolean };
type ContextRow = {
  observation_id: string; patient_id: string; episode_id: string; exam_date: string; knee_side: 'L' | 'R';
  confirmed_kl: number; pain_score: number | null; obesity: boolean; diabetes: boolean; hypertension: boolean;
  nicotine_use: boolean; trauma_lower_extremity: boolean; birth_date_cipher: Buffer; sex_cipher: Buffer | null;
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
@UseGuards(SessionGuard, CsrfGuard)
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

  @Post('observations/:id/clinical')
  async clinical(@Param('id') observationId: string, @Body() body: any, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
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

  private async currentContext(observationId: string): Promise<ContextRow> {
    const result = await this.db.query<ContextRow>(
      `SELECT k.id observation_id,e.patient_id,e.id episode_id,s.exam_date,k.knee_side,r.confirmed_kl,c.pain_score,
       c.obesity,c.diabetes,c.hypertension,c.nicotine_use,c.trauma_lower_extremity,p.birth_date_cipher,p.sex_cipher
       FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       JOIN LATERAL (SELECT confirmed_kl,decision FROM clinician_reviews r JOIN model_predictions mp ON mp.id=r.prediction_id
         WHERE mp.observation_id=k.id ORDER BY reviewed_at DESC LIMIT 1) r ON r.decision<>'REJECTED'
       JOIN clinical_observations c ON c.knee_observation_id=k.id WHERE k.id=$1`, [observationId],
    );
    if (!result.rows[0]) throw new BadRequestException('Se requiere revisión KL aceptada y datos clínicos completos');
    return result.rows[0];
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
    const current = await this.currentContext(observationId);
    const birth = this.crypto.decryptText(current.birth_date_cipher, `patient:${current.patient_id}:birth`);
    const sex = current.sex_cipher ? this.crypto.decryptText(current.sex_cipher, `patient:${current.patient_id}:sex`) : null;
    const history = await this.db.query<{ exam_date: string; confirmed_kl: number; knee_side: 'L' | 'R' }>(
      `SELECT exam_date,confirmed_kl,knee_side FROM prior_exams WHERE patient_id=$1 AND knee_side=$2 ORDER BY exam_date`,
      [current.patient_id, current.knee_side],
    );
    const payload = {
      date_of_birth: birth, exam_date: current.exam_date, current_kl: current.confirmed_kl,
      pain_score: current.pain_score === null ? null : Number(current.pain_score), sex, knee_side: current.knee_side,
      ...this.semanticFlags(current),
      prior_exams: history.rows.map((item) => ({ date: item.exam_date, KLG: item.confirmed_kl, knee_side: item.knee_side })),
    };
    const { result, latencyMs } = await this.mlRisk('/v1/risks/arthroplasty', payload);
    const id = await this.persistRisk(current, user, result, latencyMs, payload, 'XGBoost-v2');
    await this.audit.record(user.id, 'ARTHROPLASTY_RISK_COMPUTED', 'ModelPrediction', id);
    return { id, ...result, warning: 'Resultado experimental. No constituye indicación quirúrgica.' };
  }

  @Post('observations/:id/risks/progression')
  async progression(@Param('id') observationId: string, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    const current = await this.currentContext(observationId);
    if (current.confirmed_kl === 4) return { available: false, reason: 'LSTM no disponible para t2 KL4' };
    const prior = (await this.db.query<any>(
      `SELECT * FROM prior_exams WHERE patient_id=$1 AND knee_side=$2 AND exam_date<$3 ORDER BY exam_date DESC LIMIT 1`,
      [current.patient_id, current.knee_side, current.exam_date],
    )).rows[0];
    if (!prior) return { available: false, reason: 'Predicción no disponible: se requieren dos observaciones confirmadas' };
    const birth = this.crypto.decryptText(current.birth_date_cipher, `patient:${current.patient_id}:birth`);
    const payload = {
      patient_reference: this.crypto.blindIndex(current.patient_id),
      observations: [
        { date: prior.exam_date, KLG: prior.confirmed_kl, age_at_exam: yearsAt(birth, prior.exam_date),
          pain_score: prior.pain_score === null ? null : Number(prior.pain_score), knee_side: prior.knee_side, ...this.semanticFlags(prior) },
        { date: current.exam_date, KLG: current.confirmed_kl, age_at_exam: yearsAt(birth, current.exam_date),
          pain_score: current.pain_score === null ? null : Number(current.pain_score), knee_side: current.knee_side, ...this.semanticFlags(current) },
      ],
    };
    const { result, latencyMs } = await this.mlRisk('/v1/risks/progression', payload);
    const id = await this.persistRisk(current, user, result, latencyMs, payload, 'LSTM-v2');
    await this.audit.record(user.id, 'PROGRESSION_RISK_COMPUTED', 'ModelPrediction', id);
    return { available: true, id, ...result, warning: 'Resultado experimental; requiere interpretación médica.' };
  }

  private async persistRisk(current: ContextRow, user: AuthUser, result: any, latencyMs: number, payload: unknown, model: string) {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO model_predictions(observation_id,model_name,model_version,artifact_hashes,input_hash,input_source,
       knee_side,probabilities,threshold,screen_positive,kl_origin,latency_ms,device,correlation_id,created_by)
       VALUES($1,$2,$3,$4,$5,'STRUCTURED',$6,$7,$8,$9,'CLINICIAN',$10,'cpu-service',gen_random_uuid(),$11) RETURNING id`,
      [current.observation_id, model, result.model_version, JSON.stringify({ model: result.model_hash }), hash,
        current.knee_side, JSON.stringify({ probability: result.probability, target: result.target, horizon: result.horizon,
          features: result.features ?? null }), result.threshold, result.screen_positive, latencyMs, user.id],
    );
    return inserted.rows[0].id;
  }

  @Post('episodes/:episodeId/reports')
  async report(@Param('episodeId') episodeId: string, @CurrentUser() user: AuthUser) {
    episodeId = uuid(episodeId, 'Episodio');
    const row = (await this.db.query<any>(
      `SELECT e.patient_id,p.names_cipher,p.surnames_cipher,p.medical_record_cipher FROM clinical_episodes e
       JOIN patients p ON p.id=e.patient_id WHERE e.id=$1`, [episodeId],
    )).rows[0];
    if (!row) throw new BadRequestException('Episodio no encontrado');
    const predictions = (await this.db.query<any>(
      `SELECT mp.model_name,mp.model_version,mp.probabilities,mp.threshold,mp.created_at,k.knee_side
       FROM model_predictions mp JOIN knee_observations k ON k.id=mp.observation_id
       JOIN radiographic_studies s ON s.id=k.study_id WHERE s.episode_id=$1 ORDER BY mp.created_at`, [episodeId],
    )).rows;
    const patientName = `${this.crypto.decryptText(row.names_cipher, `patient:${row.patient_id}:names`)} ${this.crypto.decryptText(row.surnames_cipher, `patient:${row.patient_id}:surnames`)}`;
    const mrn = this.crypto.decryptText(row.medical_record_cipher, `patient:${row.patient_id}:mrn`);
    const pdf = await this.makePdf(patientName, mrn, predictions, user.displayName);
    const stored = await this.assets.write(pdf);
    const asset = await this.db.query<{ id: string }>(
      `INSERT INTO stored_assets(patient_id,kind,storage_key,content_type,plaintext_sha256,size_bytes,created_by)
       VALUES($1,'REPORT',$2,'application/pdf',$3,$4,$5) RETURNING id`,
      [row.patient_id, stored.storageKey, createHash('sha256').update(pdf).digest('hex'), pdf.length, user.id],
    );
    const report = await this.db.query<{ id: string }>(
      `INSERT INTO draft_reports(episode_id,asset_id,generated_by) VALUES($1,$2,$3) RETURNING id`,
      [episodeId, asset.rows[0].id, user.id],
    );
    await this.audit.record(user.id, 'DRAFT_REPORT_GENERATED', 'DraftReport', report.rows[0].id);
    return { id: report.rows[0].id, status: 'DRAFT' };
  }

  private makePdf(patient: string, mrn: string, predictions: any[], clinician: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const document = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Reporte borrador OA' } });
      const chunks: Buffer[] = [];
      document.on('data', (chunk) => chunks.push(chunk)); document.on('error', reject);
      document.on('end', () => resolve(Buffer.concat(chunks)));
      document.fontSize(18).text('Reporte borrador — evaluación experimental OA');
      document.moveDown().fontSize(11).text(`Paciente: ${patient}`).text(`Historia clínica: ${mrn}`).text(`Generado por: ${clinician}`);
      document.moveDown().fontSize(13).text('Resultados');
      for (const item of predictions) {
        document.fontSize(10).text(`${item.model_name} (${item.model_version}) — Rodilla ${item.knee_side}`);
        document.fontSize(8).text(JSON.stringify(item.probabilities));
      }
      document.moveDown().fontSize(10).fillColor('red').text('BORRADOR. Uso experimental. Requiere revisión médica. No es una indicación automática de cirugía.');
      document.end();
    });
  }

  @Get('reports/:id/download')
  async download(@Param('id') id: string, @CurrentUser() user: AuthUser, @Res() response: Response) {
    id = uuid(id, 'Reporte');
    const row = (await this.db.query<{ storage_key: string }>(
      `SELECT a.storage_key FROM draft_reports r JOIN stored_assets a ON a.id=r.asset_id WHERE r.id=$1`, [id],
    )).rows[0];
    if (!row) throw new BadRequestException('Reporte no encontrado');
    const pdf = await this.assets.read(row.storage_key);
    await this.audit.record(user.id, 'DRAFT_REPORT_DOWNLOADED', 'DraftReport', id);
    response.set({ 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="oa-report-${id}.pdf"`, 'cache-control': 'no-store' });
    response.send(pdf);
  }
}
