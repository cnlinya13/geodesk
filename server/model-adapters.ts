/**
 * v0.3.0 模型适配器：把"调哪个大模型"抽象成可替换的接口。
 *
 * 设计决策（2026-10-17 Jeff 确认）：
 * - 用户在设置页自己选模型，全局统一生效；
 * - 一家一家单独接：每家 provider 写一个适配器实现，不做通用兼容层；
 * - 本轮只出架构 + 设置页，不实际接入新 provider（豆包是唯一实现）。
 */
import {
  extractCitationUrls,
  extractResponseModel,
  extractResponseText,
  requestDoubaoResponses,
  type DoubaoTimingCallback,
} from './doubao-client.ts'

/** 适配器归一化输入：各业务模块只认这一套字段，不直接碰 provider SDK。 */
export interface AdapterGenerateInput {
  apiKey: string
  modelId: string
  /**
   * 纯文本 prompt，或多轮 transcript（数组项为 provider 原生消息格式，
   * 如 Responses 的 function_call_output；仅当 adapter 理解该格式时有效）。
   */
  prompt: string | readonly Record<string, unknown>[]
  /** 结构化输出：映射为各家的 json_schema / response_format。 */
  jsonSchema?: { name: string; schema: Record<string, unknown> }
  /**
   * Provider 原生 textFormat 透传（内容审核多轮工具循环在用）。
   * 可移植代码请用 jsonSchema；两者都给时以 nativeTextFormat 为准。
   */
  nativeTextFormat?: Record<string, unknown>
  /** 函数调用工具定义（诊断模块在用）。 */
  tools?: readonly Record<string, unknown>[]
  /** 流式输出（问题生成模块在用）。 */
  stream?: boolean
  /** 流式增量回调。 */
  onOutputTextDelta?: (delta: string) => void | Promise<void>
  /** 不保留服务端历史（部分模块要求无状态）。 */
  stateless?: boolean
  /** 关闭思考过程（内容审核模块在用）。 */
  disableThinking?: boolean
  timeoutMs?: number
  timeoutScope?: 'headers' | 'full'
  signal?: AbortSignal
  /** 测试注入：自定义 fetch / endpoint。 */
  fetch?: typeof fetch
  endpoint?: string
  /**
   * 可选的请求耗时回调。provider 专属遥测，尽力而为：
   * 实现可以忽略它，调用方不得依赖它做业务判断。
   */
  onTiming?: DoubaoTimingCallback
}

/** 适配器归一化输出。 */
export interface AdapterGenerateOutput {
  /** 提取出的正文文本（可能为 null，由调用方按需解析 JSON）。 */
  text: string | null
  /** 模型实际返回的 model 字段。 */
  responseModel: string | null
  /** 引用链接（豆包从 annotations 提取；其他 provider 按各自格式实现）。 */
  citationUrls: string[]
  /** 原始 payload：JSON 解析等逻辑继续用它，与之前行为一致。 */
  raw: unknown
}

export interface ModelAdapter {
  /** 注册表 key，如 'doubao'。 */
  readonly providerId: string
  /** 设置页下拉框里显示的名字。 */
  readonly displayName: string
  generate(input: AdapterGenerateInput): Promise<AdapterGenerateOutput>
}

/** 豆包适配器：把归一化输入映射到 Responses 接口。 */
export class DoubaoAdapter implements ModelAdapter {
  readonly providerId = 'doubao'
  readonly displayName = '豆包'

  async generate(input: AdapterGenerateInput): Promise<AdapterGenerateOutput> {
    const raw = await requestDoubaoResponses({
      apiKey: input.apiKey,
      modelId: input.modelId,
      input: input.prompt,
      textFormat: input.nativeTextFormat ?? (input.jsonSchema
        ? { type: 'json_schema', name: input.jsonSchema.name, strict: true, schema: input.jsonSchema.schema }
        : undefined),
      tools: input.tools,
      stream: input.stream,
      onOutputTextDelta: input.onOutputTextDelta,
      store: input.stateless ? false : undefined,
      thinking: input.disableThinking ? { type: 'disabled' } : undefined,
      timeoutMs: input.timeoutMs,
      timeoutScope: input.timeoutScope,
      signal: input.signal,
      fetch: input.fetch,
      endpoint: input.endpoint,
      onTiming: input.onTiming,
    })
    return {
      text: extractResponseText(raw),
      responseModel: extractResponseModel(raw),
      citationUrls: extractCitationUrls(raw),
      raw,
    }
  }
}

const registry = new Map<string, ModelAdapter>([['doubao', new DoubaoAdapter()]])

/** 注册新 provider 的适配器（未来接 DeepSeek/通义等时用）。 */
export function registerAdapter(adapter: ModelAdapter): void {
  registry.set(adapter.providerId, adapter)
}

export function getAdapter(providerId: string): ModelAdapter {
  const adapter = registry.get(providerId)
  if (!adapter) throw new Error(`未知的模型 provider：${providerId}`)
  return adapter
}

/** 设置页下拉框的数据源。 */
export function listProviders(): Array<{ providerId: string; displayName: string }> {
  return [...registry.values()].map((a) => ({ providerId: a.providerId, displayName: a.displayName }))
}
