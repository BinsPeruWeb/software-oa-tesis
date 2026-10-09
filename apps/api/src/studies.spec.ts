import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { StudiesController } from './studies';

const episodeId = '11111111-1111-4111-8111-111111111111';
const preflightId = '22222222-2222-4222-8222-222222222222';
const patientId = '33333333-3333-4333-8333-333333333333';
const clinician = { id: '44444444-4444-4444-8444-444444444444', role: 'CLINICIAN' } as never;
const file = { buffer: Buffer.from('verified-radiograph'), mimetype: 'image/png', originalname: 'radiograph.png' };

function setup(fileKind: 'DICOM' | 'RASTER' = 'RASTER', overrides: Record<string, unknown> = {}) {
  const client = { query: jest.fn(async (sql: string) => {
    if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 1 };
    return { rows: [{ id: `${client.query.mock.calls.length}` }], rowCount: 1 };
  }) };
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM image_preflight_reviews')) return { rows: [{
        id: preflightId, input_hash: createHash('sha256').update(file.buffer).digest('hex'),
        file_kind: fileKind, media_type: fileKind === 'DICOM' ? 'application/dicom' : 'image/png',
        review_status: 'ACCEPTED', supported: true, ...overrides,
      }] };
      if (sql.includes('FROM clinical_episodes')) return { rows: [{ patient_id: patientId }] };
      return { rows: [{ pain_score: 4, obesity: false, diabetes: false, hypertension: false,
        nicotine_use: false, trauma_lower_extremity: false }] };
    }),
    transaction: jest.fn(async (operation: (connection: typeof client) => Promise<unknown>) => operation(client)),
  };
  const assets = { write: jest.fn(async () => ({ storageKey: 'encrypted-image', size: file.buffer.length })) };
  const crypto = { encrypt: jest.fn(() => Buffer.from('encrypted-name')) };
  const audit = { record: jest.fn(async () => undefined) };
  const controller = new StudiesController(db as never, assets as never, crypto as never, audit as never);
  return { controller, client, db, assets, audit };
}

const input = (side: string, layout = 'bilateral') => ({
  preflightId, kneeSide: side, imageLayout: layout, examDate: '2026-01-10', invertPolarity: 'false', swapSides: 'false',
});

describe('Bilateral study upload', () => {
  it.each(['RASTER', 'DICOM'] as const)('creates independent episodes and jobs from one %s asset', async (kind) => {
    const { controller, client, assets } = setup(kind);
    const result = await controller.upload(episodeId, file, input('BOTH'), clinician);
    expect(result.analyses.map((analysis) => analysis.kneeSide)).toEqual(['R', 'L']);
    expect(new Set(result.analyses.map((analysis) => analysis.episodeId)).size).toBe(2);
    expect(new Set(result.analyses.map((analysis) => analysis.observationId)).size).toBe(2);
    expect(new Set(result.analyses.map((analysis) => analysis.jobId)).size).toBe(2);
    expect(result.episodeId).toBe(episodeId);
    expect(result.bilateralGroupId).toMatch(/^[a-f\d-]{36}$/);
    expect(assets.write).toHaveBeenCalledTimes(1);
    const calls = client.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls.filter(([sql]) => sql.includes('INSERT INTO stored_assets'))).toHaveLength(1);
    const studies = calls.filter(([sql]) => sql.includes('INSERT INTO radiographic_studies'));
    expect(studies).toHaveLength(2);
    expect(studies[0][1][1]).toBe(studies[1][1][1]);
    expect(calls.filter(([sql]) => sql.includes('INSERT INTO knee_observations')).map(([, values]) => values[1])).toEqual(['R', 'L']);
    expect(calls.filter(([sql]) => sql.includes('INSERT INTO clinical_observations'))).toHaveLength(2);
  });

  it.each(['L', 'R'])('preserves the single %s knee response and creates no extra episode', async (side) => {
    const { controller, client } = setup();
    const result = await controller.upload(episodeId, file, input(side, 'single'), clinician);
    expect(result.analyses).toHaveLength(1);
    expect(result.kneeSide).toBe(side);
    expect(result.bilateralGroupId).toBeNull();
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO clinical_episodes'))).toBe(false);
  });

  it('blocks BOTH for a single-knee ROI before storing an image', async () => {
    const { controller, assets, db } = setup();
    await expect(controller.upload(episodeId, file, input('BOTH', 'single'), clinician)).rejects.toThrow('radiografía bilateral');
    expect(assets.write).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [{ review_status: 'REJECTED' }, 'no es una radiografía'],
    [{ supported: false }, 'no es compatible'],
    [{ input_hash: 'changed' }, 'cambió después'],
  ])('preserves preflight protection for bilateral uploads', async (overrides, message) => {
    const { controller, assets } = setup('RASTER', overrides as Record<string, unknown>);
    await expect(controller.upload(episodeId, file, input('BOTH'), clinician)).rejects.toThrow(message as string);
    expect(assets.write).not.toHaveBeenCalled();
  });
});
