/**
 * SQLite 连接池：对 node:sqlite（Node 24 内置）的 pg 兼容薄封装。
 *
 * 上层 200 多处调用点保持 `query(text, params)` 的 async 签名不变，
 * pg 方言在这里做机械翻译，业务代码只改极少数无法直译的查询。
 */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export type SqliteQueryResult = {
  rows: Array<Record<string, unknown>>
  rowCount: number
}

export type SqliteQueryClient = {
  query: <T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number }>
  release: (error?: unknown) => void
  execScript: (script: string) => Promise<void>
}

/** 把 $N 占位符按出现顺序换成 ?，并按编号重排参数。
 *  pg 允许 $N 不连续或乱序（如跳过 $7），直接 $N→? 会导致参数错位。 */
function reorderParams(text: string, params: unknown[]): { sql: string; values: unknown[] } {
  const order: number[] = []
  const sql = text.replace(/\$(\d+)/g, (_m, n) => {
    order.push(Number(n))
    return '?'
  })
  return { sql, values: order.map((n) => params[n - 1]) }
}

/** 统计 SQL 里的 ? 占位符数量（忽略字符串字面量内的问号）。 */
function countPlaceholders(sql: string): number {
  let count = 0
  let inString = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === "'") {
      if (inString && sql[i + 1] === "'") {
        i++
        continue
      }
      inString = !inString
      continue
    }
    if (ch === '?' && !inString) count++
  }
  return count
}

/** 按分号切分多语句 SQL，忽略字符串字面量与注释里的分号。 */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let current = ''
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    const next = sql[i + 1]
    if (inLineComment) {
      current += ch
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      current += ch
      if (ch === '*' && next === '/') {
        current += '/'
        i++
        inBlockComment = false
      }
      continue
    }
    if (!inString && ch === '-' && next === '-') {
      inLineComment = true
      current += '--'
      i++
      continue
    }
    if (!inString && ch === '/' && next === '*') {
      inBlockComment = true
      current += '/*'
      i++
      continue
    }
    if (ch === "'") {
      if (inString && next === "'") {
        current += "''"
        i++
        continue
      }
      inString = !inString
      current += ch
      continue
    }
    if (ch === ';' && !inString) {
      statements.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) statements.push(current)
  return statements
}

const projectRoot = fileURLToPath(new URL('../', import.meta.url))

function databaseFilePath(): string {
  // 单元测试用内存库，与开发者环境隔离。
  if (process.env.NODE_ENV === 'test') return ':memory:'
  const configured = process.env.DATABASE_PATH?.trim()
  if (configured) return configured
  const dir = process.env.DATA_DIR?.trim() || join(projectRoot, 'data')
  return join(dir, 'geodesk.db')
}

/**
 * pg → SQLite 的机械翻译。只覆盖本项目实际用到的方言，
 * 翻译不掉的（如 advisory lock、pg catalog 查询）在调用处改写。
 */
