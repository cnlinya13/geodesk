-- Persist the lifecycle of the one current initial-diagnosis report.  The
-- binary remains on geo_diagnosis_runs.report_pdf; these fields distinguish a
-- report that is being prepared from a ready report, so an old binary cannot
-- be downloaded while a website refresh is in progress or has failed.

-- 约束变更已合并入 001 基线；pg 特有的二进制回填（octet_length/decode）在 SQLite 基线中不需要。
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_report_refresh_idx
  ON geo_diagnosis_runs (project_id, run_type, report_refresh_status);
