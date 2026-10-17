/**
 * v0.2.1 路由集成测试：用假 pg 池 + 假 req/res 直接驱动 handleRequest，
 * 验证注册/登录/登出/会话四条路由的分发、Body 解析、Cookie 与错误码映射。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import process from 'node:process'
import { handleRequest } from './index.ts'
import { hashPassword, issueSessionToken, resetSessionSecretCacheForTests } from './auth.ts'

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }
type QueryResponder = (sql: string, values: unknown[] | undefined) => QueryResult | Promise<QueryResult>
type QueryFunction = (sql: string, values?: unknown[]) => Promise<QueryResult>

const pgMock = vi.hoisted(() => {
  const state: {
    responder: QueryResponder | null
  } = { responder: null }

  class FakePool {
    async query(sql: string, values?: unknown[]): Promise<QueryResult> {
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

vi.mock('pg', () => ({ Pool: pgMock.Pool }))

interface FakeResponse {
  statusCode: number
  headers: Record<string, string | string[]>
  bodyText: string
}

function makeRequest(method: string, url: string, body?: unknown, cookie?: string) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    headers: { cookie, 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  } as never
}

interface FakeNodeRes {
  headersSent: boolean
  setHeader(name: string, value: string | string[]): void
  writeHead(statusCode: number, headers: Record<string, string>): void
  end(body?: string): void
  destroy(): void
}

function makeResponse(): { res: FakeResponse; nodeRes: FakeNodeRes } {
  const res: FakeResponse = { statusCode: 0, headers: {}, bodyText: '' }
  const nodeRes: FakeNodeRes = {
    headersSent: false,
    setHeader(name: string, value: string | string[]) {
      res.headers[name.toLowerCase()] = value
    },
    writeHead(statusCode: number, headers: Record<string, string>) {
      res.statusCode = statusCode
      for (const [k, v] of Object.entries(headers)) res.headers[k.toLowerCase()] = v
    },
    end(body?: string) {
      res.bodyText = body ?? ''
      nodeRes.headersSent = true
    },
    destroy() {},
  }
  return { res, nodeRes }
}

async function callRoute(method: string, url: string, body?: unknown, cookie?: string) {
  const { res, nodeRes } = makeResponse()
  await handleRequest(makeRequest(method, url, body, cookie), nodeRes as never)
  return { ...res, json: res.bodyText ? JSON.parse(res.bodyText) : null }
}

const userRow = (overrides: Record<string, unknown> = {}) => ({
  id: '7',
  username: 'alice',
  password_hash: '',
  display_name: 'Alice',
  role: 'user',
  is_active: true,
  token_version: 0,
  created_at: '2026-10-16T00:00:00.000Z',
  updated_at: '2026-10-16T00:00:00.000Z',
  ...overrides,
})

beforeEach(() => {
  process.env.GEODESK_SESSION_SECRET = 'route-test-secret'
  resetSessionSecretCacheForTests()
  pgMock.state.responder = null
})

describe('POST /api/auth/register（v0.2.2：仅 admin 可创建账号）', () => {
  const adminRow = () => userRow({ id: '1', username: 'root', role: 'admin', password_hash: 'x' })
  async function adminCookie(): Promise<string> {
    return `geodesk_session=${await issueSessionToken({ userId: '1', tokenVersion: 0 })}`
  }

  it('未登录返回 401（守卫先拦截）', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    const { statusCode, json } = await callRoute('POST', '/api/auth/register', {
      username: 'bob',
      password: 'testpass123',
    })
    expect(statusCode).toBe(401)
    expect(json.error).toBe('auth_required')
  })

  it('非 admin 用户返回 403', async () => {
    const user = userRow({ id: '2', username: 'bob', role: 'user' })
    pgMock.state.responder = (sql) =>
      sql.includes('where id = $1') ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 0 }
    const cookie = `geodesk_session=${await issueSessionToken({ userId: '2', tokenVersion: 0 })}`
    const { statusCode, json } = await callRoute(
      'POST',
      '/api/auth/register',
      { username: 'carol', password: 'testpass123' },
      cookie,
    )
    expect(statusCode).toBe(403)
    expect(json.error).toBe('forbidden')
  })

  it('admin 创建账号成功，可指定 role，且不再自动登录', async () => {
    const created = userRow({ id: '9', username: 'carol', role: 'admin', password_hash: await hashPassword('testpass123') })
    let insertedValues: unknown[] | undefined
    pgMock.state.responder = (sql, values) => {
      if (sql.includes('where id = $1')) return { rows: [adminRow()], rowCount: 1 }
      if (sql.includes('where username = $1')) return { rows: [], rowCount: 0 }
      if (sql.startsWith('insert into geo_users')) {
        insertedValues = values
        return { rows: [created], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    const { statusCode, json, headers } = await callRoute(
      'POST',
      '/api/auth/register',
      { username: 'Carol', password: 'testpass123', role: 'admin' },
      await adminCookie(),
    )
    expect(statusCode).toBe(201)
    expect(json.ok).toBe(true)
    expect(json.user.username).toBe('carol') // 入库前转小写
    expect(json.user.role).toBe('admin')
    expect(insertedValues?.[3]).toBe('admin') // role 参数透传到入库
    expect(json.user).not.toHaveProperty('passwordHash')
    expect(headers['set-cookie']).toBeUndefined() // 不再自动种会话 Cookie
  })

  it('用户名重复返回 409', async () => {
    pgMock.state.responder = (sql) => {
      if (sql.includes('where id = $1')) return { rows: [adminRow()], rowCount: 1 }
      if (sql.includes('where username = $1')) return { rows: [userRow()], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    const { statusCode, json } = await callRoute(
      'POST',
      '/api/auth/register',
      { username: 'alice', password: 'testpass123' },
      await adminCookie(),
    )
    expect(statusCode).toBe(409)
    expect(json.error).toBe('username_taken')
  })

  it('非法用户名 / 短密码返回 400', async () => {
    pgMock.state.responder = (sql) =>
      sql.includes('where id = $1') ? { rows: [adminRow()], rowCount: 1 } : { rows: [], rowCount: 0 }
    const cookie = await adminCookie()
    const bad1 = await callRoute('POST', '/api/auth/register', { username: 'a!', password: 'testpass123' }, cookie)
    expect(bad1.statusCode).toBe(400)
    expect(bad1.json.error).toBe('invalid_username')
    const bad2 = await callRoute('POST', '/api/auth/register', { username: 'bob', password: 'short' }, cookie)
    expect(bad2.statusCode).toBe(400)
    expect(bad2.json.error).toBe('password_too_short')
  })
})

describe('v0.2.2 登录态守卫', () => {
  it('未登录访问 /api/projects 返回 401', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    const { statusCode, json } = await callRoute('GET', '/api/projects')
    expect(statusCode).toBe(401)
    expect(json.error).toBe('auth_required')
  })

  it('登录后访问 /api/projects 不再被守卫拦截', async () => {
    const user = userRow({ id: '2', username: 'bob', role: 'user' })
    pgMock.state.responder = (sql) =>
      sql.includes('where id = $1') ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 0 }
    const cookie = `geodesk_session=${await issueSessionToken({ userId: '2', tokenVersion: 0 })}`
    const { statusCode } = await callRoute('GET', '/api/projects', undefined, cookie)
    expect(statusCode).not.toBe(401)
  })

  it('健康检查与登录接口不需要登录态', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    const health = await callRoute('GET', '/api/health/database')
    expect(health.statusCode).not.toBe(401)
    const login = await callRoute('POST', '/api/auth/login', {})
    expect(login.statusCode).toBe(400) // 参数缺失，说明已通过守卫进入处理器
  })
})

describe('POST /api/auth/login', () => {
  it('登录成功种下 Cookie 并返回用户信息', async () => {
    const stored = userRow({ password_hash: await hashPassword('testpass123') })
    pgMock.state.responder = (sql) =>
      sql.includes('where username = $1') ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 }
    const { statusCode, json, headers } = await callRoute('POST', '/api/auth/login', {
      username: 'alice',
      password: 'testpass123',
    })
    expect(statusCode).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.user.username).toBe('alice')
    expect(String(headers['set-cookie'] ?? '')).toContain('geodesk_session=')
  })

  it('密码错误返回 401 且不区分原因', async () => {
    const stored = userRow({ password_hash: await hashPassword('testpass123') })
    pgMock.state.responder = (sql) =>
      sql.includes('where username = $1') ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 }
    const { statusCode, json } = await callRoute('POST', '/api/auth/login', {
      username: 'alice',
      password: 'wrongpass1',
    })
    expect(statusCode).toBe(401)
    expect(json.error).toBe('invalid_credentials')
  })

  it('5 次失败后锁定返回 429', async () => {
    const stored = userRow({ password_hash: await hashPassword('testpass123') })
    pgMock.state.responder = (sql) =>
      sql.includes('where username = $1') ? { rows: [stored], rowCount: 1 } : { rows: [], rowCount: 0 }
    for (let i = 0; i < 5; i++) {
      await callRoute('POST', '/api/auth/login', { username: 'locked1', password: 'wrongpass1' })
    }
    const { statusCode, json } = await callRoute('POST', '/api/auth/login', {
      username: 'locked1',
      password: 'wrongpass1',
    })
    expect(statusCode).toBe(429)
    expect(json.error).toBe('login_locked')
  })
})

describe('GET /api/auth/session + POST /api/auth/logout', () => {
  it('登录后的 Cookie 能通过 session 校验，登出后 Cookie 被清除', async () => {
    const stored = userRow({ password_hash: await hashPassword('testpass123') })
    pgMock.state.responder = (sql) => {
      if (sql.includes('where username = $1')) return { rows: [stored], rowCount: 1 }
      if (sql.includes('where id = $1')) return { rows: [stored], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    const login = await callRoute('POST', '/api/auth/login', {
      username: 'alice',
      password: 'testpass123',
    })
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]

    const session = await callRoute('GET', '/api/auth/session', undefined, cookie)
    expect(session.statusCode).toBe(200)
    expect(session.json.user.username).toBe('alice')

    const logout = await callRoute('POST', '/api/auth/logout', undefined, cookie)
    expect(logout.statusCode).toBe(200)
    expect(String(logout.headers['set-cookie'] ?? '')).toContain('Max-Age=0')
  })

  it('无 Cookie 或伪造 token 返回 401', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    const noCookie = await callRoute('GET', '/api/auth/session')
    expect(noCookie.statusCode).toBe(401)
    expect(noCookie.json.error).toBe('auth_required')
    const forged = await callRoute('GET', '/api/auth/session', undefined, 'geodesk_session=forged.token')
    expect(forged.statusCode).toBe(401)
  })

  it('token_version 对不上（改过密码）时旧会话失效', async () => {
    const stored = userRow({ password_hash: await hashPassword('testpass123'), token_version: 0 })
    const rotated = userRow({ password_hash: stored.password_hash as string, token_version: 1 })
    pgMock.state.responder = (sql) => {
      if (sql.includes('where username = $1')) return { rows: [stored], rowCount: 1 }
      if (sql.includes('where id = $1')) return { rows: [rotated], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    }
    const login = await callRoute('POST', '/api/auth/login', {
      username: 'alice',
      password: 'testpass123',
    })
    const cookie = String(login.headers['set-cookie'] ?? '').split(';')[0]
    const session = await callRoute('GET', '/api/auth/session', undefined, cookie)
    expect(session.statusCode).toBe(401)
    expect(session.json.error).toBe('auth_required')
  })
})
