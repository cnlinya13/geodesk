-- Persist the category emitted by the 10/6/4 question generator and the
-- per-question regeneration lock. Legacy questions remain uncategorized;
-- callers must explicitly regenerate them before using category-aware controls.
ALTER TABLE geo_project_questions
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = current_schema()::regnamespace
      AND conrelid = 'geo_project_questions'::regclass
      AND conname = 'geo_project_questions_category_check'
  ) THEN
    ALTER TABLE geo_project_questions
      ADD CONSTRAINT geo_project_questions_category_check
      CHECK (category IS NULL OR category IN ('recommendation', 'selection', 'decision'));
  END IF;
END $$;

-- A legacy globally confirmed set is immutable. Mirror that state to the new
-- per-row flag without touching its identity, position, body, or timestamps.
UPDATE geo_project_questions AS question
   SET is_locked = TRUE
  FROM geo_projects AS project
 WHERE project.id = question.project_id
   AND project.questions_locked_at IS NOT NULL
   AND question.is_locked = FALSE;
