# 数据库适配器接入指南

GEODesk 的业务代码只依赖 `DbAdapter` 接口（`server/db-adapter.ts`），不依赖具体数据库。
工程内只内置 SQLite（Node 24 自带 `node:sqlite`，零依赖）；要换 PostgreSQL、MySQL/MariaDB
或其他数据库，按本指南自行接入，无需改业务代码。

## 接口约定

`server/db-adapter.ts` 定义了三个类型：

```ts
type DbQueryResult<T> = { rows: T[]; rowCount: number }

type DbClient = {
  query: <T>(text: string, params?: unknown[]) => Promise<DbQueryResult<T>>
  release: (error?: unknown) => void
  execScript: (script: string) => Promise<void>
}

interface DbAdapter {
  query<T>(text: string, params?: unknown[]): Promise<DbQueryResult<T>>
  execScript(script: string): Promise<void>   // 跑 migration 这类多语句脚本
  connect(): Promise<DbClient>                 // 取连接；事务在该连接上执行
  end(): Promise<void>
}
```

关键约定：

- **查询统一用 pg 风格的 `$N` 占位符**（`$1、$2……`，允许不连续/乱序）。适配器负责翻译成
  自家方言（SQLite 实现里是 `$N → ?` 并按编号重排参数）。你的实现里也要做这一步，
  除非你的库原生支持 `$N`（如 PostgreSQL 的 `pg` 驱动可直接透传）。
- **事务**通过 `client.query('BEGIN')` / `('COMMIT')` / `('ROLLBACK')` 表达；
  拿到 client 后所有读写走这个 client，最后 `client.release()` 归还。
- **`query` 返回 `{ rows, rowCount }`**：SELECT 类返回行数组；INSERT/UPDATE/DELETE 返回
  `rowCount`（影响行数）。带 `RETURNING` 的语句按 SELECT 处理。
- **类型映射**：JSON 列在库里存 TEXT，读写时 `JSON.stringify` / `JSON.parse`；
  布尔存 1/0；时间存 ISO8601 字符串（`new Date().toISOString()`）。
- **`withNamedLock`**（`db-adapter.ts` 导出）是进程内互斥，用于串行化耗时任务。
  单进程部署够用；多进程部署请自己实现分布式锁（PostgreSQL 可用 advisory lock）。

## 接入步骤

### 1. 实现 DbAdapter

新建一个 CommonJS 模块（`require` 可加载，`.cjs` 或编译后的 `.js`），导出
`createAdapter()` 工厂函数（或 `default` 导出）：

```js
// /opt/geodesk-adapters/postgres.cjs
const { Pool } = require('pg')

function createAdapter() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  return {
    query: async (text, params = []) => {
      const r = await pool.query(text, params)
      return { rows: r.rows, rowCount: r.rowCount ?? 0 }
    },
    execScript: async (script) => { await pool.query(script) },
    connect: async () => {
      const client = await pool.connect()
      return {
        query: async (text, params = []) => {
          const r = await client.query(text, params)
          return { rows: r.rows, rowCount: r.rowCount ?? 0 }
        },
        release: (e) => client.release(e),
        execScript: async (script) => { await client.query(script) },
      }
    },
    end: async () => { await pool.end() },
  }
}

module.exports = { createAdapter }
```

要点：

- `execScript` 跑的是 migration 多语句脚本。`pg` 的 `pool.query` 原生支持多语句；
  `mysql2` 需要建连接时开 `multipleStatements: true`，或自己按分号切分。
- MySQL 占位符是 `?`：实现里把 `$N` 按编号重排成 `?`（参考 `server/sqlite-pool.ts`
  的 `reorderParams`，直接抄）。
- MySQL/MariaDB 的 `rowCount`：`mysql2` 的 `execute()` 返回 `[rows, fields]`，
  SELECT 时 rows 是数组；INSERT/UPDATE 时返回的是 OkPacket（`affectedRows`）。
  注意区分。

### 2. 翻译 migration

`server/migrations/` 下 21 个文件是 SQLite 方言。为你的数据库翻一份，
对照表（以 SQLite 版为源）：

