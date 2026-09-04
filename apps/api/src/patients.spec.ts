import { describe, expect, it, jest } from '@jest/globals';
import { PatientsController } from './patients';

describe('Patient analysis readiness', () => {
  it('does not create an episode when the clinical history is incomplete', async () => {
    const patients = { get: jest.fn(async () => ({ id: 'patient-id' })) };
    const db = { query: jest.fn(async () => ({ rowCount: 0, rows: [] })) };
    const controller = new PatientsController(patients as never, undefined as never, db as never, undefined as never);

    await expect(controller.episode('patient-id', { openedAt: '2026-09-04' }, { id: 'clinician-id' } as never))
      .rejects.toThrow('Complete la historia clínica antes de iniciar un análisis');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
