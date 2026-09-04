import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import argon2 from 'argon2';
import { AdminGuard, AuthUser, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AuditService, DatabaseService } from './infrastructure';
import { PAGE_SIZE, pageNumber } from './pagination';
import { email, optionalText, text, uuid } from './validation';

type UserInput = { email?: string; displayName?: string; password?: string; role?: string; professionalLicense?: string | null; specialty?: string | null };

@Controller('api/admin')
@UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Get('dashboard')
  async dashboard() {
    const row = (await this.db.query<Record<string, string>>(
      `SELECT (SELECT count(*) FROM users WHERE active)::text "activeUsers",
       (SELECT count(*) FROM users WHERE active AND role_code='CLINICIAN')::text clinicians,
       (SELECT count(*) FROM patients WHERE archived_at IS NULL)::text patients,
       (SELECT count(*) FROM inference_jobs WHERE status IN ('QUEUED','RUNNING'))::text "activeJobs",
       (SELECT count(*) FROM inference_jobs WHERE status='FAILED')::text "failedJobs",
       (SELECT count(*) FROM audit_events WHERE occurred_at>now()-interval '24 hours')::text "events24h"`,
    )).rows[0];
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  }

  @Get('users')
  async users(@Query('page') pageValue?: string, @Query('search') searchValue?: string) {
    const page = pageNumber(pageValue); const search = String(searchValue ?? '').trim().slice(0, 100);
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    const where = search ? `WHERE email ILIKE $1 ESCAPE '\\' OR display_name ILIKE $1 ESCAPE '\\' OR COALESCE(specialty,'') ILIKE $1 ESCAPE '\\'` : '';
    const values = search ? [pattern] : [];
    const total = Number((await this.db.query<{ count: string }>(`SELECT count(*)::text count FROM users ${where}`, values)).rows[0].count);
    const offset = (Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE))) - 1) * PAGE_SIZE;
    const result = await this.db.query(
      `SELECT id,email,display_name "displayName",role_code role,active,professional_license "professionalLicense",
       specialty,failed_attempts "failedAttempts",locked_until "lockedUntil",created_at "createdAt",updated_at "updatedAt",
       (SELECT max(last_seen_at) FROM sessions WHERE user_id=users.id) "lastAccess"
       FROM users ${where} ORDER BY created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, values,
    );
    return { items: result.rows, page: Math.floor(offset / PAGE_SIZE) + 1, pageSize: PAGE_SIZE, total, pages: Math.max(1, Math.ceil(total / PAGE_SIZE)) };
  }

  private normalized(body: UserInput, passwordRequired: boolean) {
    const normalizedEmail = email(body.email, true)!;
    const displayName = text(body.displayName, 'Nombre visible', 2, 100);
    if (!['CLINICIAN', 'ADMIN'].includes(body.role ?? '')) throw new BadRequestException('Rol inválido');
    if (passwordRequired && (!body.password || body.password.length < 14 || body.password.length > 128)) throw new BadRequestException('La contraseña debe tener entre 14 y 128 caracteres');
    if (body.password && (body.password.length < 14 || body.password.length > 128)) throw new BadRequestException('La contraseña debe tener entre 14 y 128 caracteres');
    return { email: normalizedEmail, displayName, role: body.role!, password: body.password,
      professionalLicense: optionalText(body.professionalLicense, 'Colegiatura', 30), specialty: optionalText(body.specialty, 'Especialidad', 80) };
  }

  @Post('users')
  async createUser(@Body() body: UserInput, @CurrentUser() actor: AuthUser) {
    const input = this.normalized(body, true);
    const hash = await argon2.hash(input.password!, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    try {
      const result = await this.db.query<{ id: string }>(
        `INSERT INTO users(email,display_name,password_hash,role_code,professional_license,specialty) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.email, input.displayName, hash, input.role, input.professionalLicense, input.specialty],
      );
      await this.audit.record(actor.id, 'USER_CREATED', 'User', result.rows[0].id, { role: input.role });
      return { id: result.rows[0].id };
    } catch (error: any) { if (error?.code === '23505') throw new BadRequestException('El correo ya está registrado'); throw error; }
  }

  @Patch('users/:id')
  async updateUser(@Param('id') id: string, @Body() body: UserInput, @CurrentUser() actor: AuthUser) {
    id = uuid(id, 'Usuario'); const input = this.normalized(body, false);
    if (id === actor.id && input.role !== 'ADMIN') throw new BadRequestException('No puede retirar su propio rol de administrador');
    if (input.role === 'ADMIN') {
      const owned = await this.db.query('SELECT 1 FROM patients WHERE owner_clinician_id=$1 AND archived_at IS NULL LIMIT 1', [id]);
      if (owned.rowCount) throw new BadRequestException('No puede convertir en administrador a un médico con pacientes activos');
    }
    const passwordHash = input.password ? await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 }) : null;
    try {
      const result = await this.db.query<{ id: string }>(
        `UPDATE users SET email=$2,display_name=$3,role_code=$4,professional_license=$5,specialty=$6,
         password_hash=COALESCE($7,password_hash),updated_at=now() WHERE id=$1 RETURNING id`,
        [id, input.email, input.displayName, input.role, input.professionalLicense, input.specialty, passwordHash],
      );
      if (!result.rowCount) throw new BadRequestException('Usuario no encontrado');
      await this.audit.record(actor.id, 'USER_UPDATED', 'User', id, { role: input.role, passwordChanged: Boolean(passwordHash) });
      return { updated: true };
    } catch (error: any) { if (error?.code === '23505') throw new BadRequestException('El correo ya está registrado'); throw error; }
  }

  @Delete('users/:id')
  async deactivate(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    id = uuid(id, 'Usuario'); if (id === actor.id) throw new BadRequestException('No puede desactivar su propia cuenta');
    const owned = await this.db.query('SELECT 1 FROM patients WHERE owner_clinician_id=$1 AND archived_at IS NULL LIMIT 1', [id]);
    if (owned.rowCount) throw new BadRequestException('No puede desactivar un médico con pacientes activos');
    const result = await this.db.query('UPDATE users SET active=false,updated_at=now() WHERE id=$1 RETURNING id', [id]);
    if (!result.rowCount) throw new BadRequestException('Usuario no encontrado');
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await this.audit.record(actor.id, 'USER_DEACTIVATED', 'User', id);
    return { active: false };
  }

  @Post('users/:id/activate')
  async activate(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    id = uuid(id, 'Usuario'); const result = await this.db.query('UPDATE users SET active=true,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE id=$1 RETURNING id', [id]);
    if (!result.rowCount) throw new BadRequestException('Usuario no encontrado');
    await this.audit.record(actor.id, 'USER_ACTIVATED', 'User', id);
    return { active: true };
  }

  @Post('users/:id/reset-mfa')
  async resetMfa(@Param('id') id: string, @CurrentUser() actor: AuthUser) {
    id = uuid(id, 'Usuario');
    await this.db.query('DELETE FROM mfa_credentials WHERE user_id=$1', [id]);
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [id]);
    await this.audit.record(actor.id, 'MFA_RESET', 'User', id);
    return { reset: true };
  }

  @Get('audit')
  async events(@Query('page') pageValue?: string, @Query('search') searchValue?: string) {
    const search = String(searchValue ?? '').trim().slice(0, 100);
    const pattern = `%${search.replace(/[\\%_]/g, '\\$&')}%`; const values = search ? [pattern] : [];
    const where = search ? `WHERE a.action ILIKE $1 ESCAPE '\\' OR a.entity_type ILIKE $1 ESCAPE '\\' OR COALESCE(u.display_name,'') ILIKE $1 ESCAPE '\\'` : '';
    const total = Number((await this.db.query<{ count: string }>(`SELECT count(*)::text count FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ${where}`, values)).rows[0].count);
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE)); const page = Math.min(pageNumber(pageValue), pages); const offset = (page - 1) * PAGE_SIZE;
    const rows = await this.db.query(
      `SELECT a.id,a.action,a.entity_type "entityType",a.entity_id "entityId",a.metadata,a.occurred_at "occurredAt",
       u.display_name "actorName" FROM audit_events a LEFT JOIN users u ON u.id=a.actor_id ${where}
       ORDER BY a.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`, values,
    );
    return { items: rows.rows, page, pageSize: PAGE_SIZE, total, pages };
  }

  @Get('settings') async settings() { return (await this.db.query('SELECT key,value,updated_at "updatedAt" FROM app_settings ORDER BY key')).rows; }

  @Patch('settings')
  async updateSettings(@Body() body: { organizationName?: string; reportSubtitle?: string; patientCodePrefix?: string }, @CurrentUser() actor: AuthUser) {
    const organizationName = text(body.organizationName, 'Nombre de organización', 2, 100);
    const reportSubtitle = text(body.reportSubtitle, 'Subtítulo de reporte', 2, 160);
    const patientCodePrefix = text(body.patientCodePrefix, 'Prefijo de HC', 1, 8).toUpperCase();
    if (!/^[A-Z0-9]+$/.test(patientCodePrefix)) throw new BadRequestException('El prefijo solo admite letras y números');
    await this.db.transaction(async (client) => {
      await client.query(`UPDATE app_settings SET value=$2::jsonb,updated_by=$3,updated_at=now() WHERE key=$1`, ['organization', JSON.stringify({ name: organizationName, reportSubtitle }), actor.id]);
      await client.query(`UPDATE app_settings SET value=jsonb_set(value,'{prefix}',$2::jsonb),updated_by=$3,updated_at=now() WHERE key=$1`, ['patientCode', JSON.stringify(patientCodePrefix), actor.id]);
    });
    await this.audit.record(actor.id, 'SETTINGS_UPDATED', 'AppSettings');
    return { updated: true };
  }
}
