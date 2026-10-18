-- 建表已合并入 001 基线。
INSERT INTO model_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
