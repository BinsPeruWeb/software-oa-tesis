import { BadRequestException, Body, Controller, Get, Injectable, Param, Post, Query, UseGuards } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthUser, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AuditService, CryptoService, DatabaseService } from './infrastructure';

type PatientInput = {
  medicalRecordNumber: string; dni: string; names: string; surnames: string;
  birthDate: string; sex: 'female' | 'male' | null; phone: string; email?: string | null;
};
type PatientRow = {
  id: string; medical_record_cipher: Buffer; dni_cipher: Buffer; names_cipher: Buffer;
  surnames_cipher: Buffer; birth_date_cipher: Buffer; sex_cipher: Buffer | null;
  phone_cipher: Buffer; email_cipher: Buffer | null; created_at: Date;
};

@Injectable()
export class PatientsService {
  constructor(private readonly db: DatabaseService, private readonly crypto: CryptoService, private readonly audit: AuditService) {}

  private validate(input: PatientInput) {
    if (!input.medicalRecordNumber?.trim() || !input.dni?.trim() || !input.names?.trim() || !input.surnames?.trim() || !input.phone?.trim()) {
      throw new BadRequestException('Historia clínica, DNI, nombres, apellidos y teléfono son obligatorios');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birthDate) || Number.isNaN(Date.parse(input.birthDate))) throw new BadRequestException('Fecha de nacimiento inválida');
    if (![null, 'female', 'male'].includes(input.sex)) throw new BadRequestException('Sexo inválido');
  }

  async create(input: PatientInput, actor: AuthUser) {
    this.validate(input);
    const id = randomUUID();
    try {
      await this.db.transaction(async (client) => {
        await client.query(
          `INSERT INTO patients(id,medical_record_cipher,medical_record_hmac,dni_cipher,dni_hmac,names_cipher,surnames_cipher,birth_date_cipher,sex_cipher,created_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [id, this.crypto.encrypt(input.medicalRecordNumber.trim(), `patient:${id}:mrn`), this.crypto.blindIndex(input.medicalRecordNumber),
            this.crypto.encrypt(input.dni.trim(), `patient:${id}:dni`), this.crypto.blindIndex(input.dni),
            this.crypto.encrypt(input.names.trim(), `patient:${id}:names`), this.crypto.encrypt(input.surnames.trim(), `patient:${id}:surnames`),
            this.crypto.encrypt(input.birthDate, `patient:${id}:birth`), input.sex ? this.crypto.encrypt(input.sex, `patient:${id}:sex`) : null, actor.id],
        );
        await client.query('INSERT INTO patient_contacts(patient_id,phone_cipher,email_cipher) VALUES($1,$2,$3)', [
          id, this.crypto.encrypt(input.phone.trim(), `patient:${id}:phone`),
          input.email ? this.crypto.encrypt(input.email.trim(), `patient:${id}:email`) : null,
        ]);
      });
    } catch (error: any) {
      if (error?.code === '23505') throw new BadRequestException('DNI o historia clínica ya registrado');
      throw error;
    }
    await this.audit.record(actor.id, 'PATIENT_CREATED', 'Patient', id);
    return this.get(id, actor);
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
      createdAt: row.created_at,
    };
  }

  async get(id: string, actor: AuthUser) {
    const result = await this.db.query<PatientRow>(
      `SELECT p.*,c.phone_cipher,c.email_cipher FROM patients p JOIN patient_contacts c ON c.patient_id=p.id WHERE p.id=$1`, [id],
    );
    if (!result.rows[0]) throw new BadRequestException('Paciente no encontrado');
    await this.audit.record(actor.id, 'PATIENT_VIEWED', 'Patient', id);
    return this.expose(result.rows[0]);
  }

  async search(identifier: string, actor: AuthUser) {
    if (!identifier?.trim()) throw new BadRequestException('Ingrese DNI o historia clínica exactos');
    const index = this.crypto.blindIndex(identifier);
    const result = await this.db.query<PatientRow>(
      `SELECT p.*,c.phone_cipher,c.email_cipher FROM patients p JOIN patient_contacts c ON c.patient_id=p.id
       WHERE p.dni_hmac=$1 OR p.medical_record_hmac=$1 LIMIT 1`, [index],
    );
    await this.audit.record(actor.id, 'PATIENT_SEARCHED', 'Patient', result.rows[0]?.id, { found: Boolean(result.rows[0]) });
    return result.rows[0] ? this.expose(result.rows[0]) : null;
  }
}

@Controller('api/patients')
@UseGuards(SessionGuard, CsrfGuard)
export class PatientsController {
  constructor(private readonly patients: PatientsService, private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Post()
  create(@Body() body: PatientInput, @CurrentUser() user: AuthUser) { return this.patients.create(body, user); }

  @Get('search')
  search(@Query('identifier') identifier: string, @CurrentUser() user: AuthUser) { return this.patients.search(identifier, user); }

  @Get(':id')
  get(@Param('id') id: string, @CurrentUser() user: AuthUser) { return this.patients.get(id, user); }

  @Post(':id/episodes')
  async episode(@Param('id') patientId: string, @Body() body: { openedAt?: string }, @CurrentUser() user: AuthUser) {
    const openedAt = body.openedAt ?? new Date().toISOString().slice(0, 10);
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO clinical_episodes(patient_id,opened_at,created_by) VALUES($1,$2,$3) RETURNING id`,
      [patientId, openedAt, user.id],
    );
    await this.audit.record(user.id, 'EPISODE_CREATED', 'ClinicalEpisode', result.rows[0].id);
    return { id: result.rows[0].id, patientId, openedAt, status: 'OPEN' };
  }
}

