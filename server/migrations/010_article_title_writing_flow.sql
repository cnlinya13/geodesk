-- Two-stage article workflow: persist titles first, then write one body at a time.
-- This migration is additive and safe to run once through the existing
-- schema_migrations runner. Existing full-body articles remain ready.

-- 列定义终态已合并入 001 基线（SQLite 不支持 ALTER COLUMN）。
UPDATE geo_project_articles AS article
   SET writing_status = CASE WHEN article.content_html IS NULL THEN 'pending' ELSE 'ready' END,
       writing_error = CASE WHEN article.content_html IS NULL THEN article.writing_error ELSE NULL END,
       updated_at = COALESCE(article.updated_at, article.confirmed_at, article.generated_at, NOW()),
       optimization_type = COALESCE(NULLIF(trim(article.optimization_type), ''), '未分类'),
       source_website_url = COALESCE(article.source_website_url, project.website_url),
       source_website_crawl_started_at = COALESCE(article.source_website_crawl_started_at, project.website_crawl_started_at)
  FROM geo_projects AS project
 WHERE project.id = article.project_id
   AND (article.writing_status IS NULL OR article.updated_at IS NULL OR article.optimization_type IS NULL OR trim(article.optimization_type) = '');

-- 约束变更已合并入 001 基线。
CREATE INDEX IF NOT EXISTS geo_project_articles_writing_lease_idx
  ON geo_project_articles (writing_status, writing_lease_expires_at)
  WHERE writing_status = 'writing';
