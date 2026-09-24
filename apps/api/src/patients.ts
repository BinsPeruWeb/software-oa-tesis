import { BadRequestException, Body, Controller, Delete, Get, Injectable, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthUser, ClinicianGuard, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AuditService, CryptoService, DatabaseService } from './infrastructure';
import { PeruDevsService } from './identity';
import { pageNumber, paged } from './pagination';
import { cellphone, dateOfBirth, dni, email, isoDate, personName, text, uuid } from './validation';

type PatientInput = {
  dni: string; names: string; surnames: string; birthDate: string;
  sex: 'female' | 'male' | null; phone: string; email?: string | null;
};
type PatientRow = {
  id: string; medical_record_cipher: Buffer; dni_cipher: Buffer; names_cipher: Buffer;
  surnames_cipher: Buffer; birth_date_cipher: Buffer; sex_cipher: Buffer | null;
  phone_cipher: Buffer; email_cipher: Buffer | null; created_at: Date; updated_at: Date;
  archived_at: Date | null; owner_clinician_id: string;
};

@Injectable()
export class PatientsService {
  constructor(private readonly db: DatabaseService, private readonly crypto: CryptoService, private readonly audit: AuditService) {}

  private validate(input: PatientInput) {
    return {
      dni: dni(input.dni), names: personName(input.names, 'Nombres'), surnames: personName(input.surnames, 'Apellidos'),
      birthDate: dateOfBirth(input.birthDate), phone: cellphone(input.phone), email: email(input.email),
      sex: [null, 'female', 'male'].includes(input.sex) ? input.sex : (() => { throw new BadRequestException('Sexo inválido'); })(),
    } as PatientInput;
  }

