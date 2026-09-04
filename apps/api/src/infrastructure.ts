import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Pool, PoolClient, QueryResultRow } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DatabaseService.name);
  readonly pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12 });
  private migration: Promise<void> | undefined;

  async onModuleInit() {
    await this.ensureInitialized();
  }

  private ensureInitialized() {
    this.migration ??= this.runMigrations();
    return this.migration;
  }

  private async runMigrations() {
    const directory = path.resolve(process.cwd(), 'migrations');
    const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(72100312)');
      for (const name of files) {
        await client.query('BEGIN');
        try {
          await client.query((await fs.readFile(path.join(directory, name))).toString('utf8'));
          await client.query(
            'INSERT INTO schema_migrations(name) VALUES($1) ON CONFLICT DO NOTHING',
            [name],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      this.logger.log('Migraciones de base de datos aplicadas');
    } finally {
      await client.query('SELECT pg_advisory_unlock(72100312)');
      client.release();
    }
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []) {
    await this.ensureInitialized();
    return this.pool.query<T>(sql, values);
  }

  async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.ensureInitialized();
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}

function keyFromEnv(name: string): Buffer {
  const value = process.env[name] ?? '';
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error(`${name} debe ser una clave aleatoria base64 de 32 bytes`);
  return key;
}

@Injectable()
export class CryptoService {
  private readonly encryptionKey = keyFromEnv('FIELD_ENCRYPTION_KEY');
  private readonly indexKey = keyFromEnv('BLIND_INDEX_KEY');

  encrypt(value: string | Buffer, context: string): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]);
  }

  decrypt(envelope: Buffer, context: string): Buffer {
    if (envelope[0] !== 1 || envelope.length < 30) throw new Error('Sobre cifrado inválido');
    const nonce = envelope.subarray(1, 13);
    const tag = envelope.subarray(13, 29);
    const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey, nonce);
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(envelope.subarray(29)), decipher.final()]);
  }

  decryptText(envelope: Buffer, context: string): string {
    return this.decrypt(envelope, context).toString('utf8');
  }

  blindIndex(value: string): string {
    return createHmac('sha256', this.indexKey)
      .update(value.trim().toLocaleUpperCase('es-AR'))
      .digest('hex');
  }
}

@Injectable()
export class AssetService {
  private readonly root = path.resolve(process.env.ASSET_ROOT ?? '/data/assets');
  constructor(private readonly crypto: CryptoService) {}

  async write(plaintext: Buffer): Promise<{ storageKey: string; size: number }> {
    const id = randomUUID();
    const storageKey = `${id.slice(0, 2)}/${id}.oaenc`;
    const destination = path.resolve(this.root, storageKey);
    if (!destination.startsWith(`${this.root}${path.sep}`)) throw new Error('Ruta de asset inválida');
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const envelope = this.crypto.encrypt(plaintext, `asset:${storageKey}`);
    await fs.writeFile(destination, envelope, { flag: 'wx', mode: 0o600 });
    return { storageKey, size: plaintext.length };
  }

  async read(storageKey: string): Promise<Buffer> {
    const source = path.resolve(this.root, storageKey);
    if (!source.startsWith(`${this.root}${path.sep}`)) throw new Error('Ruta de asset inválida');
    return this.crypto.decrypt(await fs.readFile(source), `asset:${storageKey}`);
  }
}

@Injectable()
export class AuditService {
  constructor(private readonly db: DatabaseService) {}
  async record(actorId: string | null, action: string, entityType: string, entityId?: string, metadata = {}) {
    await this.db.query(
      `INSERT INTO audit_events(actor_id, action, entity_type, entity_id, metadata)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [actorId, action, entityType, entityId ?? null, JSON.stringify(metadata)],
    );
  }
}
