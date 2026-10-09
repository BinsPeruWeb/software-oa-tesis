import { describe, expect, it, jest } from '@jest/globals';
import { ClinicalController } from './clinical';

describe('Clinical report PDF', () => {
  it('uses one analysis page and one interpretation page for an episode report', async () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const pdf = await (controller as any).makePdf({
      organization: { name: 'Clínica OA', reportSubtitle: 'Evaluación de osteoartritis' },
      reportType: 'EPISODE', episodeId: '12345678-0000-0000-0000-000000000000',
      patientName: 'Paciente sintético de validación', mrn: 'OA-000001', dni: '00000000',
      birthDate: '1960-01-01', sex: 'female', clinician: 'Médico de validación', history: [],
      recommendation: {
        scope: 'STUDY', content: {
          headline: 'Osteoartritis de rodilla con hallazgos avanzados',
          summary: `El estudio muestra un grado KL elevado y una relación clínica que requiere valoración cuidadosa. ${'La interpretación integra imagen, síntomas y riesgos disponibles. '.repeat(12)}`.slice(0, 700),
          recommendation: `Se recomienda al médico correlacionar los hallazgos con la evaluación clínica y acordar con el paciente un seguimiento proporcional. ${'La orientación debe adaptarse a la evolución documentada y a la respuesta clínica. '.repeat(10)}`.slice(0, 700),
        },
      },
      note: { content: `Se conversó con el paciente sobre los resultados y el seguimiento clínico. ${'Se registraron acuerdos y observaciones relevantes para el próximo control. '.repeat(18)}`.slice(0, 1200) },
      studies: [{
        exam_date: '2026-09-04', knee_side: 'R', source_type: 'RASTER_BILATERAL', preview: null,
        clinical: { pain_score: 10, obesity: true, diabetes: true, hypertension: true, nicotine_use: true, trauma_lower_extremity: true },
        gradcams: [], predictions: [
          { model_name: 'Ensemble-v2', probabilities: { predictedKl: 3, confidence: .82, ensemble: { KL0: .01, KL1: .02, KL2: .05, KL3: .82, KL4: .10 }, members: {} }, confirmed_kl: 3 },
          { model_name: 'XGBoost-v2', probabilities: { probability: .31 }, screen_positive: true },
          { model_name: 'LSTM-v2', probabilities: { probability: .18 }, screen_positive: false },
        ],
      }],
    });

    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [])).toHaveLength(2);
    expect(pdf.length).toBeGreaterThan(2_000);
  });

  it('uses one page per study plus one general interpretation page in a longitudinal report', async () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const study = {
      exam_date: new Date('2026-09-04T00:00:00Z'), knee_side: 'R', source_type: 'DICOM_BILATERAL', preview: null,
      clinical: { pain_score: 4, obesity: false, diabetes: false, hypertension: true, nicotine_use: false, trauma_lower_extremity: false },
      gradcams: [], predictions: [
        { model_name: 'Ensemble-v2', probabilities: { predictedKl: 2, confidence: .74, ensemble: { KL0: .03, KL1: .08, KL2: .74, KL3: .11, KL4: .04 } }, confirmed_kl: 2 },
      ],
    };
    const pdf = await (controller as any).makePdf({
      organization: { name: 'Clínica OA' }, reportType: 'LONGITUDINAL',
      episodeId: '12345678-0000-0000-0000-000000000000', patientName: 'Paciente de validación',
      mrn: 'OA-000002', dni: '00000001', birthDate: '1965-02-08', sex: 'male',
      clinician: 'Médico de validación', history: [],
      recommendation: {
        scope: 'PATIENT', content: {
          headline: 'Evolución longitudinal de osteoartritis de rodilla',
          summary: 'La comparación cronológica permite valorar la estabilidad radiográfica y su relación con los síntomas registrados.',
          recommendation: 'Se recomienda revisar la evolución clínico-radiográfica y definir junto con el paciente el seguimiento más apropiado según síntomas, progresión y riesgos disponibles.',
        },
      },
      note: { content: 'Nota clínica general de seguimiento longitudinal.' },
      studies: [study, { ...study, exam_date: '2026-12-18', knee_side: 'L' }],
    });

    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [])).toHaveLength(3);
  });
});

