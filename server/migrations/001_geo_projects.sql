-- SQLite 基线：pg 时代 001–021 的最终 schema 合并于此。
-- 因 SQLite 不支持 ALTER TABLE ADD/DROP CONSTRAINT，后续 002–021 只保留
-- ADD COLUMN（IF NOT EXISTS 下为 no-op）与 CREATE INDEX；约束变更已在此合并。
-- 全新空库从这里一次建好所有表；历史演进见 git 中的 pg 版 migration。

CREATE TABLE IF NOT EXISTS geo_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_name TEXT NOT NULL,
  website_url TEXT,
  optimization_target TEXT,
  supplemental_info TEXT,
  questions_generated_at TEXT,
  questions_locked_at TEXT,
  diagnosis_started_at TEXT,
  initial_diagnosis_completed_at TEXT,
  website_locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  website_crawl_status TEXT NOT NULL DEFAULT 'not_started',
  website_crawl_started_at TEXT,
  website_crawl_completed_at TEXT,
  website_crawl_error TEXT,
  website_crawl_source TEXT,
  website_crawl_incomplete INTEGER NOT NULL DEFAULT 0,
  website_pages_discovered INTEGER NOT NULL DEFAULT 0,
  website_pages_succeeded INTEGER NOT NULL DEFAULT 0,
  website_pages_failed INTEGER NOT NULL DEFAULT 0,
  questions_generation_status TEXT NOT NULL DEFAULT 'not_started',
  questions_generation_started_at TEXT,
  questions_generation_completed_at TEXT,
  questions_generation_error TEXT,
  initial_diagnosis_status TEXT NOT NULL DEFAULT 'not_started',
  initial_recommendation_rate REAL,
  initial_official_citation_rate REAL,
  initial_diagnosis_at TEXT,
  technical_audit TEXT,
  content_audit TEXT,
  content_audit_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL,
  questions_generation_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL,
  content_audit_history TEXT NOT NULL DEFAULT '[]',
  CONSTRAINT geo_projects_company_name_unique UNIQUE (company_name),
  CONSTRAINT geo_projects_company_name_not_blank CHECK (length(trim(company_name)) > 0),
  CONSTRAINT geo_projects_website_crawl_status_check CHECK (website_crawl_status IN ('not_started', 'crawling', 'completed', 'failed')),
  CONSTRAINT geo_projects_questions_generation_status_check CHECK (questions_generation_status IN ('not_started', 'generating', 'completed', 'failed')),
  CONSTRAINT geo_projects_website_page_counts_check CHECK (website_pages_discovered >= 0 AND website_pages_succeeded >= 0 AND website_pages_failed >= 0),
  CONSTRAINT geo_projects_initial_diagnosis_status_check CHECK (initial_diagnosis_status IN ('not_started', 'running', 'analyzing', 'completed', 'failed')),
  CONSTRAINT geo_projects_initial_diagnosis_rate_check CHECK (
    (initial_recommendation_rate IS NULL OR (initial_recommendation_rate >= 0 AND initial_recommendation_rate <= 1))
    AND (initial_official_citation_rate IS NULL OR (initial_official_citation_rate >= 0 AND initial_official_citation_rate <= 1))
  ),
  CONSTRAINT geo_projects_content_audit_history_array_check CHECK (json_type(content_audit_history) = 'array')
);

CREATE TABLE IF NOT EXISTS geo_project_website_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error TEXT,
  discovered_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  fetched_at TEXT,
  CONSTRAINT geo_project_website_pages_project_url_unique UNIQUE (project_id, url),
  CONSTRAINT geo_project_website_pages_status_check CHECK (status IN ('success', 'failed'))
);

CREATE TABLE IF NOT EXISTS geo_project_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  category TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT geo_project_questions_position_check CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT geo_project_questions_project_position_unique UNIQUE (project_id, position),
  CONSTRAINT geo_project_questions_category_check CHECK (category IS NULL OR category IN ('recommendation', 'selection', 'decision'))
);

