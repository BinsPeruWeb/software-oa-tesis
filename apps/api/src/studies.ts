import {
  BadRequestException, Body, Controller, Get, Injectable, Logger, OnModuleDestroy, OnModuleInit,
  Param, Post, UploadedFile, UseGuards, UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { createHash, randomUUID } from 'node:crypto';
import { AuthUser, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AssetService, AuditService, CryptoService, DatabaseService } from './infrastructure';

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
@UseGuards(SessionGuard, CsrfGuard)
export class StudiesController {
  constructor(
    private readonly db: DatabaseService, private readonly assets: AssetService,
    private readonly crypto: CryptoService, private readonly audit: AuditService,
  ) {}

  @Post('episodes/:episodeId/studies')
  @UseInterceptors(FileInterceptor('image', { limits: { fileSize: 64 * 1024 * 1024, files: 1 } }))
  async upload(
    @Param('episodeId') episodeId: string, @UploadedFile() image: { buffer: Buffer; mimetype: string; originalname: string },
    @Body() body: Record<string, string>, @CurrentUser() user: AuthUser,
  ) {
    if (!image?.buffer?.length) throw new BadRequestException('Imagen requerida');
    if (!SOURCE_TYPES.includes(body.sourceType as any)) throw new BadRequestException('Tipo de entrada inválido');
    if (!['L', 'R'].includes(body.kneeSide)) throw new BadRequestException('Lateralidad inválida');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.examDate ?? '')) throw new BadRequestException('Fecha inválida');
    const episode = (await this.db.query<{ patient_id: string }>('SELECT patient_id FROM clinical_episodes WHERE id=$1 AND status=\'OPEN\'', [episodeId])).rows[0];
    if (!episode) throw new BadRequestException('Episodio no encontrado o cerrado');
    const confirmation = {
      projection: asBool(body.projectionConfirmed, 'proyección AP'),
      weight: asBool(body.weightBearingConfirmed, 'soporte de peso'),
      orientation: asBool(body.orientationConfirmed, 'orientación'),
    };
    const stored = await this.assets.write(image.buffer);
    const ids = await this.db.transaction(async (client) => {
      const asset = await client.query<{ id: string }>(
        `INSERT INTO stored_assets(patient_id,kind,storage_key,content_type,original_name_cipher,plaintext_sha256,size_bytes,created_by)
         VALUES($1,'RADIOGRAPH',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [episode.patient_id, stored.storageKey, image.mimetype, this.crypto.encrypt(image.originalname, `asset:${stored.storageKey}:name`),
          createHash('sha256').update(image.buffer).digest('hex'), image.buffer.length, user.id],
      );
      const study = await client.query<{ id: string }>(
        `INSERT INTO radiographic_studies(episode_id,asset_id,exam_date,source_type,projection_confirmed,
         weight_bearing_confirmed,orientation_confirmed,metadata_inverted,horizontal_flip,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [episodeId, asset.rows[0].id, body.examDate, body.sourceType, confirmation.projection, confirmation.weight,
          confirmation.orientation, asBool(body.metadataInverted ?? 'false', 'polaridad'),
          asBool(body.horizontalFlip ?? 'false', 'corrección horizontal'), user.id],
      );
      const observation = await client.query<{ id: string }>(
        'INSERT INTO knee_observations(study_id,knee_side) VALUES($1,$2) RETURNING id', [study.rows[0].id, body.kneeSide],
      );
      return { studyId: study.rows[0].id, observationId: observation.rows[0].id };
    });
    await this.audit.record(user.id, 'STUDY_UPLOADED', 'RadiographicStudy', ids.studyId, { sourceType: body.sourceType, kneeSide: body.kneeSide });
    return ids;
  }

  @Post('observations/:observationId/inference')
  async queue(@Param('observationId') observationId: string, @Body() body: { idempotencyKey?: string }, @CurrentUser() user: AuthUser) {
    const key = `kl:${observationId}:${body.idempotencyKey?.trim() || 'default'}`;
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
  async job(@Param('id') id: string) {
    const result = await this.db.query(
      `SELECT j.id,j.status,j.job_type "jobType",j.error_code "errorCode",j.correlation_id "correlationId",
       p.id "predictionId",p.probabilities,p.model_version "modelVersion",p.artifact_hashes "artifactHashes",
       p.latency_ms "latencyMs",p.device
       FROM inference_jobs j LEFT JOIN model_predictions p ON p.job_id=j.id WHERE j.id=$1`, [id],
    );
    if (!result.rows[0]) throw new BadRequestException('Trabajo no encontrado');
    return result.rows[0];
  }

  @Post('predictions/:id/review')
  async review(@Param('id') predictionId: string, @Body() body: { decision?: string; confirmedKl?: number | null; reason?: string }, @CurrentUser() user: AuthUser) {
    if (!['CONFIRMED', 'CORRECTED', 'REJECTED'].includes(body.decision ?? '')) throw new BadRequestException('Decisión inválida');
    const rejected = body.decision === 'REJECTED';
    if ((!rejected && !Number.isInteger(body.confirmedKl)) || (!rejected && (body.confirmedKl! < 0 || body.confirmedKl! > 4))) {
      throw new BadRequestException('KL confirmado entre 0 y 4 requerido');
    }
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO clinician_reviews(prediction_id,decision,confirmed_kl,reason,reviewed_by)
       SELECT id,$2,$3,$4,$5 FROM model_predictions WHERE id=$1 AND model_name='Ensemble-v2' RETURNING id`,
      [predictionId, body.decision, rejected ? null : body.confirmedKl, body.reason?.slice(0, 1000) ?? null, user.id],
    );
    if (!result.rows[0]) throw new BadRequestException('Predicción KL no encontrada');
    await this.audit.record(user.id, 'PREDICTION_REVIEWED', 'ClinicianReview', result.rows[0].id, { decision: body.decision });
    return { id: result.rows[0].id };
  }

  @Get('predictions/:id/explanations')
  async explanations(@Param('id') predictionId: string) {
    const result = await this.db.query<{ id: string; backbone: string; target_kl: number; storage_key: string }>(
      `SELECT g.id,g.backbone,g.target_kl,a.storage_key FROM gradcam_explanations g
       JOIN stored_assets a ON a.id=g.asset_id WHERE g.prediction_id=$1 ORDER BY g.backbone`, [predictionId],
    );
    return Promise.all(result.rows.map(async (item) => ({
      id: item.id, backbone: item.backbone, targetKl: item.target_kl,
      dataUrl: `data:image/png;base64,${(await this.assets.read(item.storage_key)).toString('base64')}`,
    })));
  }
}
