CREATE SEQUENCE IF NOT EXISTS patient_code_seq START WITH 1;

ALTER TABLE users ADD COLUMN IF NOT EXISTS professional_license text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS specialty text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE patients ADD COLUMN IF NOT EXISTS owner_clinician_id uuid REFERENCES users(id) ON DELETE RESTRICT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS archived_at timestamptz;
UPDATE patients SET owner_clinician_id=created_by WHERE owner_clinician_id IS NULL;
ALTER TABLE patients ALTER COLUMN owner_clinician_id SET NOT NULL;

ALTER TABLE draft_reports ADD COLUMN IF NOT EXISTS report_type text NOT NULL DEFAULT 'EPISODE';
ALTER TABLE draft_reports DROP CONSTRAINT IF EXISTS draft_reports_report_type_check;
ALTER TABLE draft_reports ADD CONSTRAINT draft_reports_report_type_check CHECK (report_type IN ('EPISODE','LONGITUDINAL'));

CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO app_settings(key,value) VALUES
  ('organization', '{"name":"Clínica OA","reportSubtitle":"Evaluación experimental de osteoartritis"}'::jsonb),
  ('patientCode', '{"prefix":"OA","digits":6}'::jsonb)
ON CONFLICT(key) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_patients_owner_active ON patients(owner_clinician_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_role_active ON users(role_code, active, created_at DESC);