CREATE TABLE IF NOT EXISTS geo_diagnosis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  run_type TEXT NOT NULL DEFAULT 'initial',
  status TEXT NOT NULL DEFAULT 'running',
  requested_model TEXT,
  round_number INTEGER NOT NULL DEFAULT 0,
  published_article_count INTEGER,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  summary_analysis TEXT,
  summary_model TEXT,
  summary_error TEXT,
  recommendation_rate REAL,
  official_citation_rate REAL,
  report_pdf BLOB,
  report_pdf_generated_at TEXT,
  diagnosis_ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL,
  report_refresh_status TEXT NOT NULL DEFAULT 'not_started',
  report_refresh_started_at TEXT,
  report_refresh_error TEXT,
  CONSTRAINT geo_diagnosis_runs_type_check CHECK (run_type IN ('initial', 'monitoring')),
  CONSTRAINT geo_diagnosis_runs_status_check CHECK (status IN ('running', 'analyzing', 'completed', 'failed')),
  CONSTRAINT geo_diagnosis_runs_rate_check CHECK (
    (recommendation_rate IS NULL OR (recommendation_rate >= 0 AND recommendation_rate <= 1))
    AND (official_citation_rate IS NULL OR (official_citation_rate >= 0 AND official_citation_rate <= 1))
  ),
  CONSTRAINT geo_diagnosis_runs_round_check CHECK (
    (run_type = 'initial' AND round_number = 0)
    OR (run_type = 'monitoring' AND round_number > 0)
  ),
  CONSTRAINT geo_diagnosis_runs_published_article_count_check CHECK (
    (run_type = 'initial' AND published_article_count IS NULL)
    OR (run_type = 'monitoring' AND published_article_count IS NOT NULL AND published_article_count >= 0)
  ),
  CONSTRAINT geo_diagnosis_runs_report_refresh_status_check CHECK (report_refresh_status IN ('not_started', 'running', 'ready', 'failed'))
);

CREATE TABLE IF NOT EXISTS geo_diagnosis_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES geo_diagnosis_runs(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  answer_text TEXT,
  citation_urls TEXT NOT NULL DEFAULT '[]',
  response_model TEXT,
  recommended INTEGER,
  official_citation INTEGER,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT geo_diagnosis_answers_run_position_unique UNIQUE (run_id, position),
  CONSTRAINT geo_diagnosis_answers_position_check CHECK (position BETWEEN 1 AND 20),
  CONSTRAINT geo_diagnosis_answers_status_check CHECK (status IN ('pending', 'running', 'success', 'failed')),
  CONSTRAINT geo_diagnosis_answers_citations_array_check CHECK (json_type(citation_urls) = 'array')
);

CREATE TABLE IF NOT EXISTS geo_article_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  requested_model TEXT NOT NULL,
  response_model TEXT,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS geo_project_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  batch_id INTEGER NOT NULL REFERENCES geo_article_batches(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  question_position INTEGER,
  question_positions TEXT,
  content_html TEXT,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  publish_status TEXT NOT NULL DEFAULT 'pending',
  confirmed_at TEXT,
  writing_status TEXT NOT NULL DEFAULT 'pending',
  writing_error TEXT,
  writing_attempt_token TEXT,
  writing_started_at TEXT,
  writing_lease_expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  optimization_type TEXT NOT NULL DEFAULT '未分类',
  optimization_direction TEXT,
  target_page_url TEXT,
  target_page_title TEXT,
  source_website_url TEXT,
  source_website_crawl_started_at TEXT,
  source_diagnosis_run_id INTEGER,
  writing_ai_task_id TEXT REFERENCES geo_ai_tasks(id) ON DELETE SET NULL,
  CONSTRAINT geo_project_articles_question_position_check CHECK (question_position IS NULL OR question_position BETWEEN 1 AND 20),
  CONSTRAINT geo_project_articles_question_positions_check CHECK (geo_question_positions_valid(question_positions)),
  CONSTRAINT geo_project_articles_title_not_blank CHECK (length(trim(title)) > 0),
  CONSTRAINT geo_project_articles_content_not_blank CHECK (length(trim(content_html)) > 0),
  CONSTRAINT geo_project_articles_publish_status_check CHECK (publish_status IN ('pending', 'published')),
  CONSTRAINT geo_project_articles_writing_status_check CHECK (writing_status IN ('pending', 'writing', 'ready', 'failed')),
  CONSTRAINT geo_project_articles_writing_content_check CHECK (writing_status <> 'ready' OR (content_html IS NOT NULL AND length(trim(content_html)) > 0)),
  CONSTRAINT geo_project_articles_optimization_type_not_blank CHECK (length(trim(optimization_type)) > 0),
  CONSTRAINT geo_project_articles_optimization_direction_check CHECK (optimization_direction IS NULL OR optimization_direction IN ('主题内容补充', '补充 FAQ', '补充权威来源')),
  CONSTRAINT geo_project_articles_published_ready_check CHECK (publish_status <> 'published' OR (writing_status = 'ready' AND content_html IS NOT NULL AND length(trim(content_html)) > 0))
);

