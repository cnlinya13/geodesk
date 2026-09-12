import { createServer } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const undiciMock = vi.hoisted(() => {
  const agents: Array<{
    options: Record<string, number>
    close: ReturnType<typeof vi.fn>
  }> = []
  const Agent = vi.fn(class FakeAgent {
    options: Record<string, number>
    close = vi.fn().mockResolvedValue(undefined)

    constructor(options: Record<string, number>) {
      this.options = options
      agents.push(this)
    }
  })
  return { Agent, agents }
})

vi.mock('undici', () => ({ Agent: undiciMock.Agent }))

import { DoubaoResponsesError, doubaoResponsesDefaults, requestDoubaoResponses } from './doubao-client.ts'

const apiKey = 'test-secret-key'
const testEndpoint = 'https://test-endpoint.example.test/api/v3/responses'
const originalEndpoint = process.env.DOUBAO_API_ENDPOINT

beforeEach(() => {
  process.env.DOUBAO_API_ENDPOINT = testEndpoint
})

afterEach(() => {
  undiciMock.Agent.mockClear()
  undiciMock.agents.length = 0
  if (originalEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
  else process.env.DOUBAO_API_ENDPOINT = originalEndpoint
})

function requestWith(response: Response): Promise<unknown> {
  return requestDoubaoResponses({
    apiKey,
    modelId: 'test-model',
    input: '测试问题',
    fetch: async () => response,
  })
}

describe('requestDoubaoResponses endpoint configuration', () => {
  it('reads the endpoint at request time and preserves the Responses request parameters', async () => {
    const configuredEndpoint = 'https://late-endpoint.example.test/api/v3/responses'
    const previousEndpoint = process.env.DOUBAO_API_ENDPOINT
    process.env.DOUBAO_API_ENDPOINT = configuredEndpoint
    let requestUrl: string | undefined
    let requestBody: Record<string, unknown> | undefined
    try {
      const payload = await requestDoubaoResponses({
        apiKey,
        modelId: 'test-model',
        input: '配置读取时机',
        thinking: { type: 'disabled' },
        store: false,
        textFormat: { type: 'json_schema', strict: true },
        fetch: async (url, init) => {
          requestUrl = String(url)
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
          return new Response(JSON.stringify({ ok: true }), { status: 200 })
        },
      })

      expect(payload).toEqual({ ok: true })
      expect(requestUrl).toBe(configuredEndpoint)
      expect(requestBody).toMatchObject({
        model: 'test-model',
        input: '配置读取时机',
        store: false,
        thinking: { type: 'disabled' },
        text: { format: { type: 'json_schema', strict: true } },
      })
      expect(doubaoResponsesDefaults.endpoint).toBe(configuredEndpoint)
    } finally {
      if (previousEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
      else process.env.DOUBAO_API_ENDPOINT = previousEndpoint
    }
  })

  it.each([
    ['missing', undefined],
    ['blank', ' \t\n'],
    ['invalid', 'not-a-url'],
    ['non-HTTPS product URL', 'http://remote.example.test/api/v3/responses'],
    ['credential-bearing URL', 'https://user:password@example.test/api/v3/responses'],
  ] as const)('rejects a %s configured URL before fetch', async (_label, configuredEndpoint) => {
    const previousEndpoint = process.env.DOUBAO_API_ENDPOINT
    if (configuredEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
    else process.env.DOUBAO_API_ENDPOINT = configuredEndpoint
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    try {
      const error = await requestDoubaoResponses({
        apiKey,
        modelId: 'test-model',
        input: '无效配置',
        fetch,
      }).catch((value: unknown) => value)
      expect(error).toBeInstanceOf(DoubaoResponsesError)
      expect((error as Error).message).toContain('DOUBAO_API_ENDPOINT')
      if (configuredEndpoint !== undefined) expect((error as Error).message).not.toContain(configuredEndpoint)
      expect(fetch).not.toHaveBeenCalled()
    } finally {
      if (previousEndpoint === undefined) delete process.env.DOUBAO_API_ENDPOINT
      else process.env.DOUBAO_API_ENDPOINT = previousEndpoint
    }
  })

  it('keeps an explicit loopback HTTP endpoint available as a test override', async () => {
    const explicitEndpoint = 'http://127.0.0.1:43210/test-override'
    let requestUrl: string | undefined
    await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '显式测试地址',
      endpoint: explicitEndpoint,
      fetch: async (url) => {
        requestUrl = String(url)
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })
    expect(requestUrl).toBe(explicitEndpoint)
  })

  it('ignores reserved provider fields and works with those fields unset', async () => {
    const reservedKeys = [
      'DEEPSEEK_API_ENDPOINT', 'DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL_ID',
      'QWEN_API_ENDPOINT', 'QWEN_API_KEY', 'QWEN_MODEL_ID',
    ] as const
    const previousValues = Object.fromEntries(reservedKeys.map((key) => [key, process.env[key]])) as Record<string, string | undefined>
    const configuredEndpoint = 'https://doubao-only.example.test/api/v3/responses'
    process.env.DOUBAO_API_ENDPOINT = configuredEndpoint
    for (const key of reservedKeys) process.env[key] = key.endsWith('ENDPOINT') ? 'not-a-url' : 'fake-provider-value'
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }))
    try {
      await requestDoubaoResponses({ apiKey, modelId: 'test-model', input: '仅豆包', fetch })
      expect(fetch).toHaveBeenCalledTimes(1)
      expect((fetch.mock.calls[0] as unknown[] | undefined)?.[0]).toBe(configuredEndpoint)

      for (const key of reservedKeys) delete process.env[key]
      await requestDoubaoResponses({ apiKey, modelId: 'test-model', input: '未设置其他服务商', fetch })
      expect(fetch).toHaveBeenCalledTimes(2)
      expect((fetch.mock.calls[1] as unknown[] | undefined)?.[0]).toBe(configuredEndpoint)
    } finally {
      for (const key of reservedKeys) {
        const previous = previousValues[key]
        if (previous === undefined) delete process.env[key]
        else process.env[key] = previous
      }
    }
  })
})

