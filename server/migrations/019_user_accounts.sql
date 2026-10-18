-- 建表已合并入 001 基线。
-- 登录名入库前转小写；保留该索引供按用户名精确查找加速。
CREATE INDEX IF NOT EXISTS geo_users_username_idx ON geo_users (username);
CREATE INDEX IF NOT EXISTS geo_users_role_active_idx ON geo_users (role, is_active);