CREATE TABLE IF NOT EXISTS geo_ai_tasks (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES geo_projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  target_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT,
  result TEXT,
  CONSTRAINT geo_ai_tasks_kind_check CHECK (kind IN ('questions', 'diagnosis', 'diagnosis_report', 'monitoring', 'article_titles', 'article_body', 'content_audit')),
  CONSTRAINT geo_ai_tasks_status_check CHECK (status IN ('running', 'completed', 'failed')),
  CONSTRAINT geo_ai_tasks_completed_at_check CHECK ((status = 'running' AND completed_at IS NULL) OR (status IN ('completed', 'failed') AND completed_at IS NOT NULL)),
  CONSTRAINT geo_ai_tasks_error_check CHECK (status <> 'failed' OR error IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS geo_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  must_change_password INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT geo_users_username_unique UNIQUE (username),
  CONSTRAINT geo_users_username_not_blank CHECK (length(trim(username)) > 0),
  CONSTRAINT geo_users_role_check CHECK (role IN ('admin', 'user')),
  CONSTRAINT geo_users_token_version_check CHECK (token_version >= 0)
);

CREATE TABLE IF NOT EXISTS model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'doubao',
  api_key TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO model_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- 索引（pg 时代各 migration 的最终集合）
CREATE INDEX IF NOT EXISTS geo_projects_updated_at_idx ON geo_projects (updated_at DESC);
CREATE INDEX IF NOT EXISTS geo_project_website_pages_project_idx ON geo_project_website_pages (project_id, id);
CREATE INDEX IF NOT EXISTS geo_project_questions_project_idx ON geo_project_questions (project_id, position);
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_project_idx ON geo_diagnosis_runs (project_id, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_round_unique ON geo_diagnosis_runs (project_id, round_number);
CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_project_initial_unique ON geo_diagnosis_runs (project_id) WHERE run_type = 'initial';
CREATE UNIQUE INDEX IF NOT EXISTS geo_diagnosis_runs_one_unfinished_monitoring_unique ON geo_diagnosis_runs (project_id) WHERE run_type = 'monitoring' AND status IN ('running', 'analyzing', 'failed');
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_project_started_idx ON geo_diagnosis_runs (project_id, run_type, started_at DESC);
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_report_refresh_idx ON geo_diagnosis_runs (project_id, run_type, report_refresh_status);
CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_ai_task_idx ON geo_diagnosis_runs (diagnosis_ai_task_id) WHERE diagnosis_ai_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_diagnosis_answers_run_idx ON geo_diagnosis_answers (run_id, position);
CREATE INDEX IF NOT EXISTS geo_article_batches_project_idx ON geo_article_batches (project_id, id DESC);
CREATE INDEX IF NOT EXISTS geo_article_batches_ai_task_idx ON geo_article_batches (ai_task_id) WHERE ai_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_project_articles_project_idx ON geo_project_articles (project_id, id DESC);
CREATE INDEX IF NOT EXISTS geo_project_articles_batch_idx ON geo_project_articles (batch_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_title_unique ON geo_project_articles (project_id, lower(title)) WHERE publish_status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS geo_project_articles_project_pending_target_unique ON geo_project_articles (project_id, target_page_url) WHERE publish_status = 'pending' AND target_page_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_project_articles_writing_lease_idx ON geo_project_articles (writing_status, writing_lease_expires_at) WHERE writing_status = 'writing';
CREATE INDEX IF NOT EXISTS geo_project_articles_writing_ai_task_idx ON geo_project_articles (writing_ai_task_id) WHERE writing_ai_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_projects_questions_generation_task_idx ON geo_projects (questions_generation_task_id) WHERE questions_generation_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS geo_ai_tasks_project_started_idx ON geo_ai_tasks (project_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS geo_ai_tasks_project_operation_running_unique ON geo_ai_tasks (project_id, kind, COALESCE(target_id, '')) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS geo_users_username_idx ON geo_users (username);
CREATE INDEX IF NOT EXISTS geo_users_role_active_idx ON geo_users (role, is_active);