describe('requestDoubaoResponses long-timeout dispatcher', () => {
  it('creates a per-request Agent with matching header/body timeouts and closes it after success', async () => {
    let requestInit: RequestInit & { dispatcher?: unknown } | undefined
    const payload = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '长超时请求',
      timeoutMs: 300_001,
      fetch: async (_url, init) => {
        requestInit = init as RequestInit & { dispatcher?: unknown }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })

    expect(payload).toEqual({ ok: true })
    expect(undiciMock.Agent).toHaveBeenCalledTimes(1)
    expect(undiciMock.agents).toHaveLength(1)
    expect(undiciMock.agents[0]?.options).toEqual({ headersTimeout: 300_001, bodyTimeout: 300_001 })
    expect(requestInit?.dispatcher).toBe(undiciMock.agents[0])
    expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('does not create or pass a dispatcher for requests at or below five minutes', async () => {
    let requestInit: RequestInit & { dispatcher?: unknown } | undefined
    await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '短超时请求',
      timeoutMs: 300_000,
      fetch: async (_url, init) => {
        requestInit = init as RequestInit & { dispatcher?: unknown }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })

    expect(undiciMock.Agent).not.toHaveBeenCalled()
    expect(undiciMock.agents).toHaveLength(0)
    expect(requestInit?.dispatcher).toBeUndefined()
  })

  it('disables Undici headers/body deadlines for the default unbounded request', async () => {
    let requestInit: RequestInit & { dispatcher?: unknown } | undefined
    const payload = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '默认无截止请求',
      fetch: async (_url, init) => {
        requestInit = init as RequestInit & { dispatcher?: unknown }
        return new Response(JSON.stringify({ ok: true }), { status: 200 })
      },
    })

    expect(payload).toEqual({ ok: true })
    expect(undiciMock.Agent).toHaveBeenCalledTimes(1)
    expect(undiciMock.agents[0]?.options).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
    expect(requestInit?.dispatcher).toBe(undiciMock.agents[0])
    expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['network', async () => { throw new Error('network failure') }],
    ['http', async () => new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 })],
    ['parse', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }) as unknown as Response],
    ['abort', async () => ({ ok: true, status: 200, json: async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error } }) as unknown as Response],
  ])('closes the per-request Agent on %s failure', async (_failure, fetch) => {
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '失败清理',
      timeoutMs: 300_001,
      fetch,
    })).rejects.toBeInstanceOf(DoubaoResponsesError)

    expect(undiciMock.Agent).toHaveBeenCalledTimes(1)
    expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
  })
})

