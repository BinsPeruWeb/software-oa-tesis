import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, OnModuleDestroy, OnModuleInit,
  Param, Post, Query, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { AuthUser, ClinicianGuard, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';
import { PAGE_SIZE, pageNumber } from './pagination';
import { boundedNumber, isoDate, optionalText, text, uuid } from './validation';

const SOURCE_TYPES = ['DICOM_BILATERAL', 'RASTER_BILATERAL', 'RASTER_SINGLE_ROI'] as const;
const asBool = (value: unknown, name: string) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${name} debe confirmarse explícitamente`);
};

type StudyJobRow = {
  job_id: string; observation_id: string; correlation_id: string; knee_side: 'L' | 'R';
  source_type: typeof SOURCE_TYPES[number]; projection_confirmed: boolean; weight_bearing_confirmed: boolean;
  orientation_confirmed: boolean; metadata_inverted: boolean; horizontal_flip: boolean;
  storage_key: string; content_type: string; patient_id: string; created_by: string; job_type: 'KL' | 'GRADCAM'; attempts: number;
};

type MlPreflight = {
  input_hash: string; file_kind: 'DICOM' | 'RASTER'; media_type: string; exam_date: string | null;
  preview_base64_png: string; review_status: 'ACCEPTED' | 'REJECTED' | 'REVIEW_REQUIRED' | 'UNAVAILABLE';
  suggested_layout: 'bilateral' | 'single' | 'uncertain'; suggested_source_type: string | null;
  supported: boolean; assessment: Record<string, unknown> | null; provider_model: string;
  provider_request_id: string | null; cost_usd: number | null;
  external_preview_metadata_stripped: boolean; external_preview_borders_masked: boolean;
};
type PreflightRow = {
  id: string; input_hash: string; file_kind: 'DICOM' | 'RASTER'; media_type: string;
  review_status: MlPreflight['review_status']; suggested_layout: MlPreflight['suggested_layout']; supported: boolean;
};

@Injectable()
export class InferenceWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InferenceWorker.name);
  private timer?: NodeJS.Timeout;
  private working = false;
  constructor(private readonly db: DatabaseService, private readonly assets: AssetService, private readonly crypto: CryptoService) {}

  async onModuleInit() {
    await this.db.query(`UPDATE inference_jobs SET status='QUEUED',started_at=NULL WHERE status='RUNNING'`);
    this.timer = setInterval(() => void this.tick(), 750);
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); }

  private async claim(): Promise<StudyJobRow | null> {
    return this.db.transaction(async (client) => {
      const selected = await client.query<StudyJobRow>(
        `SELECT j.id job_id,j.observation_id,j.correlation_id,j.created_by,j.job_type,j.attempts,k.knee_side,
          s.source_type,s.projection_confirmed,s.weight_bearing_confirmed,s.orientation_confirmed,
          s.metadata_inverted,s.horizontal_flip,a.storage_key,a.content_type,e.patient_id
         FROM inference_jobs j JOIN knee_observations k ON k.id=j.observation_id
         JOIN radiographic_studies s ON s.id=k.study_id JOIN stored_assets a ON a.id=s.asset_id
         JOIN clinical_episodes e ON e.id=s.episode_id
         WHERE j.status='QUEUED' ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1`,
      );
      const job = selected.rows[0];
      if (!job) return null;
      await client.query(`UPDATE inference_jobs SET status='RUNNING',started_at=now(),attempts=attempts+1,error_code=NULL WHERE id=$1`, [job.job_id]);
      return job;
    });
  }

  private async mlPost(path: string, body: FormData) {
    const response = await fetch(`${process.env.ML_SERVICE_URL}${path}`, {
      method: 'POST', body, signal: AbortSignal.timeout(180_000),
      headers: { 'x-service-token': process.env.SERVICE_TOKEN ?? '', 'x-correlation-id': randomUUID() },
    });
    if (!response.ok) throw new Error(`ML_${response.status}`);
    return response.json() as Promise<any>;
  }

  private imageForm(job: StudyJobRow, plaintext: Buffer) {
    const form = new FormData();
    const bytes = plaintext.buffer.slice(plaintext.byteOffset, plaintext.byteOffset + plaintext.byteLength) as ArrayBuffer;
    form.append('image', new Blob([bytes], { type: job.content_type }), 'clinical-image');
    form.append('source_type', job.source_type); form.append('knee_side', job.knee_side);
    form.append('projection_confirmed', String(job.projection_confirmed));
    form.append('weight_bearing_confirmed', String(job.weight_bearing_confirmed));
    form.append('orientation_confirmed', String(job.orientation_confirmed));
    form.append('metadata_inverted', String(job.metadata_inverted));
    form.append('horizontal_flip', String(job.horizontal_flip));
    return form;
  }

  private async runKl(job: StudyJobRow, plaintext: Buffer) {
    const result = await this.mlPost('/v1/kl/predict', this.imageForm(job, plaintext));
    const prediction = await this.db.query<{ id: string }>(
      `INSERT INTO model_predictions(job_id,observation_id,model_name,model_version,artifact_hashes,input_hash,
       input_source,knee_side,probabilities,kl_origin,latency_ms,device,correlation_id,created_by)
       VALUES($1,$2,'Ensemble-v2',$3,$4,$5,$6,$7,$8,'MODEL',$9,$10,$11,$12)
       ON CONFLICT(job_id) DO UPDATE SET job_id=EXCLUDED.job_id RETURNING id`,
      [job.job_id, job.observation_id, result.model_version, JSON.stringify(result.model_hashes), result.input_hash,
        job.source_type, job.knee_side, JSON.stringify({ predictedKl: result.predicted_kl, confidence: result.confidence,
          ensemble: result.probabilities, members: result.member_probabilities, pipeline: result.pipeline }),
        result.duration_ms, result.device, job.correlation_id, job.created_by],
    );
    await this.db.query(
      `INSERT INTO inference_jobs(observation_id,job_type,idempotency_key,created_by,correlation_id)
       VALUES($1,'GRADCAM',$2,$3,$4) ON CONFLICT(idempotency_key) DO NOTHING`,
      [job.observation_id, `gradcam:${prediction.rows[0].id}`, job.created_by, job.correlation_id],
    );
  }

  private async runGradcam(job: StudyJobRow, plaintext: Buffer) {
    const prediction = (await this.db.query<{ id: string; probabilities: any }>(
      `SELECT id,probabilities FROM model_predictions WHERE observation_id=$1 AND model_name='Ensemble-v2' ORDER BY created_at DESC LIMIT 1`,
      [job.observation_id],
    )).rows[0];
    if (!prediction) throw new Error('PREDICTION_NOT_FOUND');
    const form = this.imageForm(job, plaintext);
    form.append('target_kl', String(prediction.probabilities.predictedKl));
    const result = await this.mlPost('/v1/kl/explanations', form);
    for (const [backbone, encoded] of Object.entries<string>(result.overlays_base64_png)) {
      const exists = await this.db.query(
        'SELECT id FROM gradcam_explanations WHERE prediction_id=$1 AND backbone=$2', [prediction.id, backbone],
      );
      if (exists.rowCount) continue;
      const image = Buffer.from(encoded, 'base64');
      const stored = await this.assets.write(image);
      const asset = await this.db.query<{ id: string }>(
        `INSERT INTO stored_assets(patient_id,kind,storage_key,content_type,plaintext_sha256,size_bytes,created_by)
         VALUES($1,'GRADCAM',$2,'image/png',$3,$4,$5) RETURNING id`,
        [job.patient_id, stored.storageKey, createHash('sha256').update(image).digest('hex'), image.length, job.created_by],
      );
      await this.db.query(
        `INSERT INTO gradcam_explanations(prediction_id,backbone,asset_id,target_kl) VALUES($1,$2,$3,$4)`,
        [prediction.id, backbone, asset.rows[0].id, result.target_kl],
      );
    }
  }

  private async tick() {
    if (this.working) return;
    this.working = true;
    let job: StudyJobRow | null = null;
    try {
      job = await this.claim();
      if (!job) return;
      const plaintext = await this.assets.read(job.storage_key);
      if (job.job_type === 'KL') await this.runKl(job, plaintext); else await this.runGradcam(job, plaintext);
      await this.db.query(`UPDATE inference_jobs SET status='SUCCEEDED',finished_at=now() WHERE id=$1`, [job.job_id]);
    } catch (error: any) {
      if (job) {
        const retry = job.attempts + 1 < 3;
        await this.db.query(
          `UPDATE inference_jobs SET status=$2,finished_at=CASE WHEN $2='FAILED' THEN now() ELSE NULL END,
           started_at=NULL,error_code=$3 WHERE id=$1`,
          [job.job_id, retry ? 'QUEUED' : 'FAILED', String(error?.message ?? 'INFERENCE_FAILED').slice(0, 80)],
        );
      }
      this.logger.error(`Trabajo de inferencia fallido: ${job?.job_id ?? 'claim'}`);
    } finally { this.working = false; }
  }
}

@Controller('api')
@UseGuards(SessionGuard, CsrfGuard, ClinicianGuard)
export class StudiesController {
  private readonly preflightWindows = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly db: DatabaseService, private readonly assets: AssetService,
    private readonly crypto: CryptoService, private readonly audit: AuditService,
  ) {}

  @Get('studies')
  async studies(@Query('page') pageValue: string | undefined, @CurrentUser() user: AuthUser) {
    const page = pageNumber(pageValue); const total = Number((await this.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM radiographic_studies s JOIN clinical_episodes e ON e.id=s.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1`, [user.id],
    )).rows[0].count); const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const current = Math.min(page, pages);
    const rows = (await this.db.query<any>(
      `SELECT s.id,s.exam_date "examDate",s.source_type "sourceType",s.created_at "createdAt",e.id "episodeId",
       p.id "patientId",p.names_cipher,p.surnames_cipher,p.medical_record_cipher,
       string_agg(DISTINCT k.knee_side,'') "kneeSides",max(j.status) FILTER(WHERE j.job_type='KL') status
       FROM radiographic_studies s JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       JOIN knee_observations k ON k.study_id=s.id LEFT JOIN inference_jobs j ON j.observation_id=k.id
       WHERE p.owner_clinician_id=$1 GROUP BY s.id,e.id,p.id ORDER BY s.exam_date DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`, [user.id],
    )).rows.map((row) => ({ id: row.id, examDate: row.examDate, sourceType: row.sourceType, createdAt: row.createdAt,
      episodeId: row.episodeId, patientId: row.patientId, kneeSides: row.kneeSides, status: row.status ?? 'PENDING',
      patientName: `${this.crypto.decryptText(row.names_cipher, `patient:${row.patientId}:names`)} ${this.crypto.decryptText(row.surnames_cipher, `patient:${row.patientId}:surnames`)}`,
      medicalRecordNumber: this.crypto.decryptText(row.medical_record_cipher, `patient:${row.patientId}:mrn`) }));
    return { items: rows, page: current, pageSize: PAGE_SIZE, total, pages };
  }

  @Get('reviews')
  async reviews(@Query('page') pageValue: string | undefined, @CurrentUser() user: AuthUser) {
    const page = pageNumber(pageValue);
    const joins = `FROM model_predictions mp JOIN knee_observations k ON k.id=mp.observation_id JOIN radiographic_studies s ON s.id=k.study_id
      JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id`;
    const filter = `WHERE mp.model_name='Ensemble-v2' AND p.owner_clinician_id=$1`;
    const total = Number((await this.db.query<{ count: string }>(`SELECT count(*)::text count ${joins} ${filter}`, [user.id])).rows[0].count);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const current = Math.min(page, pages);
    const rows = (await this.db.query<any>(
      `SELECT mp.id,mp.created_at "createdAt",mp.probabilities,k.knee_side "kneeSide",s.exam_date "examDate",p.id "patientId",
       p.names_cipher,p.surnames_cipher,p.medical_record_cipher,cr.decision,cr.confirmed_kl "confirmedKl",cr.reviewed_at "reviewedAt" ${joins}
       LEFT JOIN LATERAL (SELECT * FROM clinician_reviews WHERE prediction_id=mp.id ORDER BY reviewed_at DESC LIMIT 1) cr ON true
       ${filter} ORDER BY mp.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(current - 1) * PAGE_SIZE}`, [user.id],
    )).rows.map((row) => ({ id: row.id, createdAt: row.createdAt, probabilities: row.probabilities, kneeSide: row.kneeSide,
      examDate: row.examDate, patientId: row.patientId, decision: row.decision, confirmedKl: row.confirmedKl, reviewedAt: row.reviewedAt,
      patientName: `${this.crypto.decryptText(row.names_cipher, `patient:${row.patientId}:names`)} ${this.crypto.decryptText(row.surnames_cipher, `patient:${row.patientId}:surnames`)}`,
      medicalRecordNumber: this.crypto.decryptText(row.medical_record_cipher, `patient:${row.patientId}:mrn`) }));
    return { items: rows, page: current, pageSize: PAGE_SIZE, total, pages };
  }

  @Post('studies/preflight')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 64 * 1024 * 1024, files: 1 } }))
  async preflight(
    @UploadedFile() image: { buffer: Buffer; mimetype: string; originalname: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!image?.buffer?.length) throw new BadRequestException('Seleccione una imagen');
    text(image.originalname, 'Nombre del archivo', 1, 255);
    const now = Date.now();
    const existing = this.preflightWindows.get(user.id);
    const window = !existing || existing.reset < now ? { count: 0, reset: now + 60_000 } : existing;
    window.count += 1; this.preflightWindows.set(user.id, window);
    if (window.count > 10) throw new BadRequestException('Demasiadas verificaciones de imagen; espere un minuto');
    const form = new FormData();
    const bytes = image.buffer.buffer.slice(image.buffer.byteOffset, image.buffer.byteOffset + image.buffer.byteLength) as ArrayBuffer;
    form.append('image', new Blob([bytes], { type: image.mimetype || 'application/octet-stream' }), image.originalname);
    let response: Response;
    try {
      response = await fetch(`${process.env.ML_SERVICE_URL}/v1/images/preflight`, {
        method: 'POST', body: form, signal: AbortSignal.timeout(40_000),
        headers: { 'x-service-token': process.env.SERVICE_TOKEN ?? '', 'x-correlation-id': randomUUID() },
      });
    } catch {
      throw new BadRequestException('No fue posible verificar la imagen en este momento');
    }
    const result = await response.json() as MlPreflight | { detail?: unknown };
    if (!response.ok || !('input_hash' in result)) throw new BadRequestException('El archivo no es DICOM, PNG o JPG compatible');
    const localHash = createHash('sha256').update(image.buffer).digest('hex');
    if (result.input_hash !== localHash) throw new BadRequestException('Falló la comprobación de integridad de la imagen');
    const inserted = await this.db.query<{ id: string }>(
      `INSERT INTO image_preflight_reviews(input_hash,file_kind,media_type,review_status,suggested_layout,supported,
       provider_model,provider_request_id,cost_usd,assessment,created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [localHash, result.file_kind, result.media_type, result.review_status, result.suggested_layout, result.supported,
        result.provider_model, result.provider_request_id, result.cost_usd, JSON.stringify(result.assessment), user.id],
    );
    await this.audit.record(user.id, 'IMAGE_PREFLIGHT', 'ImagePreflightReview', inserted.rows[0].id, {
      fileKind: result.file_kind, status: result.review_status, model: result.provider_model,
    });
    return {
      preflightId: inserted.rows[0].id,
      fileKind: result.file_kind,
      mediaType: result.media_type,
      examDate: result.exam_date,
      previewDataUrl: `data:image/png;base64,${result.preview_base64_png}`,
      reviewStatus: result.review_status,
      suggestedLayout: result.suggested_layout,
      supported: result.supported,
      assessment: result.assessment,
      model: result.provider_model,
      costUsd: result.cost_usd,
      privacy: { metadataStripped: true, bordersMasked: true },
    };
  }

  @Post('episodes/:episodeId/studies')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 64 * 1024 * 1024, files: 1 } }))
  async upload(
    @Param('episodeId') episodeId: string, @UploadedFile() image: { buffer: Buffer; mimetype: string; originalname: string },
    @Body() body: Record<string, string>, @CurrentUser() user: AuthUser,
  ) {
    if (!image?.buffer?.length) throw new BadRequestException('Imagen requerida');
    episodeId = uuid(episodeId, 'Episodio');
    const originalName = text(image.originalname, 'Nombre del archivo', 1, 255);
    const preflightId = uuid(body.preflightId, 'Verificación de imagen');
    const preflight = (await this.db.query<PreflightRow>(
      `SELECT id,input_hash,file_kind,media_type,review_status,suggested_layout,supported
       FROM image_preflight_reviews WHERE id=$1 AND created_by=$2 AND expires_at>now()`, [preflightId, user.id],
    )).rows[0];
    if (!preflight) throw new BadRequestException('La verificación de imagen expiró; vuelva a seleccionar el archivo');
    if (preflight.input_hash !== createHash('sha256').update(image.buffer).digest('hex')) {
      throw new BadRequestException('El archivo cambió después de su verificación');
    }
    if (preflight.review_status === 'REJECTED') {
      throw new BadRequestException('Estudio bloqueado: la imagen no es una radiografía de rodilla');
    }
    if (!preflight.supported) throw new BadRequestException('La disposición detectada no es compatible con este formato');
    if (!['bilateral', 'single'].includes(body.imageLayout)) throw new BadRequestException('Indique si la imagen contiene una o ambas rodillas');
    if (preflight.file_kind === 'DICOM' && body.imageLayout === 'single') {
      throw new BadRequestException('Actualmente el DICOM debe contener ambas rodillas');
    }
    const sourceType = preflight.file_kind === 'DICOM'
      ? 'DICOM_BILATERAL'
      : body.imageLayout === 'bilateral' ? 'RASTER_BILATERAL' : 'RASTER_SINGLE_ROI';
    if (!SOURCE_TYPES.includes(sourceType)) throw new BadRequestException('Tipo de entrada inválido');
    if (!['L', 'R'].includes(body.kneeSide)) throw new BadRequestException('Lateralidad inválida');
    const examDate = isoDate(body.examDate, 'Fecha del examen');
    if (!asBool(body.acquisitionConfirmed, 'radiografía frontal con apoyo de peso')) {
      throw new BadRequestException('Debe confirmar que la radiografía es frontal y fue tomada con apoyo de peso');
    }
    const episode = (await this.db.query<{ patient_id: string }>(
      `SELECT e.patient_id FROM clinical_episodes e JOIN patients p ON p.id=e.patient_id
       WHERE e.id=$1 AND e.status='OPEN' AND p.owner_clinician_id=$2 AND p.archived_at IS NULL`, [episodeId, user.id],
    )).rows[0];
    if (!episode) throw new BadRequestException('Episodio no encontrado o cerrado');
    const profile = (await this.db.query<any>('SELECT * FROM patient_clinical_profiles WHERE patient_id=$1', [episode.patient_id])).rows[0];
    if (!profile) throw new BadRequestException('Complete primero los datos clínicos de la historia del paciente');
    const confirmation = { projection: true, weight: true, orientation: true };
    const stored = await this.assets.write(image.buffer);
    const ids = await this.db.transaction(async (client) => {
      const asset = await client.query<{ id: string }>(
        `INSERT INTO stored_assets(patient_id,kind,storage_key,content_type,original_name_cipher,plaintext_sha256,size_bytes,created_by)
         VALUES($1,'RADIOGRAPH',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [episode.patient_id, stored.storageKey, preflight.media_type, this.crypto.encrypt(originalName, `asset:${stored.storageKey}:name`),
          createHash('sha256').update(image.buffer).digest('hex'), image.buffer.length, user.id],
      );
      const study = await client.query<{ id: string }>(
        `INSERT INTO radiographic_studies(episode_id,asset_id,exam_date,source_type,projection_confirmed,
         weight_bearing_confirmed,orientation_confirmed,metadata_inverted,horizontal_flip,created_by,preflight_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [episodeId, asset.rows[0].id, examDate, sourceType, confirmation.projection, confirmation.weight,
          confirmation.orientation, preflight.file_kind === 'DICOM' ? asBool(body.invertPolarity ?? 'false', 'polaridad') : false,
          body.imageLayout === 'bilateral' ? asBool(body.swapSides ?? 'false', 'intercambio de lados') : false, user.id, preflight.id],
      );
      const observation = await client.query<{ id: string }>(
        'INSERT INTO knee_observations(study_id,knee_side) VALUES($1,$2) RETURNING id', [study.rows[0].id, body.kneeSide],
      );
      await client.query(
        `INSERT INTO clinical_observations(knee_observation_id,pain_score,obesity,diabetes,hypertension,nicotine_use,trauma_lower_extremity,recorded_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [observation.rows[0].id, profile.pain_score, profile.obesity, profile.diabetes, profile.hypertension,
          profile.nicotine_use, profile.trauma_lower_extremity, user.id],
      );
      const job = await client.query<{ id: string }>(
        `INSERT INTO inference_jobs(observation_id,job_type,idempotency_key,created_by)
         VALUES($1,'KL',$2,$3) RETURNING id`, [observation.rows[0].id, `kl:${observation.rows[0].id}:automatic`, user.id],
      );
      return { studyId: study.rows[0].id, observationId: observation.rows[0].id, jobId: job.rows[0].id };
    });
    await this.audit.record(user.id, 'STUDY_UPLOADED', 'RadiographicStudy', ids.studyId, {
      sourceType, kneeSide: body.kneeSide, preflightStatus: preflight.review_status,
    });
    await this.audit.record(user.id, 'INFERENCE_QUEUED', 'InferenceJob', ids.jobId, { automatic: true });
    return ids;
  }

  @Post('observations/:observationId/inference')
  async queue(@Param('observationId') observationId: string, @Body() body: { idempotencyKey?: string }, @CurrentUser() user: AuthUser) {
    observationId = uuid(observationId, 'Observación');
    const owned = await this.db.query(
      `SELECT 1 FROM knee_observations k JOIN radiographic_studies s ON s.id=k.study_id JOIN clinical_episodes e ON e.id=s.episode_id
       JOIN patients p ON p.id=e.patient_id WHERE k.id=$1 AND p.owner_clinician_id=$2 AND p.archived_at IS NULL`, [observationId, user.id],
    );
    if (!owned.rowCount) throw new BadRequestException('Observación no encontrada');
    const suppliedKey = optionalText(body.idempotencyKey, 'Clave de idempotencia', 80) ?? 'default';
    if (!/^[A-Za-z0-9._:-]+$/.test(suppliedKey)) throw new BadRequestException('Clave de idempotencia inválida');
    const key = `kl:${observationId}:${suppliedKey}`;
    const result = await this.db.query<{ id: string; status: string }>(
      `INSERT INTO inference_jobs(observation_id,job_type,idempotency_key,created_by) VALUES($1,'KL',$2,$3)
       ON CONFLICT(idempotency_key) DO UPDATE SET status=CASE WHEN inference_jobs.status='FAILED' THEN 'QUEUED' ELSE inference_jobs.status END,
       attempts=CASE WHEN inference_jobs.status='FAILED' THEN 0 ELSE inference_jobs.attempts END,error_code=NULL RETURNING id,status`,
      [observationId, key, user.id],
    );
    await this.audit.record(user.id, 'INFERENCE_QUEUED', 'InferenceJob', result.rows[0].id);
    return result.rows[0];
  }

  @Get('inference-jobs/:id')
  async job(@Param('id') id: string, @CurrentUser() user: AuthUser) {
    id = uuid(id, 'Trabajo');
    const result = await this.db.query(
      `SELECT j.id,j.status,j.job_type "jobType",j.error_code "errorCode",j.correlation_id "correlationId",
       j.created_at "createdAt",j.started_at "startedAt",j.finished_at "finishedAt",
       p.id "predictionId",p.probabilities,p.model_version "modelVersion",p.artifact_hashes "artifactHashes",
       p.latency_ms "latencyMs",p.device
       FROM inference_jobs j JOIN knee_observations k ON k.id=j.observation_id JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients owner ON owner.id=e.patient_id
       LEFT JOIN model_predictions p ON p.job_id=j.id WHERE j.id=$1 AND owner.owner_clinician_id=$2`, [id, user.id],
    );
    if (!result.rows[0]) throw new BadRequestException('Trabajo no encontrado');
    return result.rows[0];
  }

  @Post('predictions/:id/review')
  async review(@Param('id') predictionId: string, @Body() body: { decision?: string; confirmedKl?: number | null; reason?: string }, @CurrentUser() user: AuthUser) {
    predictionId = uuid(predictionId, 'Predicción');
    if (!['CONFIRMED', 'CORRECTED', 'REJECTED'].includes(body.decision ?? '')) throw new BadRequestException('Decisión inválida');
    const rejected = body.decision === 'REJECTED';
    if (!rejected) boundedNumber(body.confirmedKl, 'KL confirmado', 0, 4, true);
    const reason = optionalText(body.reason, 'Motivo de revisión', 1000);
    const owned = await this.db.query(
      `SELECT 1 FROM model_predictions mp JOIN knee_observations k ON k.id=mp.observation_id JOIN radiographic_studies s ON s.id=k.study_id
       JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id WHERE mp.id=$1 AND p.owner_clinician_id=$2`, [predictionId, user.id],
    );
    if (!owned.rowCount) throw new BadRequestException('Predicción KL no encontrada');
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO clinician_reviews(prediction_id,decision,confirmed_kl,reason,reviewed_by)
       SELECT id,$2,$3,$4,$5 FROM model_predictions WHERE id=$1 AND model_name='Ensemble-v2' RETURNING id`,
      [predictionId, body.decision, rejected ? null : body.confirmedKl, reason, user.id],
    );
    if (!result.rows[0]) throw new BadRequestException('Predicción KL no encontrada');
    await this.audit.record(user.id, 'PREDICTION_REVIEWED', 'ClinicianReview', result.rows[0].id, { decision: body.decision });
    return { id: result.rows[0].id };
  }

  @Get('predictions/:id/explanations')
  async explanations(@Param('id') predictionId: string, @CurrentUser() user: AuthUser) {
    predictionId = uuid(predictionId, 'Predicción');
    const result = await this.db.query<{ id: string; backbone: string; target_kl: number; storage_key: string }>(
      `SELECT g.id,g.backbone,g.target_kl,a.storage_key FROM gradcam_explanations g JOIN stored_assets a ON a.id=g.asset_id
       JOIN model_predictions mp ON mp.id=g.prediction_id JOIN knee_observations k ON k.id=mp.observation_id
       JOIN radiographic_studies s ON s.id=k.study_id JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id
       WHERE g.prediction_id=$1 AND p.owner_clinician_id=$2 ORDER BY g.backbone`, [predictionId, user.id],
    );
    return Promise.all(result.rows.map(async (item) => ({
      id: item.id, backbone: item.backbone, targetKl: item.target_kl,
      dataUrl: `data:image/png;base64,${(await this.assets.read(item.storage_key)).toString('base64')}`,
    })));
  }
}
