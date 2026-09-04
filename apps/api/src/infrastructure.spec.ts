import { beforeEach, describe, expect, it, jest } from '@jest/globals';

describe('CryptoService', () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    process.env.BLIND_INDEX_KEY = Buffer.alloc(32, 9).toString('base64');
    jest.resetModules();
  });

  it('uses randomized authenticated encryption and deterministic blind indexes', async () => {
    const { CryptoService } = await import('./infrastructure');
    const service = new CryptoService();
    const first = service.encrypt('12345678', 'patient:test:dni');
    const second = service.encrypt('12345678', 'patient:test:dni');
    expect(first.equals(second)).toBe(false);
    expect(service.decryptText(first, 'patient:test:dni')).toBe('12345678');
    expect(() => service.decryptText(first, 'patient:other:dni')).toThrow();
    expect(service.blindIndex(' ab-12 ')).toBe(service.blindIndex('AB-12'));
  });
});

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vector truncated to six digits', async () => {
    const { totp } = await import('./auth');
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000)).toBe('287082');
  });
});
