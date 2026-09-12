ALTER TABLE geo_diagnosis_runs
  ADD COLUMN IF NOT EXISTS requested_model TEXT;
