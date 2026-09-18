CREATE TABLE IF NOT EXISTS clinical_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES knee_observations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('STUDY','PATIENT')),
  content_cipher bytea NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'STUDY' AND observation_id IS NOT NULL) OR
    (scope = 'PATIENT' AND observation_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS clinical_notes_study_unique
  ON clinical_notes(observation_id) WHERE scope = 'STUDY';

CREATE UNIQUE INDEX IF NOT EXISTS clinical_notes_patient_unique
  ON clinical_notes(patient_id) WHERE scope = 'PATIENT';

CREATE INDEX IF NOT EXISTS clinical_notes_patient_date_idx
  ON clinical_notes(patient_id, updated_at DESC);
