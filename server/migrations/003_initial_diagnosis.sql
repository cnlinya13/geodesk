-- 约束变更已合并入 001 基线（SQLite 不支持 ALTER TABLE ADD/DROP CONSTRAINT）。
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_project_idx ON geo_diagnosis_runs (project_id, id DESC);

CREATE INDEX IF NOT EXISTS geo_diagnosis_answers_run_idx ON geo_diagnosis_answers (run_id, position);
