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
  /** admin 重置密码后为 true，用户下次登录必须先改密码（v0.2.4）。 */
  mustChangePassword: boolean
  createdAt: string
  updatedAt: string
}

/** 内部行：登录校验需要 password_hash / token_version / is_active。 */
export interface UserRow extends PublicUser {
  passwordHash: string
  tokenVersion: number
}

const publicUserColumns =
  'id, username, display_name, role, is_active, must_change_password, token_version, created_at, updated_at'
const internalUserColumns = `${publicUserColumns}, password_hash`

export function toPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: row.role === 'admin' ? 'admin' : 'user',
    isActive: row.is_active === true,
    mustChangePassword: row.must_change_password === true,
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
    mustChangePassword: row.mustChangePassword,
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

/** v0.2.4：设置新密码哈希；token_version +1 使旧会话即时失效。 */
export async function setUserPassword(id: string, passwordHash: string, mustChangePassword: boolean): Promise<void> {
  await databasePool().query(
    `update geo_users
     set password_hash = $2, must_change_password = $3, token_version = token_version + 1, updated_at = now()
     where id = $1`,
    [id, passwordHash, mustChangePassword],
  )
}

/** v0.2.4：admin 用户列表（对外形态，不含密码哈希）。 */
export async function listUsers(): Promise<PublicUser[]> {
  const result = await databasePool().query(
    `select ${publicUserColumns} from geo_users order by id`,
  )
  return (result.rows as Array<Record<string, unknown>>).map(toPublicUser)
}

export interface UpdateUserPatch {
  displayName?: string
  role?: UserRole
  isActive?: boolean
}

/** v0.2.4：admin 更新用户；停用时 token_version +1 使其会话即时失效。返回更新后的对外形态。 */
export async function updateUser(id: string, patch: UpdateUserPatch): Promise<PublicUser | null> {
  const sets: string[] = ['updated_at = now()']
  const values: unknown[] = [id]
  let index = 2
  if (patch.displayName !== undefined) {
    sets.push(`display_name = $${index}`)
    values.push(patch.displayName)
    index += 1
  }
  if (patch.role !== undefined) {
    sets.push(`role = $${index}`)
    values.push(patch.role)
    index += 1
  }
  if (patch.isActive !== undefined) {
    sets.push(`is_active = $${index}`)
    values.push(patch.isActive)
    index += 1
    if (!patch.isActive) sets.push('token_version = token_version + 1')
  }
  const result = await databasePool().query(
    `update geo_users set ${sets.join(', ')} where id = $1 returning ${publicUserColumns}`,
    values,
  )
  const row = result.rows[0] as Record<string, unknown> | undefined
  return row ? toPublicUser(row) : null
}
