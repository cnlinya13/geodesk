# 贡献指南

## 开始前

请先阅读 [`README.md`](README.cn.md)、[`docs/architecture.md`](docs/architecture.md)、[`docs/business-rules.md`](docs/business-rules.md) 和 [`SECURITY.md`](SECURITY.md)。Issue 或 Pull Request 不应包含 API Key、数据库转储、客户数据、真实网站抓取结果或内部路径。

## 本地开发

```bash
npm ci
npm test
npm run build
npm run smoke:demo
```

需要真实数据库的变更，先确认目标是独立的 `geodesk` 开发数据库，再按 README 的 migration → check → dev 顺序验证。零 Key 的 UI 和契约工作优先使用 `npm run demo`。

## 变更要求

- 一次 Pull Request 只解决一个清晰问题，保留无关改动；
- 修改业务规则、迁移、权限、来源校验或任务状态时，补充相应测试和文档；
- 数据库结构只新增迁移，不改写已经执行过的历史迁移；
- 不把路线图、设计稿或演示结果写成已经实现的生产能力；
- 说明测试命令、数据库/外网/模型依赖和未覆盖范围；
- 保留第三方版权和许可证声明，不将依赖或字体声称为 MIT。

## Pull Request

请使用仓库 Pull Request 模板，描述目标、范围、验证结果和数据影响。维护者会重点检查安全边界、错误响应、迁移可重复性、用户可见文案和公开材料是否一致。