describe('requestDoubaoResponses unbounded and caller-abort behavior', () => {
  it('does not self-abort while an unbounded response body remains pending', async () => {
    let resolveBody: ((value: unknown) => void) | undefined
    let requestSignal: AbortSignal | undefined
    const request = requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '长时间未响应',
      fetch: async (_url, init) => {
        requestSignal = init?.signal as AbortSignal
        return {
          ok: true,
          status: 200,
          json: () => new Promise<unknown>((resolve) => { resolveBody = resolve }),
        } as unknown as Response
      },
    })

    let settled = false
    void request.then(() => { settled = true }, () => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(settled).toBe(false)
    expect(requestSignal?.aborted).toBe(false)

    resolveBody?.({ ok: true })
    await expect(request).resolves.toEqual({ ok: true })
    expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('aborts a pending body on the caller signal and closes the dispatcher', async () => {
    const controller = new AbortController()
    const request = requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '资料变更停止',
      signal: controller.signal,
      fetch: async () => ({
        ok: true,
        status: 200,
        json: () => new Promise<unknown>(() => undefined),
      }) as unknown as Response,
    })

    controller.abort()
    await expect(request).rejects.toMatchObject({ message: '豆包请求超时' })
    expect(undiciMock.Agent).toHaveBeenCalledTimes(1)
    expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
  })

  it('does not invoke fetch for a pre-aborted signal or leave its rejection unhandled', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetch = vi.fn(() => Promise.reject(new Error('不应调用fetch')))
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(requestDoubaoResponses({
        apiKey,
        modelId: 'test-model',
        input: '预先停止',
        signal: controller.signal,
        fetch,
      })).rejects.toMatchObject({ message: '豆包请求超时' })
      await new Promise((resolve) => setImmediate(resolve))
      expect(fetch).not.toHaveBeenCalled()
      expect(unhandled).toEqual([])
      expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps delayed real local HTTP headers/body alive at timeout 0 and releases on external abort', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/delayed') {
        const headerTimer = setTimeout(() => {
          response.writeHead(200, { 'content-type': 'application/json' })
          setTimeout(() => response.end(JSON.stringify({ ok: true })), 40)
        }, 40)
        request.once('close', () => clearTimeout(headerTimer))
        return
      }
      if (request.url === '/abort') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.flushHeaders()
        const bodyTimer = setTimeout(() => response.end(JSON.stringify({ ok: true })), 500)
        request.once('close', () => clearTimeout(bodyTimer))
        return
      }
      response.writeHead(404)
      response.end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('本地HTTP fixture未监听端口')
    const endpoint = `http://127.0.0.1:${address.port}`
    const realFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
      const { dispatcher: _dispatcher, ...nativeInit } = (init ?? {}) as RequestInit & { dispatcher?: unknown }
      return globalThis.fetch(input, nativeInit)
    }

    try {
      await expect(requestDoubaoResponses({
        apiKey,
        modelId: 'test-model',
        input: '本地延迟fixture',
        endpoint: `${endpoint}/delayed`,
        timeoutMs: 0,
        fetch: realFetch,
      })).resolves.toEqual({ ok: true })
      expect(undiciMock.agents[0]?.options).toEqual({ headersTimeout: 0, bodyTimeout: 0 })
      expect(undiciMock.agents[0]?.close).toHaveBeenCalledTimes(1)

      const controller = new AbortController()
      const abortedRequest = requestDoubaoResponses({
        apiKey,
        modelId: 'test-model',
        input: '本地外部abort fixture',
        endpoint: `${endpoint}/abort`,
        timeoutMs: 0,
        signal: controller.signal,
        fetch: realFetch,
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      controller.abort()
      await expect(abortedRequest).rejects.toMatchObject({ message: '豆包请求超时' })
      expect(undiciMock.agents).toHaveLength(2)
      expect(undiciMock.agents[1]?.close).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
    }
  })
})

