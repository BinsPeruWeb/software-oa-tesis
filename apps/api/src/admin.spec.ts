import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { AdminController } from './admin';
import { CryptoService } from './infrastructure';

describe('AdminController - identidad médica', () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
    process.env.BLIND_INDEX_KEY = Buffer.alloc(32, 5).toString('base64');
  });

  function controller() {
    const db = { query: jest.fn() };
    const audit = { record: jest.fn().mockResolvedValue(undefined as never) };
    const identity = { lookup: jest.fn().mockResolvedValue({ found: true, names: 'ANA', surnames: 'TORRES RUIZ' } as never) };
    const instance = new AdminController(db as never, audit as never, identity as never, new CryptoService());
    return { instance, audit, identity };
  }

  it('permite al administrador consultar PeruDevs sin registrar el DNI en auditoría', async () => {
    const { instance, audit, identity } = controller();
    await expect(instance.lookupDni('12345678', { id: 'admin-id' } as never)).resolves.toMatchObject({ found: true });
    expect(identity.lookup).toHaveBeenCalledWith('12345678', 'admin-id');
    expect(audit.record).toHaveBeenCalledWith('admin-id', 'DNI_LOOKUP', 'ClinicianIdentityLookup', undefined, { found: true });
  });

  it('valida el formato del CMP antes de crear la cuenta médica', async () => {
    const { instance } = controller();
    await expect(instance.createClinician({
      dni: '12345678', displayName: 'Ana Torres Ruiz', email: 'ana@example.org',
      cmp: '12A', healthEstablishment: 'Hospital Regional', password: 'Luna-Rio-4827!',
    }, { id: 'admin-id' } as never)).rejects.toThrow('CMP');
  });
});
