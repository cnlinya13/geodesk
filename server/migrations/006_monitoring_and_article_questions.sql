-- The initial run remains round 0. Monitoring rounds are numbered from 1.

-- 约束变更与列定义终态已合并入 001 基线（SQLite 不支持 ALTER TABLE ADD/DROP CONSTRAINT / ALTER COLUMN）。
-- geo_question_positions_valid 改为 server/sqlite-pool.ts 注册的 SQLite 自定义函数。

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_round_unique
  ON geo_diagnosis_runs (project_id, round_number);

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_initial_unique
  ON geo_diagnosis_runs (project_id)
  WHERE run_type = 'initial';

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_one_unfinished_monitoring_unique
  ON geo_diagnosis_runs (project_id)
  WHERE run_type = 'monitoring' AND status IN ('running', 'analyzing', 'failed');

-- 空库基线中 question_positions 已有终态定义；此回填仅对历史库有意义。
UPDATE geo_project_articles
   SET question_positions = json_array(question_position)
 WHERE question_positions IS NULL;