| SQLite | PostgreSQL | MySQL / MariaDB |
|---|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY` | `INT AUTO_INCREMENT PRIMARY KEY` |
| `TEXT`（存 JSON 字符串） | `jsonb`（读写仍用字符串，pg 自动转换） | `JSON`（或继续用 `TEXT`） |
| `TEXT`（存 ISO8601 时间） | `timestamptz` | `DATETIME(3)` / `TIMESTAMP(3)` |
| `INTEGER`（存布尔 0/1） | `boolean`（读写时映射） | `TINYINT(1)` / `BOOLEAN` |
| `REAL` | `double precision` | `DOUBLE` |
| `strftime('%Y-%m-%dT%H:%M:%fZ','now')` 默认值 | `now()` | `CURRENT_TIMESTAMP(3)`（存 UTC 字符串亦可） |
| `ON CONFLICT (col) DO NOTHING` | 原生支持 | `INSERT IGNORE`；`ON CONFLICT DO UPDATE` → `ON DUPLICATE KEY UPDATE col = VALUES(col)` |
| `RETURNING` | 原生支持 | 适配器仿真：INSERT 用 `LAST_INSERT_ID()` 回查，UPDATE 用 WHERE 条件回查 |
| `jsonb_merge(a, b)` | `(a \|\| b)` | `JSON_MERGE_PATCH(COALESCE(a, '{}'), b)`（null 语义对齐） |
| `jsonb_concat(a, b)`（数组拼接） | `(a \|\| b)` | `JSON_MERGE_PRESERVE(a, b)` |
| `x->>'key'` | 原生支持 | `JSON_UNQUOTE(JSON_EXTRACT(x, '$.key'))` |
| `::jsonb` 类型转换 | 原生支持 | 去掉（字符串即 JSON）或 `CAST(x AS JSON)` |
| `ilike` | 原生支持 | `like`（默认 collation 下已不区分大小写） |
| `clock_timestamp()` | 原生支持 | `NOW(3)` |
| `TEXT PRIMARY KEY` / `TEXT` 列建唯一索引 | 允许 | 改 `VARCHAR(n)`（MySQL 不允许 TEXT 做键） |
| `TEXT` 列 `DEFAULT` | 允许 | 改 `VARCHAR(n)`（TEXT 不允许默认值） |
| `JSON` 列 `DEFAULT` | 允许 | 去掉（JSON 列不允许默认值，应用层保证） |
| partial index（`WHERE` 子句） | 原生支持 | 去掉 WHERE，用普通索引（唯一性由应用层保证） |
| functional index（`lower(title)`） | 原生支持 | MySQL 用 `((lower(title)))` 双括号；MariaDB 不支持，改普通索引 |
| `DROP CONSTRAINT IF EXISTS` | 原生支持 | MySQL：唯一约束用 `DROP INDEX`，CHECK 用 `DROP CHECK`；MariaDB 用 `DROP CONSTRAINT` |
| `ALTER COLUMN x SET NOT NULL` | 原生支持 | `MODIFY COLUMN x <类型> NOT NULL` |
| `UPDATE ... FROM` | 原生支持 | 改 `UPDATE ... JOIN ... SET` |
| `decode('...', 'hex')` / `octet_length` | 原生支持 | `UNHEX('...')` / `LENGTH` |
| `CHECK` 调存储函数 | 允许 | 不允许，改应用层校验或等价表达式 |
| `CHECK (json_type(x)='array')` | `CHECK (jsonb_typeof(x) = 'array')` | 去掉（或应用层校验） |
| 字符串拼接 `\|\|` | 原生支持 | `CONCAT()` |

注意：SQLite 版 001 是合并后的全量基线（含 10 张表终态），002–021 只保留
`ADD COLUMN` 和 `CREATE INDEX`。翻译时照这个结构翻即可，不用管 pg 时代的历史演进
（git 历史里有 pg 版 001–021 备查）。

### 3. 配置并验证

```bash
DB_KIND=external DB_ADAPTER_PATH=/opt/geodesk-adapters/postgres.cjs \
  DATABASE_URL=postgres://user:pass@127.0.0.1:5432/geodesk \
  npm run migrate:db
```

- `DB_KIND=external` + `DB_ADAPTER_PATH` 指向你的适配器模块；
- 连接变量名由你的适配器自己定义（如 `DATABASE_URL`）；
- `npm run migrate:db` 全新空库跑一遍 21 个 migration，全部成功才算过；
- 冒烟：建用户 → 建项目 → 读写问题/诊断 → 保存模型设置，确认读写正常；
- 有条件的话跑全套 `npm test`（测试多为 query 层 mock，不受影响）。

## 已验证的数据库

| 数据库 | 状态 | 说明 |
|---|---|---|
| SQLite（`node:sqlite`，内置） | ✅ 内置实现，随工程发布 | 默认，`DATABASE_PATH` / `DATA_DIR` 配置 |
| PostgreSQL 16 | ✅ 接口验证通过 | scratch 适配器 + 方言 migration 实测 |
| MySQL 8.0 | ✅ 接口验证通过 | scratch 适配器 + 方言 migration 实测 |
| MariaDB 11 | ✅ 接口验证通过 | scratch 适配器 + 方言 migration 实测 |

注：三库验证用的是临时 scratch 适配器（未进仓库），目的是证明 `DbAdapter`
接口可插拔；生产使用请按本指南自行实现并充分测试。