  private expose(row: PatientRow) {
    const id = row.id;
    return {
      id,
      medicalRecordNumber: this.crypto.decryptText(row.medical_record_cipher, `patient:${id}:mrn`),
      dni: this.crypto.decryptText(row.dni_cipher, `patient:${id}:dni`),
      names: this.crypto.decryptText(row.names_cipher, `patient:${id}:names`),
      surnames: this.crypto.decryptText(row.surnames_cipher, `patient:${id}:surnames`),
      birthDate: this.crypto.decryptText(row.birth_date_cipher, `patient:${id}:birth`),
      sex: row.sex_cipher ? this.crypto.decryptText(row.sex_cipher, `patient:${id}:sex`) : null,
      phone: this.crypto.decryptText(row.phone_cipher, `patient:${id}:phone`),
      email: row.email_cipher ? this.crypto.decryptText(row.email_cipher, `patient:${id}:email`) : null,
      archived: Boolean(row.archived_at), createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  private async ownedRow(id: string, actor: AuthUser, includeArchived = false) {
    id = uuid(id, 'Paciente');
    const result = await this.db.query<PatientRow>(
      `SELECT p.*,c.phone_cipher,c.email_cipher FROM patients p JOIN patient_contacts c ON c.patient_id=p.id
       WHERE p.id=$1 AND p.owner_clinician_id=$2 AND ($3::boolean OR p.archived_at IS NULL)`, [id, actor.id, includeArchived],
    );
    if (!result.rows[0]) throw new BadRequestException('Paciente no encontrado');
    return result.rows[0];
  }

  async create(raw: PatientInput, actor: AuthUser) {
    const input = this.validate(raw); const id = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        const settings = (await client.query<{ value: { prefix?: string; digits?: number } }>("SELECT value FROM app_settings WHERE key='patientCode' FOR SHARE")).rows[0]?.value ?? {};
        const sequence = Number((await client.query<{ value: string }>("SELECT nextval('patient_code_seq')::text value")).rows[0].value);
        const prefix = String(settings.prefix ?? 'OA').replace(/[^A-Za-z0-9]/g, '').slice(0, 8) || 'OA';
        const digits = Math.min(10, Math.max(4, Number(settings.digits ?? 6)));
        const medicalRecord = `${prefix}-${String(sequence).padStart(digits, '0')}`;
        await client.query(
          `INSERT INTO patients(id,medical_record_cipher,medical_record_hmac,dni_cipher,dni_hmac,names_cipher,surnames_cipher,
           birth_date_cipher,sex_cipher,created_by,owner_clinician_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
          [id, this.crypto.encrypt(medicalRecord, `patient:${id}:mrn`), this.crypto.blindIndex(medicalRecord),
            this.crypto.encrypt(input.dni, `patient:${id}:dni`), this.crypto.blindIndex(input.dni),
            this.crypto.encrypt(input.names, `patient:${id}:names`), this.crypto.encrypt(input.surnames, `patient:${id}:surnames`),
            this.crypto.encrypt(input.birthDate, `patient:${id}:birth`), input.sex ? this.crypto.encrypt(input.sex, `patient:${id}:sex`) : null, actor.id],
        );
        await client.query('INSERT INTO patient_contacts(patient_id,phone_cipher,email_cipher) VALUES($1,$2,$3)', [
          id, this.crypto.encrypt(input.phone, `patient:${id}:phone`), input.email ? this.crypto.encrypt(input.email, `patient:${id}:email`) : null,
        ]);
      });
    } catch (error: any) {
      if (error?.code === '23505') throw new BadRequestException('El DNI ya está registrado');
      throw error;
    }
    await this.audit.record(actor.id, 'PATIENT_CREATED', 'Patient', id);
    return this.get(id, actor);
  }

  async update(id: string, raw: PatientInput, actor: AuthUser) {
    const row = await this.ownedRow(id, actor); const input = this.validate(raw);
    try {
      await this.db.transaction(async (client) => {
        await client.query(
          `UPDATE patients SET dni_cipher=$2,dni_hmac=$3,names_cipher=$4,surnames_cipher=$5,birth_date_cipher=$6,
           sex_cipher=$7,updated_at=now() WHERE id=$1 AND owner_clinician_id=$8`,
          [row.id, this.crypto.encrypt(input.dni, `patient:${row.id}:dni`), this.crypto.blindIndex(input.dni),
            this.crypto.encrypt(input.names, `patient:${row.id}:names`), this.crypto.encrypt(input.surnames, `patient:${row.id}:surnames`),
            this.crypto.encrypt(input.birthDate, `patient:${row.id}:birth`), input.sex ? this.crypto.encrypt(input.sex, `patient:${row.id}:sex`) : null, actor.id],
        );
        await client.query('UPDATE patient_contacts SET phone_cipher=$2,email_cipher=$3 WHERE patient_id=$1', [
          row.id, this.crypto.encrypt(input.phone, `patient:${row.id}:phone`), input.email ? this.crypto.encrypt(input.email, `patient:${row.id}:email`) : null,
        ]);
      });
    } catch (error: any) {
      if (error?.code === '23505') throw new BadRequestException('El DNI ya está registrado');
      throw error;
    }
    await this.audit.record(actor.id, 'PATIENT_UPDATED', 'Patient', row.id);
    return this.get(row.id, actor);
  }

  async get(id: string, actor: AuthUser, includeArchived = false) {
    const row = await this.ownedRow(id, actor, includeArchived);
    const stats = (await this.db.query<{ episodes: string; studies: string; reports: string }>(
      `SELECT count(DISTINCT e.id)::text episodes,count(DISTINCT s.id)::text studies,count(DISTINCT r.id)::text reports
       FROM patients p LEFT JOIN clinical_episodes e ON e.patient_id=p.id LEFT JOIN radiographic_studies s ON s.episode_id=e.id
       LEFT JOIN draft_reports r ON r.episode_id=e.id WHERE p.id=$1`, [row.id],
    )).rows[0];
    await this.audit.record(actor.id, 'PATIENT_VIEWED', 'Patient', row.id);
    return { ...this.expose(row), stats: { episodes: Number(stats.episodes), studies: Number(stats.studies), reports: Number(stats.reports) } };
  }

  async list(actor: AuthUser, requestedPage: unknown, search = '', status: 'active' | 'archived' | 'all' = 'all') {
    const page = pageNumber(requestedPage);
    const rows = (await this.db.query<PatientRow>(
      `SELECT p.*,c.phone_cipher,c.email_cipher FROM patients p JOIN patient_contacts c ON c.patient_id=p.id
       WHERE p.owner_clinician_id=$1 AND ($2='all' OR ($2='active' AND p.archived_at IS NULL) OR ($2='archived' AND p.archived_at IS NOT NULL))
       ORDER BY p.created_at DESC`, [actor.id, status],
    )).rows.map((row) => this.expose(row));
    const needle = String(search ?? '').trim().toLocaleLowerCase('es');
    const filtered = needle ? rows.filter((item) => [item.medicalRecordNumber, item.dni, item.names, item.surnames]
      .some((value) => value.toLocaleLowerCase('es').includes(needle))) : rows;
    return paged(filtered, page);
  }

  async search(identifier: string, actor: AuthUser) {
    const normalized = text(identifier, 'DNI o historia clínica', 1, 30);
    const index = this.crypto.blindIndex(normalized);
    const result = await this.db.query<PatientRow>(
      `SELECT p.*,c.phone_cipher,c.email_cipher FROM patients p JOIN patient_contacts c ON c.patient_id=p.id
       WHERE p.owner_clinician_id=$2 AND p.archived_at IS NULL AND (p.dni_hmac=$1 OR p.medical_record_hmac=$1) LIMIT 1`, [index, actor.id],
    );
    await this.audit.record(actor.id, 'PATIENT_SEARCHED', 'Patient', result.rows[0]?.id, { found: Boolean(result.rows[0]) });
    return result.rows[0] ? this.expose(result.rows[0]) : null;
  }

  async archive(id: string, actor: AuthUser) {
    const row = await this.ownedRow(id, actor);
    await this.db.query('UPDATE patients SET archived_at=now(),updated_at=now() WHERE id=$1 AND owner_clinician_id=$2', [row.id, actor.id]);
    await this.audit.record(actor.id, 'PATIENT_ARCHIVED', 'Patient', row.id);
    return { archived: true };
  }
}

@Controller('api/patients')
@UseGuards(SessionGuard, CsrfGuard, ClinicianGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService, private readonly identity: PeruDevsService, private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Get('dashboard')
  async dashboard(@CurrentUser() user: AuthUser) {
    const values = (await this.db.query<{ patients: string; studies: string; pending: string; reports: string }>(
      `SELECT (SELECT count(*) FROM patients WHERE owner_clinician_id=$1 AND archived_at IS NULL)::text patients,
       (SELECT count(*) FROM radiographic_studies s JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1)::text studies,
       (SELECT count(*) FROM model_predictions mp JOIN knee_observations k ON k.id=mp.observation_id JOIN radiographic_studies s ON s.id=k.study_id
        JOIN clinical_episodes e ON e.id=s.episode_id JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1 AND mp.model_name='Ensemble-v2'
        AND NOT EXISTS(SELECT 1 FROM clinician_reviews cr WHERE cr.prediction_id=mp.id))::text pending,
       (SELECT count(*) FROM draft_reports r JOIN clinical_episodes e ON e.id=r.episode_id JOIN patients p ON p.id=e.patient_id WHERE p.owner_clinician_id=$1)::text reports`, [user.id],
    )).rows[0];
    return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Number(value)]));
  }

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('search') search?: string,
    @Query('status') rawStatus?: string,
    @Query('archived') archived?: string,
  ) {
    const status = rawStatus ?? (archived === 'false' ? 'active' : 'all');
    if (!['active', 'archived', 'all'].includes(status)) throw new BadRequestException('Estado de paciente inválido');
    return this.patients.list(user, page, search, status as 'active' | 'archived' | 'all');
  }
  @Post() create(@Body() body: PatientInput, @CurrentUser() user: AuthUser) { return this.patients.create(body, user); }
  @Get('search') search(@Query('identifier') identifier: string, @CurrentUser() user: AuthUser) { return this.patients.search(identifier, user); }
  @Get('lookup-dni') async lookupDni(@Query('dni') document: string, @CurrentUser() user: AuthUser) {
    const value = await this.identity.lookup(dni(document), user.id);
    await this.audit.record(user.id, 'DNI_LOOKUP', 'ExternalIdentityLookup', undefined, { found: value.found });
    return value;
  }
  @Get(':id') get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.patients.get(id, user, true); }
  @Patch(':id') update(@Param('id') id: string, @Body() body: PatientInput, @CurrentUser() user: AuthUser) { return this.patients.update(id, body, user); }
  @Delete(':id') archive(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.patients.archive(id, user); }

  @Get(':id/episodes')
  async episodes(@Param('id') patientId: string, @CurrentUser() user: AuthUser) {
    await this.patients.get(patientId, user, true);
    return (await this.db.query(
      `SELECT e.id,e.opened_at "openedAt",e.status,count(DISTINCT s.id)::int "studyCount",count(DISTINCT r.id)::int "reportCount"
       FROM clinical_episodes e LEFT JOIN radiographic_studies s ON s.episode_id=e.id LEFT JOIN draft_reports r ON r.episode_id=e.id
       WHERE e.patient_id=$1 GROUP BY e.id ORDER BY e.opened_at DESC`, [patientId],
    )).rows;
  }

  @Post(':id/episodes')
  async episode(@Param('id') patientId: string, @Body() body: { openedAt?: string }, @CurrentUser() user: AuthUser) {
    const patient = await this.patients.get(patientId, user);
    const clinicalProfile = await this.db.query('SELECT 1 FROM patient_clinical_profiles WHERE patient_id=$1', [patient.id]);
    if (!clinicalProfile.rowCount) throw new BadRequestException('Complete la historia clínica antes de iniciar un análisis');
    const openedAt = isoDate(body.openedAt ?? new Date().toISOString().slice(0, 10), 'Fecha del episodio');
    const result = await this.db.query<{ id: string }>('INSERT INTO clinical_episodes(patient_id,opened_at,created_by) VALUES($1,$2,$3) RETURNING id', [patient.id, openedAt, user.id]);
    await this.audit.record(user.id, 'EPISODE_CREATED', 'ClinicalEpisode', result.rows[0].id);
    return { id: result.rows[0].id, patientId: patient.id, openedAt, status: 'OPEN' };
  }
}
