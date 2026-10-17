/**
 * v0.2.2 本地 CLI：创建首个管理员账号。
 *
 * Q1 决策为"仅 admin 可创建账号，不开放注册"，因此首个 admin 只能在本机
 * 通过该脚本直接写入数据库，不经过网络接口。
 *
 * 用法：npm run admin:create -- --username <登录名> --password <密码> [--display-name <显示名>]
 */
import process from 'node:process'
import { closeDatabasePool } from '../server/db.ts'
import { createUser, findUserByUsername } from '../server/auth-db.ts'
import { hashPassword, normalizeDisplayName, normalizeUsername, validatePassword } from '../server/auth.ts'

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
  const displayName = normalizeDisplayName(args['display-name'], username ?? '')
  if (!username || !pwd || !displayName) {
    console.error('用法：npm run admin:create -- --username <登录名> --password <至少8位密码> [--display-name <显示名>]')
    process.exitCode = 2
    return
  }
  try {
    if (await findUserByUsername(username)) {
      console.error(`账号已存在：${username}`)
      process.exitCode = 1
      return
    }
    const user = await createUser({
      username,
      passwordHash: await hashPassword(pwd),
      displayName,
      role: 'admin',
    })
    console.log(`已创建管理员账号：${user.username}（${user.displayName}）`)
  } catch {
    console.error('创建管理员账号失败，请检查数据库连接')
    process.exitCode = 1
  } finally {
    await closeDatabasePool()
  }
}

void main()
