import {
  Body, CanActivate, Controller, createParamDecorator, ExecutionContext, ForbiddenException,
  Get, Injectable, OnModuleInit, Post, Req, Res, UnauthorizedException, UseGuards,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import type { Request, Response } from 'express';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { AuditService, CryptoService, DatabaseService } from './infrastructure';
import { email as validatedEmail } from './validation';

export interface AuthUser { id: string; email: string; displayName: string; role: 'CLINICIAN' | 'ADMIN'; sessionId: string }
type UserRow = { id: string; email: string; display_name: string; password_hash: string; role_code: AuthUser['role']; active: boolean; failed_attempts: number; locked_until: Date | null };

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function encodeBase32(bytes: Buffer) {
  let bits = ''; for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  return bits.match(/.{1,5}/g)!.map((group) => BASE32[parseInt(group.padEnd(5, '0'), 2)]).join('');
}
function decodeBase32(value: string) {
  const bits = [...value.replace(/=+$/g, '').toUpperCase()].map((char) => {
    const index = BASE32.indexOf(char); if (index < 0) throw new Error('Base32 inválido');
    return index.toString(2).padStart(5, '0');
  }).join('');
  return Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
}
export function totp(secret: string, instant = Date.now()) {
  const counter = Math.floor(instant / 30_000); const message = Buffer.alloc(8); message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest(); const offset = digest[19] & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return number.toString().padStart(6, '0');
}
function checkTotp(code: string, secret: string) {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((window) => timingSafeEqual(Buffer.from(code), Buffer.from(totp(secret, Date.now() + window * 30_000))));
}
function totpUri(email: string, secret: string) {
  const issuer = 'OA Tesis';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${email}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  return context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
});

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly db: DatabaseService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request & { user: AuthUser }>();
    const token = request.cookies?.oa_session;
    if (!token) throw new UnauthorizedException('Sesión requerida');
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; sid: string; scope: string }>(token);
      if (payload.scope !== 'session') throw new Error('scope');
      const result = await this.db.query<UserRow & { session_id: string }>(
        `SELECT u.*, s.id session_id FROM users u JOIN sessions s ON s.user_id=u.id
         WHERE u.id=$1 AND s.id=$2 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.active`,
        [payload.sub, payload.sid],
      );
      const row = result.rows[0];
      if (!row) throw new Error('session');
      request.user = { id: row.id, email: row.email, displayName: row.display_name, role: row.role_code, sessionId: row.session_id };
      await this.db.query('UPDATE sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
      return true;
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }
  }
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    const header = request.headers['x-csrf-token'];
    const cookie = request.cookies?.oa_csrf;
    if (!header || typeof header !== 'string' || header !== cookie) throw new ForbiddenException('CSRF inválido');
    return true;
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (user?.role !== 'ADMIN') throw new ForbiddenException('Rol de administrador requerido');
    return true;
  }
}

@Injectable()
export class ClinicianGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const user = context.switchToHttp().getRequest<Request & { user: AuthUser }>().user;
    if (user?.role !== 'CLINICIAN') throw new ForbiddenException('Rol médico requerido');
    return true;
  }
}

