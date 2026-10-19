import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bumpUserTokenVersion, countAdmins, createUser, findUserById, findUserByUsername } from './auth-db.ts'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryResponder = (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryResult>

const pgMock = vi.hoisted(() => {
  const state: {
    responder: QueryResponder | null
    queries: Array<{ sql: string; values?: unknown[] }>
  } = { responder: null, queries: [] }

  class FakePool {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
      state.queries.push({ sql, values })
      return (await state.responder?.(sql, values)) ?? { rows: [], rowCount: 0 }
    }

    async connect(): Promise<{ query: QueryFunction; release: () => void }> {
      return { query: this.query.bind(this), release: () => undefined }
    }

    async end(): Promise<void> {
      return undefined
    }
  }

  return { state, Pool: FakePool }
})

vi.mock('./sqlite-pool.ts', () => ({ SqlitePool: pgMock.Pool }))

const sampleRow = {
  id: '7',
  username: 'alice',
  password_hash: 'scrypt$16384$8$1$aaa$bbb',
  display_name: 'Alice',
  role: 'admin',
  is_active: true,
  token_version: 2,
  created_at: '2026-10-16T00:00:00.000Z',
  updated_at: '2026-10-16T00:00:00.000Z',
}

beforeEach(() => {
  pgMock.state.queries = []
  pgMock.state.responder = null
})

describe('findUserByUsername', () => {
  it('返回内部行（含 passwordHash / tokenVersion）', async () => {
    pgMock.state.responder = () => ({ rows: [sampleRow], rowCount: 1 })
    const user = await findUserByUsername('alice')
    expect(user?.username).toBe('alice')
    expect(user?.passwordHash).toBe('scrypt$16384$8$1$aaa$bbb')
    expect(user?.tokenVersion).toBe(2)
    expect(user?.role).toBe('admin')
    expect(user?.isActive).toBe(true)
    expect(pgMock.state.queries[0].values).toEqual(['alice'])
  })

  it('不存在返回 null', async () => {
    const user = await findUserByUsername('nobody')
    expect(user).toBeNull()
  })
})

describe('findUserById', () => {
  it('返回对外形态，不含 passwordHash', async () => {
    pgMock.state.responder = () => ({ rows: [sampleRow], rowCount: 1 })
    const user = await findUserById('7')
    expect(user).not.toHaveProperty('passwordHash')
    expect(user?.id).toBe('7')
    expect(user?.displayName).toBe('Alice')
  })
})

describe('countAdmins', () => {
  it('返回 admin 数量', async () => {
    pgMock.state.responder = () => ({ rows: [{ count: 1 }], rowCount: 1 })
    expect(await countAdmins()).toBe(1)
  })
})

describe('createUser', () => {
  it('插入并返回对外形态', async () => {
    pgMock.state.responder = () => ({ rows: [sampleRow], rowCount: 1 })
    const user = await createUser({
      username: 'alice',
      passwordHash: 'scrypt$16384$8$1$aaa$bbb',
      displayName: 'Alice',
      role: 'admin',
    })
    expect(user.username).toBe('alice')
    expect(user).not.toHaveProperty('passwordHash')
    const { sql, values } = pgMock.state.queries[0]
    expect(sql).toContain('insert into geo_users')
    expect(values).toEqual(['alice', 'scrypt$16384$8$1$aaa$bbb', 'Alice', 'admin'])
  })
})

describe('bumpUserTokenVersion', () => {
  it('token_version +1', async () => {
    await bumpUserTokenVersion('7')
    const { sql, values } = pgMock.state.queries[0]
    expect(sql).toContain('token_version = token_version + 1')
    expect(values).toEqual(['7'])
  })
})

describe('v0.2.4 新增持久层', () => {
  it('setUserPassword 更新哈希并使旧会话失效', async () => {
    const { setUserPassword } = await import('./auth-db.ts')
    pgMock.state.responder = () => ({ rows: [], rowCount: 1 })
    await setUserPassword('7', 'scrypt$new', true)
    const q = pgMock.state.queries[0]
    expect(q.values?.[0]).toBe('7')
    expect(q.values?.[1]).toBe('scrypt$new')
    expect(q.values?.[2]).toBe(true)
    expect(q.sql).toContain('token_version = token_version + 1')
  })

  it('listUsers 返回对外形态', async () => {
    const { listUsers } = await import('./auth-db.ts')
    pgMock.state.responder = () => ({ rows: [sampleRow], rowCount: 1 })
    const users = await listUsers()
    expect(users).toHaveLength(1)
    expect(users[0]).not.toHaveProperty('passwordHash')
    expect(users[0]).not.toHaveProperty('password_hash')
    expect(users[0].mustChangePassword).toBe(false)
  })

  it('updateUser 停用时 token_version +1', async () => {
    const { updateUser } = await import('./auth-db.ts')
    pgMock.state.responder = () => ({ rows: [{ ...sampleRow, is_active: false }], rowCount: 1 })
    const updated = await updateUser('7', { isActive: false })
    expect(updated?.isActive).toBe(false)
    expect(pgMock.state.queries[0].sql).toContain('token_version = token_version + 1')
  })

  it('updateUser 不存在返回 null', async () => {
    const { updateUser } = await import('./auth-db.ts')
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    expect(await updateUser('99', { role: 'admin' })).toBeNull()
  })
})
