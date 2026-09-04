import { BadGatewayException, HttpException, HttpStatus, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { CryptoService } from './infrastructure';
import { dateOfBirth, personName } from './validation';

type PeruDevsResponse = {
  estado?: boolean;
  mensaje?: string;
  resultado?: {
    id?: string;
    nombres?: string;
    apellido_paterno?: string;
    apellido_materno?: string;
    genero?: string;
    fecha_nacimiento?: string;
  };
};

export type IdentityLookup = {
  found: boolean;
  names?: string;
  surnames?: string;
  sex?: 'female' | 'male' | null;
  birthDate?: string | null;
};

@Injectable()
export class PeruDevsService {
  private readonly cache = new Map<string, { expires: number; value: IdentityLookup }>();
  private readonly windows = new Map<string, { count: number; reset: number }>();
  constructor(private readonly crypto: CryptoService) {}

  private rateLimit(userId: string) {
    const now = Date.now();
    const existing = this.windows.get(userId);
    const window = !existing || existing.reset < now ? { count: 0, reset: now + 60_000 } : existing;
    window.count += 1;
    this.windows.set(userId, window);
    if (window.count > 10) throw new HttpException('Demasiadas consultas de DNI; espere un minuto', HttpStatus.TOO_MANY_REQUESTS);
  }

  async lookup(document: string, userId: string): Promise<IdentityLookup> {
    this.rateLimit(userId);
    const cacheKey = this.crypto.blindIndex(`dni-lookup:${document}`);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    const key = process.env.PERUDEVS_API_KEY ?? '';
    if (key.length < 20) throw new ServiceUnavailableException('La consulta de DNI no está configurada');
    const url = new URL(process.env.PERUDEVS_BASE_URL ?? 'https://api.perudevs.com/api/v1/dni/complete');
    url.searchParams.set('document', document);
    url.searchParams.set('key', key);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } });
    } catch {
      throw new ServiceUnavailableException('El proveedor de identidad no está disponible');
    }
    if (!response.ok) throw new BadGatewayException('El proveedor de identidad rechazó la consulta');
    let payload: PeruDevsResponse;
    try { payload = await response.json() as PeruDevsResponse; } catch { throw new BadGatewayException('Respuesta inválida del proveedor de identidad'); }
    if (!payload.estado || !payload.resultado) {
      const value = { found: false };
      this.cache.set(cacheKey, { expires: Date.now() + 60_000, value });
      return value;
    }
    if (payload.resultado.id && payload.resultado.id !== document) {
      throw new BadGatewayException('El proveedor devolvió un documento diferente');
    }
    let names: string; let surnames: string;
    try {
      names = personName(payload.resultado.nombres, 'Nombres');
      surnames = personName(`${payload.resultado.apellido_paterno ?? ''} ${payload.resultado.apellido_materno ?? ''}`, 'Apellidos');
    } catch { throw new BadGatewayException('El proveedor devolvió datos personales inválidos'); }
    const rawDate = payload.resultado.fecha_nacimiento ?? '';
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(rawDate);
    let birthDate: string | null = null;
    if (match) {
      try { birthDate = dateOfBirth(`${match[3]}-${match[2]}-${match[1]}`); }
      catch { throw new BadGatewayException('El proveedor devolvió una fecha de nacimiento inválida'); }
    }
    const gender = (payload.resultado.genero ?? '').toUpperCase();
    const value: IdentityLookup = {
      found: true, names, surnames,
      sex: gender === 'F' ? 'female' : gender === 'M' ? 'male' : null,
      birthDate,
    };
    this.cache.set(cacheKey, { expires: Date.now() + 10 * 60_000, value });
    return value;
  }
}
