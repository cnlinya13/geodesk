/**
 * v0.2.4 本地 CLI：admin 重置任意用户密码（兜底：连 admin 密码丢了也能用）。
 * 只能在本机执行，不经过网络接口。重置后该用户下次登录必须先改密码。
 *
 * 用法：npm run admin:reset-password -- --username <登录名> --password <新密码>
 */
import process from 'node:process'
import { closeDatabasePool } from '../server/db.ts'
import { findUserByUsername, setUserPassword } from '../server/auth-db.ts'
import { hashPassword, normalizeUsername, validatePassword } from '../server/auth.ts'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    const eq = arg.indexOf('=')
    if (arg.startsWith('--') && eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1)
    } else if (arg.startsWith('--') && i + 1 < argv.length) {
      out[arg.slice(2)] = argv[i + 1] ?? ''
      i += 1
    }
  }
  return out
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const username = normalizeUsername(args['username'])
  const pwd = validatePassword(args['password'])
  if (!username || !pwd) {
    console.error('用法：npm run admin:reset-password -- --username <登录名> --password <至少8位新密码>')
    process.exitCode = 2
    return
  }
  try {
    const user = await findUserByUsername(username)
    if (!user) {
      console.error(`用户不存在：${username}`)
      process.exitCode = 1
      return
    }
    await setUserPassword(user.id, await hashPassword(pwd), true)
    console.log(`已重置 ${user.username} 的密码，其下次登录必须先修改密码`)
  } catch {
    console.error('重置密码失败，请检查数据库连接')
    process.exitCode = 1
  } finally {
    await closeDatabasePool()
  }
}

void main()