function translateSql(text: string): string {
  return (
    text
      // $N 占位符的编号→? 转换在 query() 里连同参数重排一起做（见 reorderParams），
      // 这里不再处理，避免与字符串字面量混淆。
      .replace(/\bilike\b/gi, 'like')
      // SQLite 事务内即持有锁，不需要 FOR UPDATE
      .replace(/\sfor\s+update\s*$/i, '')
      // 类型转换在 SQLite 里不需要
      .replace(/::(jsonb|text|int|integer|bigint|boolean|timestamptz|regclass|regnamespace)\b/gi, '')
      // jsonb 函数 → SQLite json1 对应物
      .replace(/\bjsonb_set\(/gi, 'json_set(')
      .replace(/\bjsonb_typeof\(/gi, 'json_type(')
      .replace(/\bjsonb_array_length\(/gi, 'json_array_length(')
      .replace(/\bjsonb_build_array\(/gi, 'json_array(')
      .replace(/\bjsonb_build_object\(/gi, 'json_object(')
      .replace(/\bto_jsonb\(/gi, 'json_quote(')
      .replace(/\bbtrim\(/gi, 'trim(')
      // interval '1 millisecond'（乐观锁 updated_at 递增）→ 自定义函数
      .replace(/([\w."]+)\s*\+\s*interval\s*'1 millisecond'/gi, 'add_milliseconds($1, 1)')
      // date_trunc('milliseconds', x) → 毫秒精度 ISO8601（库内时间戳均为该格式）
      .replace(/date_trunc\s*\(\s*'milliseconds'\s*,\s*([^()]+(?:\([^()]*\))?[^()]*)\)/gi, "strftime('%Y-%m-%dT%H:%M:%fZ', $1)")
      // greatest(a, b) → max(a, b)（ISO8601 字符串字典序即时间序）
      .replace(/\bgreatest\s*\(/gi, 'max(')
  )
}

/** 给时间戳字符串加毫秒，返回 ISO8601。 */
function addMilliseconds(value: unknown, ms: unknown): string | null {
  if (value == null) return null
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return null
  return new Date(date.getTime() + Number(ms)).toISOString()
}

function normalizeParam(value: unknown): SQLInputValue {
  // node:sqlite 不接受 boolean，TRUE/FALSE 存为 1/0
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value as SQLInputValue
}

const READER_SQL = /^\s*(select|with|values|explain|pragma)\b/i
const RETURNING_SQL = /\breturning\b/i

export class SqlitePool {
  private db: DatabaseSync | undefined

  private open(): DatabaseSync {
    if (!this.db) {
      const path = databaseFilePath()
      if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
      const db = new DatabaseSync(path)
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA foreign_keys = ON')
      // pg 的 now()/clock_timestamp() 在本项目里都存 ISO8601 字符串
      db.function('now', () => new Date().toISOString())
      db.function('clock_timestamp', () => new Date().toISOString())
      // pg jsonb 的 ||：对象做浅合并、数组做拼接；SQLite 没有对应物
      db.function('jsonb_merge', (a: unknown, b: unknown) => {
        const parse = (v: unknown): Record<string, unknown> => {
          try {
            const parsed: unknown = v == null ? {} : JSON.parse(String(v))
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : {}
          } catch {
            return {}
          }
        }
        return JSON.stringify({ ...parse(a), ...parse(b) })
      })
      db.function('jsonb_concat', (a: unknown, b: unknown) => {
        const parse = (v: unknown): unknown[] => {
          try {
            const parsed: unknown = JSON.parse(String(v))
            return Array.isArray(parsed) ? parsed : []
          } catch {
            return []
          }
        }
        return JSON.stringify([...parse(a), ...parse(b)])
      })
      // 题目位置数组校验（原 pg 自定义函数）：1~20 个 1~20 的不重复整数
      db.function('add_milliseconds', (value: unknown, ms: unknown) => addMilliseconds(value, ms))
      db.function('geo_question_positions_valid', (value: unknown) => {
        if (value == null) return 0
        let arr: unknown
        try {
          arr = JSON.parse(String(value))
        } catch {
          return 0
        }
        if (!Array.isArray(arr) || arr.length > 20) return 0
        const seen = new Set<number>()
        for (const item of arr) {
          if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 20) return 0
          if (seen.has(item)) return 0
          seen.add(item)
        }
        return 1
      })
      this.db = db
    }
    return this.db
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    const db = this.open()
    const keyword = text.trim().toUpperCase()
    if (keyword === 'BEGIN' || keyword === 'COMMIT' || keyword === 'ROLLBACK') {
      db.exec(keyword)
      return { rows: [], rowCount: 0 }
    }
    // $N → ? 并按编号重排参数（pg 允许编号不连续/乱序）
    const reordered = reorderParams(text, params)
    const sql = translateSql(reordered.sql)
    // pg 允许占位符编号不连续（如跳过 $7），多余参数直接忽略；
    // node:sqlite 绑定多余参数会报错，按实际占位符数量截断。
    const values = reordered.values.slice(0, countPlaceholders(sql)).map(normalizeParam)
    const statement = db.prepare(sql)
    if (READER_SQL.test(sql) || RETURNING_SQL.test(sql)) {
      const rows = statement.all(...values) as T[]
      return { rows, rowCount: rows.length }
    }
    const info = statement.run(...values)
    return { rows: [], rowCount: Number(info.changes) }
  }

  /** 执行多语句脚本（migration 文件）：无参数、不返回行。 */
  async execScript(script: string): Promise<void> {
    const db = this.open()
    for (const statement of splitStatements(translateSql(script))) {
      const sql = statement.trim()
      if (sql) db.exec(sql)
    }
  }

  /** 单连接：client 与 pool 是同一个库，release 是空操作。 */
  async connect(): Promise<SqliteQueryClient> {
    const pool = this
    return {
      query: this.query.bind(this),
      release: () => undefined,
      execScript: (script: string) => pool.execScript(script),
    }
  }

  release(): void {
    // 兼容 QueryClient 形状；单连接无需释放
  }

  async end(): Promise<void> {
    this.db?.close()
    this.db = undefined
  }
}

/**
 * 进程内命名互斥：替代 pg advisory lock。
 * SQLite 是单进程单连接，内存锁与 advisory lock 等价。
 * 语义保持 try-lock：已被持有时直接抛错，不排队等待。
 */
const heldLocks = new Set<string>()

export async function withNamedLock<T>(key: string, operation: () => Promise<T>, busyError: string): Promise<T> {
  if (heldLocks.has(key)) throw new Error(busyError)
  heldLocks.add(key)
  try {
    return await operation()
  } finally {
    heldLocks.delete(key)
  }
}
