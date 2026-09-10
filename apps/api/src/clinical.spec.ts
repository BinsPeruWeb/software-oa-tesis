import { describe, expect, it } from '@jest/globals';
import { ClinicalController } from './clinical';

describe('Clinical report PDF', () => {
  it('keeps a complete single-study report on one non-empty page', async () => {
    const controller = new ClinicalController(undefined as never, undefined as never, undefined as never, undefined as never);
    const pdf = await (controller as any).makePdf({
      organization: { name: 'Clínica OA', reportSubtitle: 'Evaluación de osteoartritis' },
      reportType: 'EPISODE', episodeId: '12345678-0000-0000-0000-000000000000',
      patientName: 'Paciente sintético de validación', mrn: 'OA-000001', dni: '00000000',
      birthDate: '1960-01-01', sex: 'female', clinician: 'Médico de validación', history: [],
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
    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [])).toHaveLength(1);
    expect(pdf.length).toBeGreaterThan(2_000);
  });

  it('uses exactly one page per study in a longitudinal report', async () => {
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
      studies: [study, { ...study, exam_date: '2026-12-18', knee_side: 'L' }],
    });

    expect((pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? [])).toHaveLength(2);
  });
});
