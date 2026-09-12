# 第三方声明

本文件记录当前公开目录中直接使用或随项目分发的第三方组件。依赖的传递依赖仍各自遵循其许可证；本项目 MIT 许可证不会覆盖第三方组件。版本和许可证字段以 `package-lock.json` 及对应包发布内容为准，升级依赖后应重新核对。

## 运行时与构建依赖

| 组件 | 用途 | 许可证 |
| --- | --- | --- |
| React、React DOM、React Markdown | UI 和 Markdown 渲染 | MIT |
| Vite、TypeScript、Vitest、tsx、concurrently | 构建、类型检查、测试和开发脚本 | MIT / Apache-2.0（TypeScript） |
| pg | PostgreSQL 客户端 | MIT |
| jsPDF、html2canvas | 报告生成 | MIT |
| lucide-react | 图标 | ISC |
| node-html-parser、rdfa-streaming-parser、microdata-rdf-streaming-parser | 页面和结构化数据解析 | MIT |
| sanitize-html、undici | 内容清理和 HTTP 能力 | MIT |
| @fontsource/noto-sans-sc | 浏览器字体资源 | OFL-1.1 |

## Noto Sans SC

`server/assets/NotoSansSC-Regular.ttf` 及其来源说明由 Noto CJK 项目生成/提供，遵循 SIL Open Font License 1.1。完整许可证保存在 [`server/assets/NotoSansSC-OFL.txt`](server/assets/NotoSansSC-OFL.txt)，来源记录在 [`server/assets/NotoSansSC-SOURCE.txt`](server/assets/NotoSansSC-SOURCE.txt)。字体不是本项目 MIT 代码的一部分。

## 使用者责任

网站内容、模型响应、示例输入和外部供应商服务可能带有各自的版权、条款和数据处理要求。使用真实网站或模型前，使用者应自行确认目标内容、地区、供应商和再分发权限。本文件不把第三方依赖的许可证合并成一个许可证，也不代替法律审查。
