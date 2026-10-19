# Changelog

## Unreleased

- v0.5.0 跨模型对比（轮次对比先行）：监测页当前轮次一键「对比上一轮」（上一轮按轮次顺序取最近一个已完成的轮次，第 1 轮的上轮为初始诊断）；对比弹窗展示两轮概览（模型/完成时间/推荐率/引用率对照与百分点变化）与逐题变化（只看结构化变化：推荐翻转、引用翻转、引用链接增减；答案文本措辞差异不计入）；无变化的问题折叠收起。纯前端实现（`src/run-compare.ts` 成对比较纯函数，未来多模型同跑可复用）。

## 0.4.0 - 2026-10-18

- 数据库改走 `DbAdapter` 适配器接入（`server/db-adapter.ts`）：业务代码只依赖接口，查询统一 pg 风格 `$N` 占位符，方言翻译下沉到适配器；当前内置实现为 SQLite（Node 24 内置 `node:sqlite`，零新增依赖），连接配置改为 `DATABASE_PATH`/`DATA_DIR` 文件路径，WAL 模式；21 个 migration 重写为 SQLite 方言（从空库开始，无需数据迁移）；`pg` 依赖与 compose 文件已移除。换其他数据库按 `docs/database-adapter.md` 自行实现适配器（`DB_KIND=external` + `DB_ADAPTER_PATH`），无需改业务代码。已验证：SQLite（内置）、PostgreSQL 16、MySQL 8.0、MariaDB 11（后三者经 scratch 适配器实测 migration/CRUD 全过）。`npm run migrate:db` / `npm run check:db` / 全部 793 个测试 / 构建均验证通过。

## 0.3.2 - 2026-10-18

- 新增一键部署脚本 `deploy.sh`：`curl -fsSL …/deploy.sh | sudo bash` 一条命令拉取最新版并完成配置（Node 安装、前端构建、systemd 服务、nginx 反向代理），默认 IP 访问、可选绑定域名自动配 HTTPS；完全非交互、幂等可重跑；README 中英双语加入一键部署说明。

## 0.3.1 - 2026-10-17

- 公开演示免登录：demo server 新增演示会话接口（`GET /api/auth/session`、`POST /api/auth/login`、`POST /api/auth/logout` 返回演示用户，改密接口打桩通过），演示站开箱即用，不再卡在登录页；真实模式的账号体系不受影响。

## 0.3.0 - 2026-10-17

- v0.3.0 可替换模型适配器 + 模型设置页：`ModelAdapter` 接口（豆包为首个实现，一家一家单独接）；021 迁移建 model_settings 表；`GET/PUT /api/admin/settings/model`（admin-only，GET 不返回 key 明文）；设置页全局统一选模型（provider 下拉 + API Key + 模型 ID）；`resolveModelConfig()` 数据库优先、环境变量兜底；6 个业务模块改走 adapter。

## 0.2.4 - 2026-10-17

- v0.2.4 改密/重置/用户管理：020 迁移加 must_change_password；`POST /api/auth/password/change`（凭旧密码改密，换发新会话）；admin 接口 `GET /api/admin/users`、`POST /api/admin/users/:id/password/reset`（临时密码＋下次登录强制改密）、`PATCH /api/admin/users/:id`（改角色/停用，不能动自己）；`npm run admin:reset-password` 本地 CLI 兜底；前端用户管理页（列表/重置/停用/改角色）、改密页、强制改密门禁。

## 0.2.3 - 2026-10-17

- v0.2.3 登录页与用户菜单：全屏登录页（用户名/密码，错误码中英映射）；顶层登录门禁（会话确认后未登录只渲染登录页）；右上角用户菜单（显示名、角色徽标、修改密码/用户管理占位、登出；admin 可直接创建账号）。

## 0.2.2 - 2026-10-17

- v0.2.2 登录态守卫：`/api/*`（除登录/登出/会话自查/健康检查白名单）未登录返回 401；`POST /api/auth/register` 改为仅 admin 可调用（Q1：不开放注册），支持指定 role；新增 `npm run admin:create` 本地 CLI 创建首个管理员账号；前端启动时调 `/api/auth/session` 恢复会话。

## 0.2.1 - 2026-10-17

- v0.2.1 用户账号地基：019 迁移建 geo_users 表；注册/登录/登出/会话接口（/api/auth/*）；scrypt 密码哈希（N=16384, r=8, p=1）；服务端无状态 HMAC 会话 token（HttpOnly Cookie，改密码即时失效旧会话）；首个注册用户自动成为 admin；同一用户名 5 次登录失败锁定 15 分钟。

## 0.1.2 - 2026-10-15

- 真实迁移验收：在隔离的 PostgreSQL 16 实例上，18 个迁移在全新空库上全部成功执行，`npm run check:db` 确认表结构就绪。
- `npm run check:public` 发布前扫描：1 项发现为 LICENSE 中的著作权人署名（预期内），无 `.env.local`、密钥或数据备份泄露风险。
- 更新 README / README.cn.md 的"验证限制"章节，移除已解决的两项。

## 0.1.1 - 2026-10-15

- 修复 npm audit moderate/high：sanitize-html 升级到 2.17.7（修复 CVE-2026-63670、CVE-2026-84371 两个 XSS），undici 升级到 7.29.1（修复 TLS 证书校验绕过与多项 DoS）。
- 回归验证：`npm test` 706/712 通过（6 个失败为升级前已存在，经原版本基线确认与本次升级无关）、`npm run build` 通过、`npm run smoke:demo` 通过。

## 0.1.0 - 2026-09-12

- 将 GEODesk MVP 整理为可独立获取的 MIT 开源目录：React 前端、Node.js API、PostgreSQL 持久化、数据库迁移与测试边界。
- 核心流程：建项目 → 定义 20 个问题（10 推荐 / 6 选购 / 4 决策，锁定后不可改）→ 初诊（保存模型原始回答与引用链接，推荐率与官网引用率分别统计，诊断报告与 PDF 导出）→ 网站体检（非 AI 技术体检与模型辅助内容体检分离，保留问题与证据）→ 优化任务（文章任务与正文生成，站外发布后在工作区手动确认）→ 多轮监测对比（同问题范围重测对比）。
- 合成演示：不需要数据库、模型 Key 或外网，内存合成数据演示全流程交互，附契约 smoke test（`npm run demo` / `npm run smoke:demo`）。
- 真实模式：隔离 PostgreSQL（Compose 提供 PostgreSQL 16，文档要求自管库 14+）+ Doubao 模型集成（Key 只在服务端使用，浏览器不接触）。
- 公开协作与安全基线：贡献指南、行为准则、安全报告、第三方许可、CI、发布检查清单、issue/PR 模板、发布前公开内容扫描（`npm run check:public`）。

本版本为本地单用户 MVP，未包含：多用户账号与权限体系、自动发布、默认定时监测、集中代付的模型用量。请勿将当前 API 直接暴露到公网。可替换模型适配器、模型/区域/预算/监测目标配置、跨模型回答与引用证据对比规则、区域与全球 GEO 监测均为路线图事项，不视为本版本已实现功能。
