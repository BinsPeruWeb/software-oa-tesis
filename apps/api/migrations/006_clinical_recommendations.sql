CREATE TABLE IF NOT EXISTS clinical_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  observation_id uuid REFERENCES knee_observations(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('STUDY','PATIENT')),
  content_cipher bytea NOT NULL,
  provider_model text NOT NULL,
  provider_request_id text,
  input_hash char(64) NOT NULL,
  cost_usd numeric(12,8),
  generated_by uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (scope = 'STUDY' AND observation_id IS NOT NULL) OR
    (scope = 'PATIENT' AND observation_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS clinical_recommendations_study_unique
  ON clinical_recommendations(observation_id) WHERE scope = 'STUDY';

CREATE UNIQUE INDEX IF NOT EXISTS clinical_recommendations_patient_unique
  ON clinical_recommendations(patient_id) WHERE scope = 'PATIENT';

CREATE INDEX IF NOT EXISTS clinical_recommendations_patient_date_idx
  ON clinical_recommendations(patient_id, generated_at DESC);
