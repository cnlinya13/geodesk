/**
 * v0.2.1 用户账号地基：密码哈希、会话 token、Cookie、输入校验、登录限流。
 *
 * 设计依据（geodesk/drafts/phase2/user-management-design-v0.2.0.md）：
 * - 密码用 node:crypto scrypt（N=16384, r=8, p=1，盐 32 字节，输出 64 字节），不引入新依赖；
 * - 会话为服务端无状态 HMAC 签名 token，放 HttpOnly Cookie（geodesk_session）；
 * - token 内容 = userId.tokenVersion.expiresAt，改密码/重置/停用时应用层把
 *   token_version +1，旧 token 即时失效，无需服务端会话表。
 */
import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import process from 'node:process'

const scryptAsync = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SALT_BYTES = 32
const HASH_BYTES = 64

export const SESSION_COOKIE_NAME = 'geodesk_session'
/** 30 天，单位秒；与设计 §5 一致（Q3 待确认前的默认值）。 */
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/
const MAX_PASSWORD_LENGTH = 256
const MIN_PASSWORD_LENGTH = 8
const MAX_DISPLAY_NAME_LENGTH = 64

// ---------------------------------------------------------------------------
// 密码
// ---------------------------------------------------------------------------

export function normalizeUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return USERNAME_PATTERN.test(normalized) ? normalized : null
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH) return null
  return value
}

export function normalizeDisplayName(value: unknown, fallback: string): string | null {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_DISPLAY_NAME_LENGTH) return null
  return trimmed
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const derived = (await scryptAsync(password, salt, HASH_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  })) as Buffer
  return [
    'scrypt',
    String(SCRYPT_N),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$')
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const n = Number(parts[1])
    const r = Number(parts[2])
    const p = Number(parts[3])
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
    if (n !== SCRYPT_N || r !== SCRYPT_R || p !== SCRYPT_P) return false
    const salt = Buffer.from(parts[4], 'base64url')
    const expected = Buffer.from(parts[5], 'base64url')
    if (salt.length !== SALT_BYTES || expected.length !== HASH_BYTES) return false
    const derived = (await scryptAsync(password, salt, HASH_BYTES, { N: n, r, p })) as Buffer
    return derived.length === expected.length && timingSafeEqual(derived, expected)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 会话密钥：环境变量优先，否则生成并持久化到仓库外的本地文件
// ---------------------------------------------------------------------------

function secretFilePath(): string {
  return join(homedir(), '.geodesk', 'session-secret')
}

let cachedSecret: Buffer | null = null

export function resetSessionSecretCacheForTests(): void {
  cachedSecret = null
}

export async function sessionSecret(): Promise<Buffer> {
  if (cachedSecret) return cachedSecret
  const fromEnv = process.env.GEODESK_SESSION_SECRET?.trim()
  if (fromEnv) {
    cachedSecret = Buffer.from(fromEnv, 'utf8')
    return cachedSecret
  }
  const path = secretFilePath()
  try {
    const stored = (await readFile(path, 'utf8')).trim()
    if (stored) {
      cachedSecret = Buffer.from(stored, 'utf8')
      return cachedSecret
    }
  } catch {
    // 文件不存在则走生成分支
  }
  const generated = randomBytes(48)
  await mkdir(join(homedir(), '.geodesk'), { recursive: true })
  await writeFile(path, generated.toString('base64url'), { mode: 0o600 })
  // 防止 umask 影响，显式再 chmod 一次
  await chmod(path, 0o600).catch(() => undefined)
  cachedSecret = generated
  return cachedSecret
}

// ---------------------------------------------------------------------------
// 会话 token：base64url(userId.tokenVersion.expiresAt).base64url(HMAC_SHA256)
// ---------------------------------------------------------------------------

export interface SessionClaims {
  userId: string
  tokenVersion: number
}

function tokenPayload(claims: SessionClaims, expiresAt: number): string {
  return `${claims.userId}.${claims.tokenVersion}.${expiresAt}`
}

export async function issueSessionToken(claims: SessionClaims): Promise<string> {
  const secret = await sessionSecret()
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS
  const body = Buffer.from(tokenPayload(claims, expiresAt), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${signature}`
}

export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const dot = token.lastIndexOf('.')
    if (dot <= 0) return null
    const body = token.slice(0, dot)
    const signature = token.slice(dot + 1)
    const secret = await sessionSecret()
    const expected = createHmac('sha256', secret).update(body).digest()
    const actual = Buffer.from(signature, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null
    const payload = Buffer.from(body, 'base64url').toString('utf8')
    const parts = payload.split('.')
    if (parts.length !== 3) return null
    const [userId, tokenVersionText, expiresAtText] = parts
    if (!/^\d+$/.test(userId)) return null
    const tokenVersion = Number(tokenVersionText)
    const expiresAt = Number(expiresAtText)
    if (!Number.isInteger(tokenVersion) || tokenVersion < 0) return null
    if (!Number.isInteger(expiresAt) || expiresAt * 1000 <= Date.now()) return null
    return { userId, tokenVersion }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Cookie
// ---------------------------------------------------------------------------

export function sessionTokenFromCookieHeader(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header[0] : header
  if (!raw) return null
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE_NAME) {
      const value = part.slice(eq + 1).trim()
      return value || null
    }
  }
  return null
}

export function buildSessionSetCookie(token: string): string {
  // 本地 http 场景不加 Secure（localhost 无意义）；公网部署前必须补上。
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`
}

export function buildSessionClearCookie(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`
}

// ---------------------------------------------------------------------------
// 登录限流：同一用户名 5 次失败后锁定 15 分钟（内存计数，本地工具够用）
// ---------------------------------------------------------------------------

const MAX_LOGIN_FAILURES = 5
const LOGIN_LOCK_MS = 15 * 60 * 1000

interface LoginAttemptState {
  failures: number
  lockedUntil: number
}

const loginAttempts = new Map<string, LoginAttemptState>()

export function isLoginLocked(username: string): boolean {
  const state = loginAttempts.get(username)
  if (!state) return false
  if (state.lockedUntil > Date.now()) return true
  // 锁已过期才清理（lockedUntil 为 0 表示从未被锁定，不能清掉累计的失败次数）
  if (state.lockedUntil !== 0) loginAttempts.delete(username)
  return false
}

export function recordLoginFailure(username: string): void {
  const state = loginAttempts.get(username) ?? { failures: 0, lockedUntil: 0 }
  state.failures += 1
  if (state.failures >= MAX_LOGIN_FAILURES) {
    state.lockedUntil = Date.now() + LOGIN_LOCK_MS
  }
  loginAttempts.set(username, state)
}

export function recordLoginSuccess(username: string): void {
  loginAttempts.delete(username)
}

export function resetLoginAttemptsForTests(): void {
  loginAttempts.clear()
}
