-- v0.3.0 模型设置：用户在设置页自选大模型（全局统一）。
-- 单行表（id = 1）；api_key 存用户在前端填写的密钥。
CREATE TABLE IF NOT EXISTS model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  provider TEXT NOT NULL DEFAULT 'doubao',
  api_key TEXT NOT NULL DEFAULT '',
  model_id TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO model_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
