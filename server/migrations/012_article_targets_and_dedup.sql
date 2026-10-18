-- Article plan targets and the simplified new/update workflow.
-- This migration is additive: existing rows keep their titles, bodies,
-- statuses and (possibly absent) target bindings.

-- Content-audit-only tasks have no diagnosis position.  Keep the legacy
-- single-position column for compatibility, but permit it to be NULL and
-- permit the validated positions array to be empty.

-- 列定义终态与约束变更已合并入 001 基线；校验函数改为 adapter 注册的自定义函数。
DROP INDEX IF EXISTS geo_project_articles_project_title_unique;

CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_title_unique
  ON geo_project_articles (project_id, lower(title))
  WHERE publish_status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_target_unique
  ON geo_project_articles (project_id, target_page_url)
  WHERE publish_status = 'pending' AND target_page_url IS NOT NULL;
