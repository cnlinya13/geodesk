import { closeDatabasePool, runMigrations } from '../server/db.ts'

async function main(): Promise<void> {
  try {
    const applied = await runMigrations()
    if (applied.length === 0) {
      console.log('数据库迁移已是最新')
    } else {
      console.log(`已执行数据库迁移：${applied.join(', ')}`)
    }
  } catch {
    console.error('数据库迁移失败')
    process.exitCode = 1
  } finally {
    await closeDatabasePool()
  }
}

void main()
