-- Two-stage article workflow: persist titles first, then write one body at a time.
-- This migration is additive and safe to run once through the existing
-- schema_migrations runner. Existing full-body articles remain ready.
ALTER TABLE geo_project_articles
  ADD COLUMN IF NOT EXISTS writing_status TEXT,
  ADD COLUMN IF NOT EXISTS writing_error TEXT,
  ADD COLUMN IF NOT EXISTS writing_attempt_token TEXT,
  ADD COLUMN IF NOT EXISTS writing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS writing_lease_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS optimization_type TEXT,
  ADD COLUMN IF NOT EXISTS source_website_url TEXT,
  ADD COLUMN IF NOT EXISTS source_website_crawl_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS source_diagnosis_run_id BIGINT;

ALTER TABLE geo_project_articles
  ALTER COLUMN content_html DROP NOT NULL;

UPDATE geo_project_articles AS article
   SET writing_status = CASE WHEN article.content_html IS NULL THEN 'pending' ELSE 'ready' END,
       writing_error = CASE WHEN article.content_html IS NULL THEN article.writing_error ELSE NULL END,
       updated_at = COALESCE(article.updated_at, article.confirmed_at, article.generated_at, NOW()),
       optimization_type = COALESCE(NULLIF(BTRIM(article.optimization_type), ''), '未分类'),
       source_website_url = COALESCE(article.source_website_url, project.website_url),
       source_website_crawl_started_at = COALESCE(article.source_website_crawl_started_at, project.website_crawl_started_at)
  FROM geo_projects AS project
 WHERE project.id = article.project_id
   AND (article.writing_status IS NULL OR article.updated_at IS NULL OR article.optimization_type IS NULL OR BTRIM(article.optimization_type) = '');

ALTER TABLE geo_project_articles
  ALTER COLUMN writing_status SET DEFAULT 'pending',
  ALTER COLUMN writing_status SET NOT NULL,
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN optimization_type SET DEFAULT '未分类',
  ALTER COLUMN optimization_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE connamespace = current_schema()::regnamespace
                   AND conrelid = 'geo_project_articles'::regclass
                   AND conname = 'geo_project_articles_writing_status_check') THEN
    ALTER TABLE geo_project_articles ADD CONSTRAINT geo_project_articles_writing_status_check
      CHECK (writing_status IN ('pending', 'writing', 'ready', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE connamespace = current_schema()::regnamespace
                   AND conrelid = 'geo_project_articles'::regclass
                   AND conname = 'geo_project_articles_writing_content_check') THEN
    ALTER TABLE geo_project_articles ADD CONSTRAINT geo_project_articles_writing_content_check
      CHECK (writing_status <> 'ready' OR (content_html IS NOT NULL AND length(btrim(content_html)) > 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE connamespace = current_schema()::regnamespace
                   AND conrelid = 'geo_project_articles'::regclass
                   AND conname = 'geo_project_articles_optimization_type_not_blank') THEN
    ALTER TABLE geo_project_articles ADD CONSTRAINT geo_project_articles_optimization_type_not_blank
      CHECK (length(btrim(optimization_type)) > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE connamespace = current_schema()::regnamespace
                   AND conrelid = 'geo_project_articles'::regclass
                   AND conname = 'geo_project_articles_published_ready_check') THEN
    ALTER TABLE geo_project_articles ADD CONSTRAINT geo_project_articles_published_ready_check
      CHECK (publish_status <> 'published' OR (writing_status = 'ready' AND content_html IS NOT NULL AND length(btrim(content_html)) > 0));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS geo_project_articles_writing_lease_idx
  ON geo_project_articles (writing_status, writing_lease_expires_at)
  WHERE writing_status = 'writing';
