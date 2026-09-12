-- Keep the latest valid website-internal content-audit records independently
-- of the one current lifecycle record.  This is deliberately a JSONB array:
-- it preserves the existing project boundary without adding a history API or
-- a second business table.  The current record remains the only value used
-- for generation eligibility.
ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS content_audit_history JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE connamespace = current_schema()::regnamespace
      AND conrelid = 'geo_projects'::regclass
      AND conname = 'geo_projects_content_audit_history_array_check'
  ) THEN
    ALTER TABLE geo_projects
      ADD CONSTRAINT geo_projects_content_audit_history_array_check
      CHECK (jsonb_typeof(content_audit_history) = 'array');
  END IF;
END $$;

-- Only backfill a result whose persisted shape proves that the old run was a
-- complete successful website-internal check.  Incomplete/failed/legacy
-- external records are intentionally not promoted into history.
UPDATE geo_projects
SET content_audit_history = coalesce(content_audit_history, '[]'::jsonb)
  || jsonb_build_array(
    content_audit - 'checkpoint' - 'previousResult' - 'previousCompletedAt'
  )
WHERE jsonb_typeof(content_audit) = 'object'
  AND content_audit->>'status' = 'completed'
  AND content_audit->>'completedAt' IS NOT NULL
  AND btrim(content_audit->>'completedAt') <> ''
  AND content_audit ? 'error'
  AND content_audit->>'error' IS NULL
  AND CASE
        WHEN jsonb_typeof(content_audit->'executionErrors') = 'array'
          THEN jsonb_array_length(content_audit->'executionErrors') = 0
        ELSE FALSE
      END
  AND jsonb_typeof(content_audit->'result') = 'object'
  AND content_audit->'result'->>'scope' = 'website_internal'
  AND jsonb_typeof(content_audit->'progress') = 'object'
  AND content_audit->'progress'->>'processedPages' ~ '^[0-9]+$'
  AND content_audit->'progress'->>'totalPages' ~ '^[0-9]+$'
  AND content_audit->'progress'->>'processedClaims' ~ '^[0-9]+$'
  AND content_audit->'progress'->>'totalClaims' ~ '^[0-9]+$'
  AND CASE
        WHEN content_audit->'progress'->>'processedPages' ~ '^[0-9]+$'
         AND content_audit->'progress'->>'totalPages' ~ '^[0-9]+$'
          THEN (content_audit->'progress'->>'processedPages')::numeric
             = (content_audit->'progress'->>'totalPages')::numeric
        ELSE FALSE
      END
  AND CASE
        WHEN content_audit->'progress'->>'processedClaims' ~ '^[0-9]+$'
         AND content_audit->'progress'->>'totalClaims' ~ '^[0-9]+$'
          THEN (content_audit->'progress'->>'processedClaims')::numeric
             = (content_audit->'progress'->>'totalClaims')::numeric
        ELSE FALSE
      END
  AND CASE
        WHEN jsonb_typeof(content_audit->'result'->'items') = 'array'
         AND content_audit->'progress'->>'processedClaims' ~ '^[0-9]+$'
          THEN jsonb_array_length(content_audit->'result'->'items')::numeric
             <= (content_audit->'progress'->>'processedClaims')::numeric
        ELSE FALSE
      END
  AND jsonb_typeof(coalesce(content_audit_history, '[]'::jsonb)) = 'array'
  AND (
    content_audit_task_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM geo_ai_tasks AS task
      WHERE task.id = content_audit_task_id
        AND task.status <> 'completed'
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(coalesce(content_audit_history, '[]'::jsonb)) = 'array'
          THEN coalesce(content_audit_history, '[]'::jsonb)
        ELSE '[]'::jsonb
      END
    ) AS prior
    WHERE prior->>'startedAt' = content_audit->>'startedAt'
  );
