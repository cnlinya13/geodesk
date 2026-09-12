-- Persist the lifecycle of the one current initial-diagnosis report.  The
-- binary remains on geo_diagnosis_runs.report_pdf; these fields distinguish a
-- report that is being prepared from a ready report, so an old binary cannot
-- be downloaded while a website refresh is in progress or has failed.
ALTER TABLE geo_diagnosis_runs
  ADD COLUMN IF NOT EXISTS report_refresh_status TEXT NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS report_refresh_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS report_refresh_error TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'geo_diagnosis_runs_report_refresh_status_check'
  ) THEN
    ALTER TABLE geo_diagnosis_runs
      ADD CONSTRAINT geo_diagnosis_runs_report_refresh_status_check
      CHECK (report_refresh_status IN ('not_started', 'running', 'ready', 'failed'));
  END IF;
END $$;

-- Existing persisted browser reports are still the sole current report for
-- their run.  Mark only those completed initial reports ready; incomplete or
-- failed runs remain unavailable and will not be resurrected by migration.
UPDATE geo_diagnosis_runs
SET report_refresh_status = 'ready',
    report_refresh_error = NULL
WHERE run_type = 'initial'
  AND status = 'completed'
  AND report_pdf IS NOT NULL
  AND octet_length(report_pdf) >= 5
  AND substring(report_pdf FROM 1 FOR 5) = decode('255044462d', 'hex')
  AND report_refresh_status = 'not_started';

CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_report_refresh_idx
  ON geo_diagnosis_runs (project_id, run_type, report_refresh_status);
