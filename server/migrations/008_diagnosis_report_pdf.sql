-- Store the rendered initial diagnosis report once so later downloads do not
-- spend browser CPU generating the same PDF again.
ALTER TABLE geo_diagnosis_runs
  ADD COLUMN IF NOT EXISTS report_pdf BYTEA,
  ADD COLUMN IF NOT EXISTS report_pdf_generated_at TIMESTAMPTZ;
