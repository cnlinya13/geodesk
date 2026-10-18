-- 建表已合并入 001 基线。

-- Keep the business output bound to the task that claimed it.  The marker is
-- set in the same claim transaction as the diagnosis/question run starts and
-- is cleared only when the task completion transaction commits.  This lets
-- startup cleanup distinguish an accepted-but-not-started task from a crash
-- after business output was saved.

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