describe('Clinical recommendation compatibility', () => {
  it('turns structured ML validation details into a readable error', () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const message = (controller as any).mlErrorMessage([
      {
        location: ['body', 'studies', 0, 'age_at_exam'],
        message: 'Input should be greater than or equal to 0',
        type: 'greater_than_equal',
      },
    ], 422);

    expect(message).toBe('La fecha del examen y la fecha de nacimiento son incompatibles para el análisis.');
    expect(message).not.toContain('[object Object]');
  });

  it('normalizes database dates and omits an impossible optional age for IA', async () => {
    const db = {
      query: jest.fn(async () => ({ rows: [{
        observationId: 'observation-id',
        examDate: new Date('2026-06-16T00:00:00.000Z'),
        kneeSide: 'R', klGrade: 2, confirmedKl: 2,
        birthDateCipher: Buffer.from('encrypted'), confidence: 0.8,
        painScore: 4, obesity: false, diabetes: false, hypertension: false,
        nicotineUse: false, traumaLowerExtremity: false,
        arthroplastyProbability: 0.1, progressionProbability: null,
      }] })),
    };
    const crypto = { decryptText: jest.fn(() => '2026-09-15') };
    const controller = new ClinicalController(db as never, crypto as never, undefined as never, undefined as never);

    const studies = await (controller as any).recommendationStudies('patient-id', 'doctor-id');

    expect(studies[0].exam_date).toBe('2026-06-16');
    expect(studies[0].age_at_exam).toBeNull();
  });

  it('converts legacy action lists into the current recommendation paragraph', () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const content = (controller as any).normalizeRecommendationContent({
      headline: 'Evolución de Artrosis de rodilla',
      summary: 'La artrosis muestra progresión.',
      actions: ['Correlacionar los hallazgos con la clínica.', 'Revisar el seguimiento con el paciente.'],
      priority: 'soon',
    });

    expect(content.headline).toBe('Evolución de Osteoartritis de rodilla');
    expect(content.summary).toBe('La osteoartritis muestra progresión.');
    expect(content.recommendation).toBe(
      'Se recomienda correlacionar los hallazgos con la clínica. Revisar el seguimiento con el paciente.',
    );
    expect(content.priority).toBe('soon');
  });
});

describe('Clinical chronology', () => {
  it('recomputes progression in exam-date order independently of upload order', async () => {
    const db = { query: jest.fn(async () => ({ rows: [{ id: 'old' }, { id: 'current' }, { id: 'new' }] })) };
    const controller = new ClinicalController(db as never, undefined as never, undefined as never, undefined as never);
    const context = (id: string) => ({ observation_id: id, patient_id: 'patient', knee_side: 'R' });
    (controller as any).currentContext = jest.fn(async (id: string) => context(id));
    const progressionFor = jest.fn(async (value: any) => ({ available: value.observation_id !== 'old' }));
    (controller as any).progressionFor = progressionFor;

    const values = await (controller as any).refreshProgressions('patient', 'R', { id: 'doctor' }, 'current');

    expect(progressionFor.mock.calls.map((call) => (call[0] as any).observation_id)).toEqual(['old', 'current', 'new']);
    expect(values.get('current')).toEqual({ available: true });
  });
});

