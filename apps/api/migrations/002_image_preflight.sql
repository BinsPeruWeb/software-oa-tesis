CREATE TABLE IF NOT EXISTS image_preflight_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  input_hash char(64) NOT NULL,
  file_kind text NOT NULL CHECK (file_kind IN ('DICOM','RASTER')),
  media_type text NOT NULL CHECK (media_type IN ('application/dicom','image/png','image/jpeg')),
  review_status text NOT NULL CHECK (review_status IN ('ACCEPTED','REJECTED','REVIEW_REQUIRED','UNAVAILABLE')),
  suggested_layout text NOT NULL CHECK (suggested_layout IN ('bilateral','single','uncertain')),
  supported boolean NOT NULL,
  provider_model text NOT NULL,
  provider_request_id text,
  cost_usd numeric(12,8),
  assessment jsonb,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes'
);

ALTER TABLE radiographic_studies ADD COLUMN IF NOT EXISTS preflight_id uuid;

DO $$
BEGIN
  ALTER TABLE radiographic_studies
    ADD CONSTRAINT radiographic_studies_preflight_fk
    FOREIGN KEY (preflight_id) REFERENCES image_preflight_reviews(id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_preflight_hash_user
  ON image_preflight_reviews(input_hash, created_by, expires_at DESC);
