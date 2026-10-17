/**
 * v0.3.0 模型设置持久层：model_settings 单行表（id = 1）的读写。
 * api_key 只在服务端使用，GET 接口永不返回明文（只返回 hasApiKey）。
 */
import { databasePool } from './db.ts'

export interface ModelSettings {
  provider: string
  /** 数据库里存的 key（可能为空，表示没配）。 */
  apiKey: string
  modelId: string
  updatedAt: string
}

export interface ModelSettingsInput {
  provider: string
  /** 省略或空字符串表示"不改动已有 key"。 */
  apiKey?: string
  modelId: string
}

export async function getModelSettings(): Promise<ModelSettings | null> {
  const { rows } = await databasePool().query(
    'select provider, api_key, model_id, updated_at from model_settings where id = 1',
  )
  const row = rows[0] as Record<string, unknown> | undefined
  if (!row) return null
  return {
    provider: String(row.provider ?? 'doubao'),
    apiKey: String(row.api_key ?? ''),
    modelId: String(row.model_id ?? ''),
    updatedAt: String(row.updated_at),
  }
}

export async function saveModelSettings(input: ModelSettingsInput): Promise<ModelSettings> {
  const current = await getModelSettings()
  const apiKey = input.apiKey && input.apiKey.trim() ? input.apiKey.trim() : (current?.apiKey ?? '')
  const { rows } = await databasePool().query(
    `insert into model_settings (id, provider, api_key, model_id, updated_at)
     values (1, $1, $2, $3, now())
     on conflict (id) do update set provider = excluded.provider, api_key = excluded.api_key,
       model_id = excluded.model_id, updated_at = now()
     returning provider, api_key, model_id, updated_at`,
    [input.provider, apiKey, input.modelId.trim()],
  )
  const row = rows[0] as Record<string, unknown>
  return {
    provider: String(row.provider),
    apiKey: String(row.api_key ?? ''),
    modelId: String(row.model_id ?? ''),
    updatedAt: String(row.updated_at),
  }
}

/**
 * 解析出生效的模型配置：数据库设置优先；没配过则回退到环境变量
 * （DOUBAO_API_KEY / DOUBAO_MODEL_ID），保持老部署不断。
 */
export async function resolveModelConfig(): Promise<{ provider: string; apiKey: string; modelId: string }> {
  try {
    const saved = await getModelSettings()
    if (saved && saved.apiKey.trim() && saved.modelId.trim()) {
      return { provider: saved.provider, apiKey: saved.apiKey, modelId: saved.modelId }
    }
  } catch {
    // 数据库不可用（如迁移未执行）时回退到环境变量。
  }
  return {
    provider: 'doubao',
    apiKey: process.env.DOUBAO_API_KEY?.trim() ?? '',
    modelId: process.env.DOUBAO_MODEL_ID?.trim() ?? '',
  }
}
