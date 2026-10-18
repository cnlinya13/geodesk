-- 约束变更已合并入 001 基线（SQLite 不支持 ALTER TABLE ADD/DROP CONSTRAINT）。
CREATE INDEX IF NOT EXISTS geo_project_website_pages_project_idx ON geo_project_website_pages (project_id, id);

CREATE INDEX IF NOT EXISTS geo_project_questions_project_idx ON geo_project_questions (project_id, position);
