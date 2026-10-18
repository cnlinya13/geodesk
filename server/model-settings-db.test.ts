/**
 * v0.3.0 模型设置持久层测试：读写 + resolveModelConfig 回退。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMock = vi.hoisted(() => {
  const state: { responder: ((sql: string, values?: unknown[]) => { rows: Array<Record<string, unknown>>; rowCount: number }) | null } = {
    responder: null,
  }
  class FakePool {
    async query(sql: string, values?: unknown[]) {
      return (await state.responder?.(sql, values)) ?? { rows: [], rowCount: 0 }
    }
  }
  return { state, Pool: FakePool }
})
vi.mock('pg', () => ({ Pool: pgMock.Pool }))

// db.ts 的 databasePool() 用懒加载单例，mock pg.Pool 后需要清掉缓存的单例
vi.mock('./db.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./db.ts')>()
  let pool: InstanceType<typeof pgMock.Pool> | null = null
  return {
    ...mod,
    databasePool: () => {
      if (!pool) pool = new pgMock.Pool()
      return pool
    },
  }
})

import { getModelSettings, resolveModelConfig, saveModelSettings } from './model-settings-db.ts'

const row = {
  provider: 'doubao',
  api_key: 'db-key',
  model_id: 'db-model',
  updated_at: '2026-10-17T00:00:00.000Z',
}

beforeEach(() => {
  pgMock.state.responder = null
  delete process.env.DOUBAO_API_KEY
  delete process.env.DOUBAO_MODEL_ID
})

describe('getModelSettings / saveModelSettings', () => {
  it('读取单行设置', async () => {
    pgMock.state.responder = (sql) =>
      sql.includes('from model_settings') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    expect(await getModelSettings()).toMatchObject({ provider: 'doubao', apiKey: 'db-key', modelId: 'db-model' })
  })

  it('空表返回 null', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    expect(await getModelSettings()).toBeNull()
  })

  it('保存时空 key 沿用旧 key', async () => {
    let values: unknown[] | undefined
    pgMock.state.responder = (sql, v) => {
      if (sql.includes('from model_settings')) return { rows: [row], rowCount: 1 }
      if (sql.includes('insert into model_settings')) {
        values = v
        return { rows: [{ ...row, model_id: 'new-model' }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    }
    const saved = await saveModelSettings({ provider: 'doubao', modelId: 'new-model' })
    expect(values?.[1]).toBe('db-key')
    expect(saved.modelId).toBe('new-model')
  })
})

describe('resolveModelConfig', () => {
  it('数据库有完整配置时优先用数据库', async () => {
    pgMock.state.responder = (sql) =>
      sql.includes('from model_settings') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 }
    process.env.DOUBAO_API_KEY = 'env-key'
    expect(await resolveModelConfig()).toEqual({ provider: 'doubao', apiKey: 'db-key', modelId: 'db-model' })
  })

  it('数据库没配时回退到环境变量', async () => {
    pgMock.state.responder = () => ({ rows: [], rowCount: 0 })
    process.env.DOUBAO_API_KEY = 'env-key'
    process.env.DOUBAO_MODEL_ID = 'env-model'
    expect(await resolveModelConfig()).toEqual({ provider: 'doubao', apiKey: 'env-key', modelId: 'env-model' })
  })

  it('数据库不可用时回退到环境变量', async () => {
    pgMock.state.responder = () => {
      throw new Error('db down')
    }
    process.env.DOUBAO_API_KEY = 'env-key'
    expect((await resolveModelConfig()).apiKey).toBe('env-key')
  })
})
