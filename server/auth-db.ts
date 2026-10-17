/**
 * v0.2.1 用户账号持久层：geo_users 表的读写。
 * 密码哈希等密码学操作在 server/auth.ts，错误体格式沿用 {ok:false, error, message}。
 */
import { databasePool } from './db.ts'

export type UserRole = 'admin' | 'user'

/** 对外返回的用户形态：永不包含 password_hash。 */
export interface PublicUser {
  id: string
  username: string
  displayName: string
  role: UserRole
  isActive: boolean
  createdAt: string
  updatedAt: string
}

/** 内部行：登录校验需要 password_hash / token_version / is_active。 */
export interface UserRow extends PublicUser {
  passwordHash: string
  tokenVersion: number
}

const publicUserColumns =
  'id, username, display_name, role, is_active, token_version, created_at, updated_at'
const internalUserColumns = `${publicUserColumns}, password_hash`

export function toPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role === 'admin' ? 'admin' : 'user',
    isActive: row.is_active === true,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
}

function toUserRow(row: Record<string, unknown>): UserRow {
  return {
    ...toPublicUser(row),
    passwordHash: String(row.password_hash),
    tokenVersion: Number(row.token_version),
  }
}

/** 从内部行剥离敏感字段，得到对外形态。 */
export function publicUserFromRow(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export async function findUserByUsername(username: string): Promise<UserRow | null> {
  const result = await databasePool().query(
    `select ${internalUserColumns} from geo_users where username = $1`,
    [username],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? toUserRow(row) : null
}

export async function findUserById(id: string): Promise<PublicUser | null> {
  const result = await databasePool().query(
    `select ${publicUserColumns} from geo_users where id = $1`,
    [id],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? toPublicUser(row) : null
}

/** 内部行（含 tokenVersion）：会话校验用，对外接口不要直接返回。 */
export async function findUserRowById(id: string): Promise<UserRow | null> {
  const result = await databasePool().query(
    `select ${internalUserColumns} from geo_users where id = $1`,
    [id],
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? toUserRow(row) : null
}

export async function countAdmins(): Promise<number> {
  const result = await databasePool().query(
    `select count(*)::int as count from geo_users where role = 'admin'`,
  )
  return Number((result.rows[0] as Record<string, unknown> | undefined)?.count ?? 0)
}

export interface CreateUserInput {
  username: string
  passwordHash: string
  displayName: string
  role: UserRole
}

export async function createUser(input: CreateUserInput): Promise<PublicUser> {
  const result = await databasePool().query(
    `insert into geo_users (username, password_hash, display_name, role)
     values ($1, $2, $3, $4)
     returning ${publicUserColumns}`,
    [input.username, input.passwordHash, input.displayName, input.role],
  )
  return toPublicUser(result.rows[0] as Record<string, unknown>)
}

/** 改密码/重置密码/停用时调用：token_version +1 使旧会话 token 即时失效。 */
export async function bumpUserTokenVersion(id: string): Promise<void> {
  await databasePool().query(
    `update geo_users set token_version = token_version + 1, updated_at = now() where id = $1`,
    [id],
  )
}