describe('requestDoubaoResponses thinking option', () => {
  it('omits thinking by default and forwards it only when explicitly provided', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    const response = () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return response()
    }

    await requestDoubaoResponses({ apiKey, modelId: 'test-model', input: '默认不应传thinking', fetch })
    await requestDoubaoResponses({ apiKey, modelId: 'test-model', input: '显式关闭thinking', thinking: { type: 'disabled' }, fetch })
    await requestDoubaoResponses({ apiKey, modelId: 'test-model', input: '显式开启thinking', thinking: { type: 'enabled' }, fetch })

    expect(requestBodies[0]).not.toHaveProperty('thinking')
    expect(requestBodies[1]).toMatchObject({ thinking: { type: 'disabled' } })
    expect(requestBodies[2]).toMatchObject({ thinking: { type: 'enabled' } })
  })
})

describe('requestDoubaoResponses provider errors', () => {
  it('emits safe ordered timing events and isolates callback errors', async () => {
    const events: Array<Record<string, unknown>> = []
    const response = new Response(JSON.stringify({ ok: true }), { status: 200 })
    const payload = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '不应进入事件',
      timeoutScope: 'full',
      onTiming: (event) => {
        events.push(event)
        throw new Error('timing callback failure')
      },
      fetch: async () => response,
    })
    expect(payload).toMatchObject({ ok: true })
    expect(events.map((event) => event.event)).toEqual([
      'request_start', 'response_headers', 'body_read_start', 'body_read_end',
    ])
    expect(new Set(events.map((event) => event.correlationId)).size).toBe(1)
    expect(events.every((event) => event.timeoutMs === 0)).toBe(true)
    expect(JSON.stringify(events)).not.toContain(apiKey)
    expect(events.at(-1)).toMatchObject({ bodyReadIncludesJson: true, httpStatus: 200 })
  })

  it('classifies a headers network failure without pretending that body reading started', async () => {
    const events: Array<Record<string, unknown>> = []
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      onTiming: (event) => events.push(event),
      fetch: async () => { throw new Error('network failure') },
    })).rejects.toMatchObject({ message: '豆包请求失败' })
    expect(events.map((event) => event.event)).toEqual(['request_start', 'request_failed'])
    expect(events.at(-1)).toMatchObject({ failurePhase: 'waiting_headers', failureKind: 'network' })
  })

  it('classifies a headers timeout separately from a body timeout', async () => {
    const headerEvents: Array<Record<string, unknown>> = []
    const abort = new Error('aborted'); abort.name = 'AbortError'
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      onTiming: (event) => headerEvents.push(event),
      fetch: async () => { throw abort },
    })).rejects.toMatchObject({ message: '豆包请求超时' })
    expect(headerEvents.at(-1)).toMatchObject({ failurePhase: 'waiting_headers', failureKind: 'timeout' })

    const bodyEvents: Array<Record<string, unknown>> = []
    const bodyPromise = requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      timeoutMs: 10,
      timeoutScope: 'full',
      onTiming: (event) => bodyEvents.push(event),
      fetch: async () => ({ ok: true, status: 200, json: () => new Promise<unknown>(() => undefined) }) as unknown as Response,
    })
    await expect(bodyPromise).rejects.toMatchObject({ message: '豆包请求超时' })
    expect(bodyEvents.map((event) => event.event)).toEqual([
      'request_start', 'response_headers', 'body_read_start', 'request_failed',
    ])
    expect(bodyEvents.at(-1)).toMatchObject({ failurePhase: 'reading_body', failureKind: 'timeout', httpStatus: 200 })
  })

  it('records non-2xx body completion and classifies the final failure as HTTP', async () => {
    const events: Array<Record<string, unknown>> = []
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      onTiming: (event) => events.push(event),
      fetch: async () => new Response(JSON.stringify({ error: { code: 'bad_request' } }), { status: 400 }),
    })).rejects.toMatchObject({ status: 400 })
    expect(events.map((event) => event.event)).toEqual([
      'request_start', 'response_headers', 'body_read_start', 'body_read_end', 'request_failed',
    ])
    expect(events.at(-1)).toMatchObject({ failurePhase: 'reading_body', failureKind: 'http', httpStatus: 400 })
    expect(events.at(-2)).toMatchObject({ bodyReadIncludesJson: true, httpStatus: 400 })
  })

  it('classifies successful-response JSON decoding errors as parse failures', async () => {
    const events: Array<Record<string, unknown>> = []
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      onTiming: (event) => events.push(event),
      fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json') } }) as unknown as Response,
    })).rejects.toMatchObject({ message: '豆包返回的内容无法解析' })
    expect(events.map((event) => event.event)).toEqual([
      'request_start', 'response_headers', 'body_read_start', 'request_failed',
    ])
    expect(events.at(-1)).toMatchObject({ failurePhase: 'reading_body', failureKind: 'parse', httpStatus: 200 })
  })

  it('covers the complete response body when the caller opts into full timeout', async () => {
    const response = {
      ok: true,
      json: () => new Promise<unknown>(() => undefined),
    } as unknown as Response
    const error = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      timeoutMs: 10,
      timeoutScope: 'full',
      fetch: async () => response,
    }).catch((value: unknown) => value)
    expect(error).toMatchObject({ message: '豆包请求超时' })
  })

  it('classifies a timed-out non-2xx provider body as a timeout', async () => {
    const response = {
      ok: false,
      status: 502,
      text: () => new Promise<string>(() => undefined),
    } as unknown as Response
    const error = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '测试问题',
      timeoutMs: 10,
      timeoutScope: 'full',
      fetch: async () => response,
    }).catch((value: unknown) => value)
    expect(error).toMatchObject({ message: '豆包请求超时' })
  })

  it('includes provider code and message from a JSON error while redacting credentials', async () => {
    const response = new Response(JSON.stringify({
      error: {
        code: 'ResourceNotFound',
        message: `request rejected: Authorization: Bearer ${apiKey}`,
      },
    }), { status: 404, headers: { 'content-type': 'application/json' } })

    const error = await requestWith(response).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(DoubaoResponsesError)
    expect(error).toMatchObject({
      status: 404,
      providerCode: 'ResourceNotFound',
      providerMessage: 'request rejected: Authorization: Bearer [REDACTED]',
    })
    expect((error as Error).message).toBe('豆包请求失败（HTTP 404）：ResourceNotFound: request rejected: Authorization: Bearer [REDACTED]')
    expect((error as Error).message).not.toContain(apiKey)
  })

  it('falls back to the HTTP-only message for non-JSON or unrelated error bodies', async () => {
    const htmlError = await requestWith(new Response('<html>gateway error</html>', { status: 502 })).catch((value: unknown) => value)
    expect(htmlError).toMatchObject({
      status: 502,
      providerCode: null,
      providerMessage: null,
      message: '豆包请求失败（HTTP 502）',
    })

    const unrelatedJson = await requestWith(new Response(JSON.stringify({ detail: 'gateway error' }), { status: 503 })).catch((value: unknown) => value)
    expect(unrelatedJson).toMatchObject({
      status: 503,
      providerCode: null,
      providerMessage: null,
      message: '豆包请求失败（HTTP 503）',
    })
  })

  it('limits provider error fields to short single-line values', async () => {
    const error = await requestWith(new Response(JSON.stringify({
      code: 'x'.repeat(200),
      message: 'line 1\n' + 'x'.repeat(500),
    }), { status: 400 })).catch((value: unknown) => value)

    expect(error).toBeInstanceOf(DoubaoResponsesError)
    const providerError = error as DoubaoResponsesError
    expect(providerError.providerCode).toHaveLength(120)
    expect(providerError.providerMessage).toHaveLength(360)
    expect(providerError.providerMessage).not.toContain('\n')
  })
})

