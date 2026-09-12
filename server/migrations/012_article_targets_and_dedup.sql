-- Article plan targets and the simplified new/update workflow.
-- This migration is additive: existing rows keep their titles, bodies,
-- statuses and (possibly absent) target bindings.
ALTER TABLE geo_project_articles
  ADD COLUMN IF NOT EXISTS target_page_url TEXT,
  ADD COLUMN IF NOT EXISTS target_page_title TEXT;

-- Content-audit-only tasks have no diagnosis position.  Keep the legacy
-- single-position column for compatibility, but permit it to be NULL and
-- permit the validated positions array to be empty.
ALTER TABLE geo_project_articles
  ALTER COLUMN question_position DROP NOT NULL;

ALTER TABLE geo_project_articles
  DROP CONSTRAINT IF EXISTS geo_project_articles_question_position_check,
  ADD CONSTRAINT geo_project_articles_question_position_check
    CHECK (question_position IS NULL OR question_position BETWEEN 1 AND 20);

CREATE OR REPLACE FUNCTION geo_question_positions_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  item JSONB;
  numeric_position NUMERIC;
  position INTEGER;
  seen INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF jsonb_array_length(value) > 20 THEN
    RETURN FALSE;
  END IF;
  FOR item IN SELECT element FROM jsonb_array_elements(value) AS elements(element) LOOP
    IF jsonb_typeof(item) <> 'number' THEN
      RETURN FALSE;
    END IF;
    BEGIN
      numeric_position := (item::TEXT)::NUMERIC;
    EXCEPTION WHEN OTHERS THEN
      RETURN FALSE;
    END;
    IF numeric_position <> trunc(numeric_position)
       OR numeric_position < 1
       OR numeric_position > 20 THEN
      RETURN FALSE;
    END IF;
    position := numeric_position::INTEGER;
    IF position = ANY(seen) THEN
      RETURN FALSE;
    END IF;
    seen := array_append(seen, position);
  END LOOP;
  RETURN TRUE;
END;
$$;

ALTER TABLE geo_project_articles
  DROP CONSTRAINT IF EXISTS geo_project_articles_question_positions_check,
  ADD CONSTRAINT geo_project_articles_question_positions_check
    CHECK (geo_question_positions_valid(question_positions));

DROP INDEX IF EXISTS geo_project_articles_project_title_unique;

CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_title_unique
  ON geo_project_articles (project_id, lower(title))
  WHERE publish_status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_target_unique
  ON geo_project_articles (project_id, target_page_url)
  WHERE publish_status = 'pending' AND target_page_url IS NOT NULL;
