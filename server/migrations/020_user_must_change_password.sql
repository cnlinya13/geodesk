-- v0.2.4 用户账号：admin 重置密码后强制改密标记。
-- admin 在后台重置密码时置 true；用户下次登录后必须先改密码，改完置 false。
ALTER TABLE geo_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
