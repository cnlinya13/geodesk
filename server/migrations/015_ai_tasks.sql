CREATE TABLE IF NOT EXISTS geo_ai_tasks (
  id TEXT PRIMARY KEY,
  project_id BIGINT NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  result JSONB,
  CONSTRAINT geo_ai_tasks_kind_check CHECK (kind IN ('questions', 'diagnosis', 'diagnosis_report', 'monitoring', 'article_titles', 'article_body', 'content_audit')),
  CONSTRAINT geo_ai_tasks_status_check CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT geo_ai_tasks_completed_at_check CHECK ((status = 'running' AND completed_at IS NULL) OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)),
  CONSTRAINT geo_ai_tasks_error_check CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS geo_ai_tasks_project_started_idx
  ON geo_ai_tasks (project_id, started_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS geo_ai_tasks_project_operation_running_unique
  ON geo_ai_tasks (project_id, kind, COALESCE(target_id, ''))
  WHERE status = 'running';

ALTER TABLE geo_article_batches
  ADD COLUMN IF NOT EXISTS ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL;

ALTER TABLE geo_project_articles
  ADD COLUMN IF NOT EXISTS writing_ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL;

ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS content_audit_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL;

-- Keep the business output bound to the task that claimed it.  The marker is
-- set in the same claim transaction as the diagnosis/question run starts and
-- is cleared only when the task completion transaction commits.  This lets
-- startup cleanup distinguish an accepted-but-not-started task from a crash
-- after business output was saved.
ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS questions_generation_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL;

ALTER TABLE geo_diagnosis_runs
  ADD COLUMN IF NOT EXISTS diagnosis_ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS geo_article_batches_ai_task_idx
  ON geo_article_batches (ai_task_id)
  WHERE ai_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS geo_project_articles_writing_ai_task_idx
  ON geo_project_articles (writing_ai_task_id)
  WHERE writing_ai_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS geo_projects_questions_generation_task_idx
  ON geo_projects (questions_generation_task_id)
  WHERE questions_generation_task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_ai_task_idx
  ON geo_diagnosis_runs (diagnosis_ai_task_id)
  WHERE diagnosis_ai_task_id IS NOT NULL;
