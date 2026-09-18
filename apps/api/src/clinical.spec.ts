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
