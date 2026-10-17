/**
 * v0.3.0 适配器测试：接口归一化、豆包映射、注册表。
 */
import { describe, expect, it, vi } from 'vitest'
import { DoubaoAdapter, getAdapter, listProviders, registerAdapter, type ModelAdapter } from './model-adapters.ts'

describe('ModelAdapter 注册表', () => {
  it('内置只有豆包', () => {
    expect(listProviders()).toEqual([{ providerId: 'doubao', displayName: '豆包' }])
  })

  it('getAdapter 未知 provider 抛错', () => {
    expect(() => getAdapter('nope')).toThrow('未知的模型 provider')
  })

  it('可注册新适配器（一家一家单独接）', () => {
    const fake: ModelAdapter = {
      providerId: 'fake',
      displayName: 'Fake',
      generate: async () => ({ text: 'hi', responseModel: 'fake-1', citationUrls: [], raw: {} }),
    }
    registerAdapter(fake)
    expect(getAdapter('fake')).toBe(fake)
    expect(listProviders().some((p) => p.providerId === 'fake')).toBe(true)
  })
})

describe('DoubaoAdapter 映射', () => {
  it('归一化输入正确映射到 Responses 参数', async () => {
    const seen: Array<{ input: unknown; init?: RequestInit }> = []
    const fakeFetch = (async (input: unknown, init?: RequestInit) => {
      seen.push({ input, init })
      return new Response(
        JSON.stringify({ output_text: '你好', model: 'doubao-seed-1-6', output: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch

    const adapter = new DoubaoAdapter()
    const out = await adapter.generate({
      apiKey: 'k',
      modelId: 'm',
      prompt: 'hi',
      jsonSchema: { name: 's', schema: { type: 'object' } },
      fetch: fakeFetch,
      endpoint: 'https://example.test/v3/responses',
    })

    expect(out.text).toBe('你好')
    expect(out.responseModel).toBe('doubao-seed-1-6')
    expect(out.citationUrls).toEqual([])
    const body = JSON.parse(String(seen[0]?.init?.body))
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 's' })
  })

  it('stateless/disableThinking/nativeTextFormat 透传', async () => {
    const bodies: unknown[] = []
    const fakeFetch = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ output_text: 'ok', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof fetch

    const adapter = new DoubaoAdapter()
    await adapter.generate({
      apiKey: 'k',
      modelId: 'm',
      prompt: [{ role: 'user', content: 'hi' }],
      nativeTextFormat: { type: 'custom', name: 'x' },
      stateless: true,
      disableThinking: true,
      tools: [{ type: 'function', name: 'f' }],
      fetch: fakeFetch,
      endpoint: 'https://example.test/v3/responses',
    })
    const body = bodies[0] as Record<string, unknown>
    expect(body.store).toBe(false)
    expect(body.thinking).toEqual({ type: 'disabled' })
    expect(body.text).toEqual({ format: { type: 'custom', name: 'x' } })
    expect(body.tools).toHaveLength(1)
  })
})
