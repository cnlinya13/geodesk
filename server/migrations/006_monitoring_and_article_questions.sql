ALTER TABLE geo_diagnosis_runs
  ADD COLUMN IF NOT EXISTS round_number INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_article_count INTEGER;

-- The initial run remains round 0. Monitoring rounds are numbered from 1.
ALTER TABLE geo_diagnosis_runs
  DROP CONSTRAINT IF EXISTS geo_diagnosis_runs_project_type_unique,
  DROP CONSTRAINT IF EXISTS geo_diagnosis_runs_type_check;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'geo_diagnosis_runs_type_check') THEN
    ALTER TABLE geo_diagnosis_runs ADD CONSTRAINT geo_diagnosis_runs_type_check
      CHECK (run_type IN ('initial', 'monitoring'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'geo_diagnosis_runs_round_check') THEN
    ALTER TABLE geo_diagnosis_runs ADD CONSTRAINT geo_diagnosis_runs_round_check
      CHECK (
        (run_type = 'initial' AND round_number = 0)
        OR (run_type = 'monitoring' AND round_number > 0)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'geo_diagnosis_runs_published_article_count_check') THEN
    ALTER TABLE geo_diagnosis_runs ADD CONSTRAINT geo_diagnosis_runs_published_article_count_check
      CHECK (
        (run_type = 'initial' AND published_article_count IS NULL)
        OR (run_type = 'monitoring' AND published_article_count IS NOT NULL AND published_article_count >= 0)
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_round_unique
  ON geo_diagnosis_runs (project_id, round_number);

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_initial_unique
  ON geo_diagnosis_runs (project_id)
  WHERE run_type = 'initial';

CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_one_unfinished_monitoring_unique
  ON geo_diagnosis_runs (project_id)
  WHERE run_type = 'monitoring' AND status IN ('running', 'analyzing', 'failed');

-- Keep the old single-position column for compatibility, while exposing all
-- associated question positions to the application as a validated JSON array.
ALTER TABLE geo_project_articles
  ADD COLUMN IF NOT EXISTS question_positions JSONB;

UPDATE geo_project_articles
   SET question_positions = jsonb_build_array(question_position)
 WHERE question_positions IS NULL;

ALTER TABLE geo_project_articles
  ALTER COLUMN question_positions SET NOT NULL;

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
  IF jsonb_array_length(value) < 1 OR jsonb_array_length(value) > 20 THEN
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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'geo_project_articles_question_positions_check') THEN
    ALTER TABLE geo_project_articles ADD CONSTRAINT geo_project_articles_question_positions_check
      CHECK (geo_question_positions_valid(question_positions));
  END IF;
END $$;
