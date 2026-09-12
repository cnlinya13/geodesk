import { checkDatabase, checkSchema, closeDatabasePool } from '../server/db.ts'

async function main(): Promise<void> {
  try {
    const result = await checkDatabase()
    await checkSchema()
    console.log(`数据库连接正常：${result.database}，阶段六表结构已就绪`)
  } catch {
    console.error('数据库连接失败')
    process.exitCode = 1
  } finally {
    await closeDatabasePool()
  }
}

void main()