@Injectable()
export class AuthService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly crypto: CryptoService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
  ) {}

  async onModuleInit() {
    const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const local = process.env.DEPLOYMENT_ENV === 'local';
    if (!email || !password || password.length < (local ? 8 : 14)) throw new Error('Credenciales bootstrap inválidas');
    const exists = await this.db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (!exists.rowCount) {
      const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      await this.db.query(
        `INSERT INTO users(email,display_name,password_hash,role_code) VALUES($1,'Administrador técnico',$2,'ADMIN')`,
        [email, hash],
      );
    } else if (local && process.env.RESET_BOOTSTRAP_ADMIN_PASSWORD === 'true') {
      const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
      await this.db.query('UPDATE users SET password_hash=$2,failed_attempts=0,locked_until=NULL,updated_at=now() WHERE email=$1 AND role_code=\'ADMIN\'', [email, hash]);
    }
  }

  private async issueSession(user: UserRow) {
    const session = await this.db.query<{ id: string }>(
      `INSERT INTO sessions(user_id,expires_at) VALUES($1,now()+interval '8 hours') RETURNING id`, [user.id],
    );
    const sessionId = session.rows[0].id;
    const token = await this.jwt.signAsync({ sub: user.id, sid: sessionId, scope: 'session' }, { expiresIn: '8h' });
    return { token, csrf: randomBytes(32).toString('base64url'), sessionId };
  }

  async login(email: string, password: string) {
    const result = await this.db.query<UserRow>('SELECT * FROM users WHERE email=$1', [email.trim().toLowerCase()]);
    const user = result.rows[0];
    if (!user || !user.active || (user.locked_until && user.locked_until > new Date()) || !(await argon2.verify(user.password_hash, password))) {
      if (user) await this.db.query(
        `UPDATE users SET failed_attempts=failed_attempts+1,
         locked_until=CASE WHEN failed_attempts+1>=5 THEN now()+interval '15 minutes' ELSE locked_until END WHERE id=$1`, [user.id],
      );
      throw new UnauthorizedException('Credenciales inválidas');
    }
    await this.db.query('UPDATE users SET failed_attempts=0,locked_until=NULL WHERE id=$1', [user.id]);
    if (user.role_code === 'CLINICIAN' && process.env.CLINICIAN_MFA_REQUIRED !== 'true') {
      const session = await this.issueSession(user);
      await this.audit.record(user.id, 'AUTH_CLINICIAN_OK', 'Session', session.sessionId, { mfa: false });
      return { authenticated: true as const, ...session };
    }
    let credential = (await this.db.query<{ secret_cipher: Buffer; enabled: boolean }>('SELECT * FROM mfa_credentials WHERE user_id=$1', [user.id])).rows[0];
    let enrollment: { secret: string; otpauthUrl: string } | undefined;
    if (!credential) {
      const secret = encodeBase32(randomBytes(20));
      const encrypted = this.crypto.encrypt(secret, `mfa:${user.id}`);
      await this.db.query('INSERT INTO mfa_credentials(user_id,secret_cipher) VALUES($1,$2)', [user.id, encrypted]);
      credential = { secret_cipher: encrypted, enabled: false };
      enrollment = { secret, otpauthUrl: totpUri(user.email, secret) };
    } else if (!credential.enabled) {
      const secret = this.crypto.decryptText(credential.secret_cipher, `mfa:${user.id}`);
      enrollment = { secret, otpauthUrl: totpUri(user.email, secret) };
    }
    const challengeToken = await this.jwt.signAsync({ sub: user.id, scope: 'mfa' }, { expiresIn: '5m' });
    await this.audit.record(user.id, 'AUTH_PASSWORD_OK', 'User', user.id);
    return { challengeToken, mfaRequired: credential.enabled, enrollmentRequired: !credential.enabled, enrollment };
  }

  async verifyMfa(challengeToken: string, code: string) {
    let payload: { sub: string; scope: string };
    try { payload = await this.jwt.verifyAsync(challengeToken); } catch { throw new UnauthorizedException('Desafío expirado'); }
    if (payload.scope !== 'mfa') throw new UnauthorizedException('Desafío inválido');
    const result = await this.db.query<UserRow & { secret_cipher: Buffer }>(
      `SELECT u.*,m.secret_cipher FROM users u JOIN mfa_credentials m ON m.user_id=u.id WHERE u.id=$1 AND u.active`, [payload.sub],
    );
    const user = result.rows[0];
    if (!user) throw new UnauthorizedException('Usuario inválido');
    const secret = this.crypto.decryptText(user.secret_cipher, `mfa:${user.id}`);
    if (!checkTotp(code, secret)) throw new UnauthorizedException('Código TOTP inválido');
    await this.db.query('UPDATE mfa_credentials SET enabled=true,verified_at=COALESCE(verified_at,now()) WHERE user_id=$1', [user.id]);
    const session = await this.issueSession(user);
    await this.audit.record(user.id, 'AUTH_MFA_OK', 'Session', session.sessionId);
    return session;
  }
}

@Controller('api/auth')
export class AuthController {
  constructor(private readonly service: AuthService, private readonly db: DatabaseService, private readonly audit: AuditService) {}

  @Post('login')
  async login(@Body() body: { email?: string; password?: string }, @Res({ passthrough: true }) response: Response) {
    if (!body.password || body.password.length > 128) throw new UnauthorizedException('Credenciales requeridas');
    const result = await this.service.login(validatedEmail(body.email, true)!, body.password);
    if ('authenticated' in result) {
      this.setSessionCookies(response, result.token, result.csrf);
      return { authenticated: true };
    }
    return result;
  }

  private setSessionCookies(response: Response, token: string, csrf: string) {
    const secure = process.env.COOKIE_SECURE !== 'false';
    response.cookie('oa_session', token, { httpOnly: true, secure, sameSite: 'strict', maxAge: 8 * 3600_000, path: '/' });
    response.cookie('oa_csrf', csrf, { httpOnly: false, secure, sameSite: 'strict', maxAge: 8 * 3600_000, path: '/' });
  }

  @Post('mfa/verify')
  async verify(@Body() body: { challengeToken?: string; code?: string }, @Res({ passthrough: true }) response: Response) {
    if (!body.challengeToken || body.challengeToken.length > 4096 || !body.code || !/^\d{6}$/.test(body.code)) {
      throw new UnauthorizedException('Desafío y código requeridos');
    }
    const result = await this.service.verifyMfa(body.challengeToken, body.code);
    this.setSessionCookies(response, result.token, result.csrf);
    return { authenticated: true };
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentUser() user: AuthUser) { return user; }

  @Post('logout')
  @UseGuards(SessionGuard, CsrfGuard)
  async logout(@CurrentUser() user: AuthUser, @Res({ passthrough: true }) response: Response) {
    await this.db.query('UPDATE sessions SET revoked_at=now() WHERE id=$1', [user.sessionId]);
    await this.audit.record(user.id, 'LOGOUT', 'Session', user.sessionId);
    response.clearCookie('oa_session'); response.clearCookie('oa_csrf');
    return { loggedOut: true };
  }
}
