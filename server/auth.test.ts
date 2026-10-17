import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import process from 'node:process'
import {
  buildSessionClearCookie,
  buildSessionSetCookie,
  hashPassword,
  isLoginLocked,
  issueSessionToken,
  normalizeDisplayName,
  normalizeUsername,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginAttemptsForTests,
  resetSessionSecretCacheForTests,
  SESSION_COOKIE_NAME,
  sessionSecret,
  sessionTokenFromCookieHeader,
  validatePassword,
  verifyPassword,
  verifySessionToken,
} from './auth.ts'

describe('username / password / displayName 校验', () => {
  it('用户名转小写并校验规则', () => {
    expect(normalizeUsername('  Alice_01 ')).toBe('alice_01')
    expect(normalizeUsername('ab')).toBeNull() // 太短
    expect(normalizeUsername('a'.repeat(33))).toBeNull() // 太长
    expect(normalizeUsername('a b')).toBeNull() // 非法字符
    expect(normalizeUsername('中文')).toBeNull()
    expect(normalizeUsername(123)).toBeNull()
    expect(normalizeUsername('ok-name_9')).toBe('ok-name_9')
  })

  it('密码长度 8–256', () => {
    expect(validatePassword('1234567')).toBeNull()
    expect(validatePassword('12345678')).toBe('12345678')
    expect(validatePassword('x'.repeat(257))).toBeNull()
    expect(validatePassword(12345678)).toBeNull()
  })

  it('显示名缺省回退、去空白、限长', () => {
    expect(normalizeDisplayName(undefined, 'alice')).toBe('alice')
    expect(normalizeDisplayName('', 'alice')).toBe('alice')
    expect(normalizeDisplayName('  老王  ', 'alice')).toBe('老王')
    expect(normalizeDisplayName('   ', 'alice')).toBeNull()
    expect(normalizeDisplayName('x'.repeat(65), 'alice')).toBeNull()
    expect(normalizeDisplayName(42, 'alice')).toBeNull()
  })
})

describe('scrypt 密码哈希', () => {
  it('加签验签往返通过，错密码拒绝', async () => {
    const stored = await hashPassword('correct-horse-8')
    expect(stored.startsWith('scrypt$16384$8$1$')).toBe(true)
    expect(await verifyPassword('correct-horse-8', stored)).toBe(true)
    expect(await verifyPassword('wrong-password', stored)).toBe(false)
  })

  it('盐随机：同一密码两次哈希不同', async () => {
    const a = await hashPassword('same-password-1')
    const b = await hashPassword('same-password-1')
    expect(a).not.toBe(b)
    expect(await verifyPassword('same-password-1', a)).toBe(true)
    expect(await verifyPassword('same-password-1', b)).toBe(true)
  })

  it('损坏的存储格式一律返回 false（不抛错）', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$1$2$3$aaaa$bbbb')).toBe(false)
    expect(await verifyPassword('x', '')).toBe(false)
  })
})

describe('会话密钥', () => {
  const OLD_ENV = process.env.GEODESK_SESSION_SECRET

  beforeEach(() => {
    resetSessionSecretCacheForTests()
  })

  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.GEODESK_SESSION_SECRET
    else process.env.GEODESK_SESSION_SECRET = OLD_ENV
    resetSessionSecretCacheForTests()
  })

  it('环境变量优先', async () => {
    process.env.GEODESK_SESSION_SECRET = 'env-secret-xyz'
    const secret = await sessionSecret()
    expect(secret.toString('utf8')).toBe('env-secret-xyz')
    // 缓存命中：第二次调用返回同一份
    expect(await sessionSecret()).toBe(secret)
  })
})

