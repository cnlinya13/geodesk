/**
 * 数据库适配器接口。
 *
 * 业务代码（server/db.ts 及各 *-db.ts）只依赖这个接口，不依赖具体数据库。
 * 查询统一使用 pg 风格的 $N 占位符；各适配器负责翻译成自己数据库的方言。
 * 事务通过 client.query('BEGIN' / 'COMMIT' / 'ROLLBACK') 表达，适配器负责执行。
 *
 * 自行接入其他数据库见 docs/database-adapter.md。
 */
import process from 'node:process'
import { createRequire } from 'node:module'
import { SqlitePool, withNamedLock } from './sqlite-pool.ts'

export type DbQueryResult<T extends Record<string, unknown> = Record<string, unknown>> = {
  rows: T[]
  rowCount: number
}

export type DbClient = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<DbQueryResult<T>>
  release: (error?: unknown) => void
  execScript: (script: string) => Promise<void>
}

export interface DbAdapter {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<DbQueryResult<T>>
  /** 执行 migration 这类多语句脚本：无参数、不返回行。 */
  execScript(script: string): Promise<void>
  /** 取一个连接；事务（BEGIN/COMMIT/ROLLBACK）在该连接上执行。 */
  connect(): Promise<DbClient>
  end(): Promise<void>
}

export { withNamedLock }

/**
 * 按 DB_KIND 创建适配器。
 * - sqlite（默认）：Node 24 内置 node:sqlite，零依赖，见 server/sqlite-pool.ts。
 * - external：从 DB_ADAPTER_PATH 指向的 CommonJS 模块加载用户自实现的适配器，
 *   模块须导出 createAdapter()（或 default 导出工厂函数），见 docs/database-adapter.md。
 */
export function createAdapter(): DbAdapter {
  const kind = (process.env.DB_KIND ?? 'sqlite').trim().toLowerCase()
  if (kind === 'sqlite') {
    return new SqlitePool()
  }
  if (kind === 'external') {
    const adapterPath = process.env.DB_ADAPTER_PATH?.trim()
    if (!adapterPath) {
      throw new Error('DB_KIND=external 需要设置 DB_ADAPTER_PATH 指向适配器模块，见 docs/database-adapter.md')
    }
    const require = createRequire(import.meta.url)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(adapterPath) as {
      createAdapter?: () => DbAdapter
      default?: () => DbAdapter
    }
    const factory = mod.createAdapter ?? mod.default
    if (typeof factory !== 'function') {
      throw new Error(`DB_ADAPTER_PATH 指向的模块须导出 createAdapter() 工厂函数：${adapterPath}`)
    }
    return factory()
  }
  throw new Error(
    `不支持的 DB_KIND="${kind}"，当前工程仅内置 sqlite；接入其他数据库见 docs/database-adapter.md`,
  )
}
