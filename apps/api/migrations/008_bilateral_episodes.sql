-- A bilateral upload keeps an independent episode for each knee.
-- Existing episodes retain NULL and continue to behave as individual uploads.
ALTER TABLE clinical_episodes ADD COLUMN IF NOT EXISTS bilateral_group_id uuid;
CREATE INDEX IF NOT EXISTS clinical_episodes_bilateral_group_idx
  ON clinical_episodes(patient_id, bilateral_group_id)
  WHERE bilateral_group_id IS NOT NULL;

ALTER TABLE draft_reports ADD COLUMN IF NOT EXISTS knee_side char(1)
  CHECK (knee_side IN ('L','R'));