describe('requestDoubaoResponses streaming Responses protocol', () => {
  function streamBody(events: string[]): ReadableStream<Uint8Array> {
    const bytes = new TextEncoder().encode(events.join(''))
    let offset = 0
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) {
          controller.close()
          return
        }
        const end = Math.min(bytes.length, offset + 1)
        controller.enqueue(bytes.slice(offset, end))
        offset = end
      },
    })
  }

  it('sends stream=true and forwards text deltas, completing only at response.completed', async () => {
    const deltas: string[] = []
    let requestBody: Record<string, unknown> | undefined
    const response = new Response(streamBody([
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '你' })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '好' })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { output_text: '你好' } })}\n\n`,
    ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    const result = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '流式请求',
      stream: true,
      onOutputTextDelta: (delta) => { deltas.push(delta) },
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        expect((init?.headers as Record<string, string>).accept).toBe('text/event-stream')
        return response
      },
    })

    expect(result).toEqual({ output_text: '你好' })
    expect(deltas).toEqual(['你', '好'])
    expect(requestBody).toMatchObject({ stream: true })
  })

  it.each([
    ['failed', { type: 'response.failed', response: { error: { code: 'failed', message: `secret ${apiKey}` } } }],
    ['incomplete', { type: 'response.incomplete' }],
    ['error', { type: 'error', error: { code: 'bad', message: `Bearer ${apiKey}` } }],
  ])('rejects a %s terminal event without leaking provider credentials', async (_label, event) => {
    const response = new Response(streamBody([`data: ${JSON.stringify(event)}\n\n`]), { status: 200 })
    const error = await requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '流式失败',
      stream: true,
      fetch: async () => response,
    }).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(DoubaoResponsesError)
    expect((error as Error).message).not.toContain(apiKey)
  })

  it('rejects EOF without response.completed and cancels a completed stream without waiting for EOF', async () => {
    const incompleteResponse = new Response(streamBody([
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{' })}\n\n`,
    ]), { status: 200 })
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '断流',
      stream: true,
      fetch: async () => incompleteResponse,
    })).rejects.toMatchObject({ message: '豆包流式响应未完成' })

    const reader = {
      read: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    const completedBytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.completed', response: { output_text: '完成' } })}\n\n`)
    reader.read.mockResolvedValueOnce({ value: completedBytes, done: false })
    reader.read.mockImplementationOnce(() => new Promise(() => undefined))
    const response = {
      ok: true,
      status: 200,
      body: { getReader: () => reader },
    } as unknown as Response
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '提前结束',
      stream: true,
      fetch: async () => response,
    })).resolves.toEqual({ output_text: '完成' })
    expect(reader.read).toHaveBeenCalledTimes(1)
    expect(reader.cancel).toHaveBeenCalledTimes(1)
  })

  it('applies the timeout to the full stream and cancels a pending reader', async () => {
    const reader = {
      read: vi.fn(() => new Promise<never>(() => undefined)),
      cancel: vi.fn().mockResolvedValue(undefined),
    }
    const response = { ok: true, status: 200, body: { getReader: () => reader } } as unknown as Response
    await expect(requestDoubaoResponses({
      apiKey,
      modelId: 'test-model',
      input: '流式超时',
      stream: true,
      timeoutMs: 10,
      fetch: async () => response,
    })).rejects.toMatchObject({ message: '豆包请求超时' })
    await vi.waitFor(() => expect(reader.cancel).toHaveBeenCalledTimes(1))
  })
})
