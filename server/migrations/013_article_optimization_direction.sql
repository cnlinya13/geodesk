-- Store the independent article optimization direction.  Existing rows stay
-- NULL so the additive rollout does not relabel historical article tasks.
ALTER TABLE geo_project_articles
  ADD COLUMN IF NOT EXISTS optimization_direction TEXT;

ALTER TABLE geo_project_articles
  DROP CONSTRAINT IF EXISTS geo_project_articles_optimization_direction_check,
  ADD CONSTRAINT geo_project_articles_optimization_direction_check
    CHECK (optimization_direction IS NULL OR optimization_direction IN ('主题内容补充', '补充 FAQ', '补充权威来源'));
