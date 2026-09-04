CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS roles (
  code text PRIMARY KEY CHECK (code IN ('CLINICIAN', 'ADMIN')),
  description text NOT NULL
);
INSERT INTO roles(code, description) VALUES
  ('CLINICIAN', 'Profesional clínico'), ('ADMIN', 'Administrador técnico')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  role_code text NOT NULL REFERENCES roles(code),
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_credentials (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_cipher bytea NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  medical_record_cipher bytea NOT NULL,
  medical_record_hmac char(64) NOT NULL UNIQUE,
  dni_cipher bytea NOT NULL,
  dni_hmac char(64) NOT NULL UNIQUE,
  names_cipher bytea NOT NULL,
  surnames_cipher bytea NOT NULL,
  birth_date_cipher bytea NOT NULL,
  sex_cipher bytea,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS patient_contacts (
  patient_id uuid PRIMARY KEY REFERENCES patients(id) ON DELETE CASCADE,
  phone_cipher bytea NOT NULL,
  email_cipher bytea
);

CREATE TABLE IF NOT EXISTS clinical_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  opened_at date NOT NULL,
  status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stored_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('RADIOGRAPH','GRADCAM','REPORT')),
  storage_key text NOT NULL UNIQUE,
  content_type text NOT NULL,
  original_name_cipher bytea,
  plaintext_sha256 char(64) NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS radiographic_studies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES clinical_episodes(id) ON DELETE CASCADE,
  asset_id uuid NOT NULL REFERENCES stored_assets(id) ON DELETE RESTRICT,
  exam_date date NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('DICOM_BILATERAL','RASTER_BILATERAL','RASTER_SINGLE_ROI')),
  projection_confirmed boolean NOT NULL,
  weight_bearing_confirmed boolean NOT NULL,
  orientation_confirmed boolean NOT NULL,
  metadata_inverted boolean NOT NULL DEFAULT false,
  horizontal_flip boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knee_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  study_id uuid NOT NULL REFERENCES radiographic_studies(id) ON DELETE CASCADE,
  knee_side char(1) NOT NULL CHECK (knee_side IN ('L','R')),
  UNIQUE(study_id, knee_side)
);

CREATE TABLE IF NOT EXISTS inference_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL REFERENCES knee_observations(id) ON DELETE CASCADE,
  job_type text NOT NULL CHECK (job_type IN ('KL','GRADCAM')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  idempotency_key text NOT NULL UNIQUE,
  attempts integer NOT NULL DEFAULT 0,
  error_code text,
  correlation_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz
);

CREATE TABLE IF NOT EXISTS model_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid UNIQUE REFERENCES inference_jobs(id) ON DELETE RESTRICT,
  observation_id uuid NOT NULL REFERENCES knee_observations(id) ON DELETE RESTRICT,
  model_name text NOT NULL,
  model_version text NOT NULL,
  artifact_hashes jsonb NOT NULL,
  input_hash char(64) NOT NULL,
  input_source text NOT NULL,
  knee_side char(1) NOT NULL,
  probabilities jsonb NOT NULL,
  threshold double precision,
  screen_positive boolean,
  kl_origin text,
  latency_ms double precision,
  device text NOT NULL,
  correlation_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gradcam_explanations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL REFERENCES model_predictions(id) ON DELETE CASCADE,
  backbone text NOT NULL,
  asset_id uuid NOT NULL REFERENCES stored_assets(id) ON DELETE RESTRICT,
  target_kl smallint NOT NULL CHECK (target_kl BETWEEN 0 AND 4)
  ,UNIQUE(prediction_id, backbone)
);

CREATE TABLE IF NOT EXISTS clinician_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_id uuid NOT NULL REFERENCES model_predictions(id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('CONFIRMED','CORRECTED','REJECTED')),
  confirmed_kl smallint CHECK (confirmed_kl BETWEEN 0 AND 4),
  reason text,
  reviewed_by uuid NOT NULL REFERENCES users(id),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((decision = 'REJECTED' AND confirmed_kl IS NULL) OR (decision <> 'REJECTED' AND confirmed_kl IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS clinical_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  knee_observation_id uuid NOT NULL UNIQUE REFERENCES knee_observations(id) ON DELETE CASCADE,
  pain_score numeric CHECK (pain_score BETWEEN 0 AND 10),
  obesity boolean NOT NULL,
  diabetes boolean NOT NULL,
  hypertension boolean NOT NULL,
  nicotine_use boolean NOT NULL,
  trauma_lower_extremity boolean NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prior_exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  knee_side char(1) NOT NULL CHECK (knee_side IN ('L','R')),
  exam_date date NOT NULL,
  confirmed_kl smallint NOT NULL CHECK (confirmed_kl BETWEEN 0 AND 4),
  pain_score numeric CHECK (pain_score BETWEEN 0 AND 10),
  obesity boolean NOT NULL,
  diabetes boolean NOT NULL,
  hypertension boolean NOT NULL,
  nicotine_use boolean NOT NULL,
  trauma_lower_extremity boolean NOT NULL,
  recorded_by uuid NOT NULL REFERENCES users(id),
  UNIQUE(patient_id, knee_side, exam_date)
);

CREATE TABLE IF NOT EXISTS draft_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id uuid NOT NULL REFERENCES clinical_episodes(id) ON DELETE RESTRICT,
  asset_id uuid NOT NULL REFERENCES stored_assets(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status = 'DRAFT'),
  generated_by uuid NOT NULL REFERENCES users(id),
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  correlation_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION prevent_audit_mutation() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'audit_events is append-only'; END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_events_append_only ON audit_events;
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_mutation();

CREATE INDEX IF NOT EXISTS idx_jobs_claim ON inference_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_episode_patient ON clinical_episodes(patient_id, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_prior_patient_knee ON prior_exams(patient_id, knee_side, exam_date);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_type, entity_id, occurred_at DESC);
