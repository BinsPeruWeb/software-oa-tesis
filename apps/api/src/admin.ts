import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import argon2 from 'argon2';
import { AdminGuard, AuthUser, CsrfGuard, CurrentUser, SessionGuard } from './auth';
import { AuditService, DatabaseService } from './infrastructure';

@Controller('api/admin')
@UseGuards(SessionGuard, CsrfGuard, AdminGuard)
export class AdminController {
  constructor(private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Post('users')
  async user(@Body() body: { email?: string; displayName?: string; password?: string; role?: string }, @CurrentUser() actor: AuthUser) {
    if (!body.email || !body.displayName || !body.password || body.password.length < 14) throw new BadRequestException('Datos inválidos; contraseña mínima de 14 caracteres');
    if (!['CLINICIAN', 'ADMIN'].includes(body.role ?? '')) throw new BadRequestException('Rol inválido');
    const hash = await argon2.hash(body.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    const result = await this.db.query<{ id: string }>(
      `INSERT INTO users(email,display_name,password_hash,role_code) VALUES($1,$2,$3,$4) RETURNING id`,
      [body.email.trim().toLowerCase(), body.displayName.trim(), hash, body.role],
    );
    await this.audit.record(actor.id, 'USER_CREATED', 'User', result.rows[0].id, { role: body.role });
    return { id: result.rows[0].id };
  }

  @Get('audit')
  async events() {
    return (await this.db.query(
      `SELECT id,actor_id "actorId",action,entity_type "entityType",entity_id "entityId",metadata,occurred_at "occurredAt"
       FROM audit_events ORDER BY id DESC LIMIT 200`,
    )).rows;
  }
}

