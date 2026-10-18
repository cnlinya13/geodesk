-- 建表已合并入 001 基线。
CREATE INDEX IF NOT EXISTS geo_project_articles_project_idx
  ON geo_project_articles (project_id, id DESC);

CREATE INDEX IF NOT EXISTS geo_project_articles_batch_idx
  ON geo_project_articles (batch_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_title_unique
  ON geo_project_articles (project_id, lower(title));
