CREATE TABLE IF NOT EXISTS patient_clinical_profiles (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  pain_score numeric CHECK (pain_score BETWEEN 0 AND 10),
  obesity boolean NOT NULL,
  diabetes boolean NOT NULL,
  hypertension boolean NOT NULL,
  nicotine_use boolean NOT NULL,
  trauma_lower_extremity boolean NOT NULL,
  updated_by uuid NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_patient_profile_updated ON patient_clinical_profiles(updated_at DESC);