describe('Bilateral episode navigation', () => {
  it('loads the sibling only within the owned patient and bilateral group', async () => {
    const episodeId = '11111111-1111-4111-8111-111111111111';
    const db = { query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT e.id "episodeId"') && !sql.includes('radiographic_studies')) {
        return { rows: [{ episodeId, patientId: 'patient', bilateralGroupId: 'group' }] };
      }
      if (sql.includes('radiographic_studies')) return { rows: [{ episodeId, kneeSide: 'R' }, { episodeId: 'sibling', kneeSide: 'L' }] };
      return { rows: [] };
    }) };
    const controller = new ClinicalController(db as never, undefined as never, undefined as never, undefined as never);
    (controller as any).studySummary = jest.fn(async (value: unknown) => value);
    const result = await controller.episodeAnalysis(episodeId, { id: 'doctor' } as never);
    expect(result.studies).toHaveLength(2);
    const calls = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
    expect(calls[0][1]).toEqual([episodeId, 'doctor']);
    expect(calls[1][0]).toContain('e.patient_id=$2');
    expect(calls[1][1]).toEqual([episodeId, 'patient', 'group']);
  });

  it('rejects access when the episode is not owned by the clinician', async () => {
    const db = { query: jest.fn(async () => ({ rows: [] })) };
    const controller = new ClinicalController(db as never, undefined as never, undefined as never, undefined as never);
    await expect(controller.episodeAnalysis('11111111-1111-4111-8111-111111111111', { id: 'other-doctor' } as never))
      .rejects.toThrow('Episodio no encontrado');
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('Bilateral report selection', () => {
  it.each(['R', 'L', 'ALL'])('filters analysis pages by %s while retaining the full patient interpretation', async (side) => {
    const episodeId = '11111111-1111-4111-8111-111111111111';
    const allStudies = [{ id: 'right', knee_side: 'R', observation_id: 'right-observation' }, { id: 'left', knee_side: 'L', observation_id: 'left-observation' }];
    const db = { query: jest.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT e.patient_id,e.opened_at')) return { rows: [{ patient_id: 'patient' }] };
      if (sql.includes('SELECT s.id,s.exam_date')) return { rows: allStudies.filter((study) => !values?.[3] || study.knee_side === values[3]) };
      if (sql.includes('INSERT INTO')) return { rows: [{ id: 'report-asset' }] };
      return { rows: [] };
    }) };
    const assets = { write: jest.fn(async () => ({ storageKey: 'pdf' })) };
    const crypto = { decryptText: jest.fn(() => 'test') };
    const controller = new ClinicalController(db as never, crypto as never, assets as never, { record: jest.fn(async () => undefined) } as never);
    (controller as any).renderRadiograph = jest.fn(async () => null);
    (controller as any).storedClinicalNote = jest.fn(async () => null);
    const semanticStudies = [{ observationId: 'right-observation', knee_side: 'R' }, { observationId: 'left-observation', knee_side: 'L' }];
    (controller as any).recommendationStudies = jest.fn(async () => semanticStudies);
    const generate = jest.fn(async () => ({ value: { scope: 'PATIENT', content: {} }, error: null }));
    (controller as any).generateRecommendation = generate;
    const pdf = jest.fn(async (_context: unknown) => Buffer.from('%PDF-test'));
    (controller as any).makePdf = pdf;
    await controller.report(episodeId, { reportType: 'LONGITUDINAL', kneeSide: side }, { id: 'doctor' } as never);
    const context = pdf.mock.calls[0][0] as any;
    expect(context.studies.map((study: any) => study.knee_side)).toEqual(side === 'ALL' ? ['R', 'L'] : [side]);
    expect(generate.mock.calls[0]).toEqual(['patient', 'PATIENT', semanticStudies, { id: 'doctor' }]);
    const calls = db.query.mock.calls as unknown as Array<[string, unknown[]]>;
    const studyQuery = calls.find(([sql]) => sql.includes('SELECT s.id,s.exam_date'))!;
    expect(studyQuery[0]).toContain('k.knee_side=$4');
    expect(studyQuery[0]).toContain('ORDER BY s.exam_date');
    expect(studyQuery[1][3]).toBe(side === 'ALL' ? null : side);
  });
});

describe('Concurrent bilateral recommendations', () => {
  it('serializes patient updates and reads the latest results after the earlier update', async () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const right = '11111111-1111-4111-8111-111111111111';
    const left = '22222222-2222-4222-8222-222222222222';
    (controller as any).currentContext = jest.fn(async () => ({ patient_id: 'patient' }));
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    (controller as any).recommendationStudies = jest.fn(async () => {
      reads += 1;
      return [{ observationId: right }, { observationId: left }, ...(reads > 1 ? [{ observationId: 'new-result' }] : [])];
    });
    const generalSizes: number[] = [];
    (controller as any).generateRecommendation = jest.fn(async (_patient: string, scope: string, studies: unknown[]) => {
      if (scope === 'PATIENT') { active += 1; maxActive = Math.max(maxActive, active); generalSizes.push(studies.length); }
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (scope === 'PATIENT') active -= 1;
      return { value: {}, updated: true, error: null };
    });
    await Promise.all([controller.recommendations(right, { id: 'doctor' } as never), controller.recommendations(left, { id: 'doctor' } as never)]);
    expect(maxActive).toBe(1);
    expect(generalSizes).toEqual([2, 3]);
    expect((controller as any).recommendationQueue.size).toBe(0);
  });
});