describe('会话 token', () => {
  beforeEach(() => {
    process.env.GEODESK_SESSION_SECRET = 'test-only-secret'
    resetSessionSecretCacheForTests()
  })

  afterEach(() => {
    delete process.env.GEODESK_SESSION_SECRET
    resetSessionSecretCacheForTests()
  })

  it('签发验签往返', async () => {
    const token = await issueSessionToken({ userId: '42', tokenVersion: 3 })
    const claims = await verifySessionToken(token)
    expect(claims).toEqual({ userId: '42', tokenVersion: 3 })
  })

  it('篡改签名被拒绝', async () => {
    const token = await issueSessionToken({ userId: '42', tokenVersion: 3 })
    const tampered = `${token.slice(0, -2)}xx`
    expect(await verifySessionToken(tampered)).toBeNull()
  })

  it('篡改载荷被拒绝', async () => {
    const token = await issueSessionToken({ userId: '42', tokenVersion: 3 })
    const [body, sig] = token.split('.')
    const fakeBody = Buffer.from('99.0.9999999999', 'utf8').toString('base64url')
    expect(await verifySessionToken(`${fakeBody}.${sig}`)).toBeNull()
    expect(body).toBeTruthy()
  })

  it('过期 token 被拒绝', async () => {
    const secret = await sessionSecret()
    const past = Math.floor(Date.now() / 1000) - 60
    const body = Buffer.from(`7.1.${past}`, 'utf8').toString('base64url')
    const sig = createHmac('sha256', secret).update(body).digest('base64url')
    expect(await verifySessionToken(`${body}.${sig}`)).toBeNull()
  })

  it('畸形 token 被拒绝', async () => {
    expect(await verifySessionToken('')).toBeNull()
    expect(await verifySessionToken('no-dot')).toBeNull()
    expect(await verifySessionToken('a.b.c.d')).toBeNull()
  })
})

describe('Cookie', () => {
  it('从 Cookie 头解析会话 token', () => {
    expect(sessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=tok123; other=1`)).toBe('tok123')
    expect(sessionTokenFromCookieHeader('other=1')).toBeNull()
    expect(sessionTokenFromCookieHeader(undefined)).toBeNull()
    expect(sessionTokenFromCookieHeader([`${SESSION_COOKIE_NAME}=abc`])).toBe('abc')
    expect(sessionTokenFromCookieHeader(`${SESSION_COOKIE_NAME}=`)).toBeNull()
  })

  it('Set-Cookie 含 HttpOnly / Path / SameSite / Max-Age', () => {
    const set = buildSessionSetCookie('tok123')
    expect(set).toContain(`${SESSION_COOKIE_NAME}=tok123`)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Path=/')
    expect(set).toContain('SameSite=Lax')
    expect(set).toContain('Max-Age=2592000')
    expect(set).not.toContain('Secure') // 本地 http 场景不加 Secure
  })

  it('清除 Cookie 把 Max-Age 置 0', () => {
    expect(buildSessionClearCookie()).toContain('Max-Age=0')
  })
})

describe('登录限流', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetLoginAttemptsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetLoginAttemptsForTests()
  })

  it('5 次失败后锁定 15 分钟，成功后清零', () => {
    const user = 'alice'
    for (let i = 0; i < 4; i++) {
      recordLoginFailure(user)
      expect(isLoginLocked(user)).toBe(false)
    }
    recordLoginFailure(user)
    expect(isLoginLocked(user)).toBe(true)
    // 15 分钟后自动解锁
    vi.advanceTimersByTime(15 * 60 * 1000 + 1)
    expect(isLoginLocked(user)).toBe(false)
  })

  it('成功登录清零计数', () => {
    const user = 'bob'
    for (let i = 0; i < 5; i++) recordLoginFailure(user)
    expect(isLoginLocked(user)).toBe(true)
    recordLoginSuccess(user)
    expect(isLoginLocked(user)).toBe(false)
  })

  it('不同用户名计数隔离', () => {
    for (let i = 0; i < 5; i++) recordLoginFailure('u1')
    expect(isLoginLocked('u1')).toBe(true)
    expect(isLoginLocked('u2')).toBe(false)
  })
})
