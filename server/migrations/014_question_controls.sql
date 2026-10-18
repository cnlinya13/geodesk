-- Persist the category emitted by the 10/6/4 question generator and the
-- per-question regeneration lock. Legacy questions remain uncategorized;
-- callers must explicitly regenerate them before using category-aware controls.

-- 约束变更已合并入 001 基线。
-- A legacy globally confirmed set is immutable. Mirror that state to the new
-- per-row flag without touching its identity, position, body, or timestamps.
UPDATE geo_project_questions AS question
   SET is_locked = 1
  FROM geo_projects AS project
 WHERE project.id = question.project_id
   AND project.questions_locked_at IS NOT NULL
   AND question.is_locked = 0;
