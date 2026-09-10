ALTER TABLE users ADD COLUMN IF NOT EXISTS clinician_dni_cipher bytea;
ALTER TABLE users ADD COLUMN IF NOT EXISTS clinician_dni_hmac char(64);
ALTER TABLE users ADD COLUMN IF NOT EXISTS health_establishment text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_clinician_dni_hmac
  ON users(clinician_dni_hmac)
  WHERE clinician_dni_hmac IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_health_establishment
  ON users(health_establishment)
  WHERE role_code = 'CLINICIAN';
