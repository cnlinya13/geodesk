import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { Agent } from 'undici'

export type DoubaoFetch = typeof fetch

/**
 * Responses accepts either a convenience string or a sequence of input
 * items.  The latter is required when a caller keeps the complete temporary
 * function-calling transcript while using `store:false`.
 */
export type DoubaoInputItem = Record<string, unknown>
export type DoubaoInput = string | readonly DoubaoInputItem[]

type DoubaoRequestInit = Omit<RequestInit, 'dispatcher'> & { dispatcher?: Agent }
type DoubaoDispatcherFetch = (input: Parameters<typeof fetch>[0], init?: DoubaoRequestInit) => ReturnType<typeof fetch>

export type DoubaoTimingEventName =
  | 'request_start'
  | 'response_headers'
  | 'body_read_start'
  | 'body_read_end'
  | 'request_failed'

export type DoubaoTimingFailurePhase = 'waiting_headers' | 'reading_body'
export type DoubaoTimingFailureKind = 'timeout' | 'network' | 'http' | 'parse'

export type DoubaoTimingEvent = {
  event: DoubaoTimingEventName
  correlationId: string
  elapsedMs: number
  timeoutMs: number
  headersElapsedMs?: number
  bodyReadMs?: number
  /** True when bodyReadMs includes JSON decoding or the provider-error JSON parse attempt. */
  bodyReadIncludesJson?: boolean
  httpStatus?: number
  failurePhase?: DoubaoTimingFailurePhase
  failureKind?: DoubaoTimingFailureKind
}

export type DoubaoTimingCallback = (event: DoubaoTimingEvent) => void

export type DoubaoOutputTextDeltaCallback = (delta: string) => void | Promise<void>

export type DoubaoResponsesOptions = {
  apiKey: string
  modelId: string
  input: DoubaoInput
  thinking?: { type: 'disabled' | 'enabled' | 'auto' }
  tools?: readonly Record<string, unknown>[]
  textFormat?: Record<string, unknown>
  fetch?: DoubaoFetch
  endpoint?: string
  timeoutMs?: number
  /** Optional caller-owned signal (for example, invalidating a project run). */
  signal?: AbortSignal
  /** Article generation opts into covering the complete HTTP response body. */
  timeoutScope?: 'headers' | 'full'
  /** Request the Responses SSE protocol instead of one JSON response. */
  stream?: boolean
  /** Keep provider-side history disabled when a caller owns the transcript. */
  store?: boolean
  /** Receives each output_text delta while a streamed response is read. */
  onOutputTextDelta?: DoubaoOutputTextDeltaCallback
  /** Optional safe lifecycle telemetry. Exceptions from this callback are ignored. */
  onTiming?: DoubaoTimingCallback
}

export type DoubaoProviderError = {
  code: string | null
  message: string | null
}

export class DoubaoResponsesError extends Error {
  readonly status: number | null
  readonly providerCode: string | null
  readonly providerMessage: string | null

  constructor(message: string, status: number | null = null, providerError: DoubaoProviderError | null = null) {
    super(message)
    this.name = 'DoubaoResponsesError'
    this.status = status
    this.providerCode = providerError?.code ?? null
    this.providerMessage = providerError?.message ?? null
  }
}

const MAX_PROVIDER_ERROR_CODE_LENGTH = 120
const MAX_PROVIDER_ERROR_MESSAGE_LENGTH = 360
const MAX_PROVIDER_ERROR_BODY_LENGTH = 32_768

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function abortError(): Error {
  const error = new Error('aborted')
  error.name = 'AbortError'
  return error
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '[::1]'
    || normalized === '::1'
}

/**
 * Resolve the endpoint only when a request is about to be sent.  The server
 * database module loads `.env.local` during its own module evaluation, while
 * this module can be evaluated earlier as an ESM dependency.
 */
function resolveEndpoint(explicitEndpoint: string | undefined): string {
  const value = explicitEndpoint === undefined ? process.env.DOUBAO_API_ENDPOINT : explicitEndpoint
  const endpoint = typeof value === 'string' ? value.trim() : ''
  if (!endpoint) throw new DoubaoResponsesError('未配置DOUBAO_API_ENDPOINT')

  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new DoubaoResponsesError('DOUBAO_API_ENDPOINT配置无效')
  }

  if (parsed.username || parsed.password) {
    throw new DoubaoResponsesError('DOUBAO_API_ENDPOINT配置无效')
  }
  if (parsed.protocol === 'https:') return endpoint
  // Explicit endpoints remain available for isolated tests and local HTTP
  // fixtures, but production configuration must be HTTPS and non-loopback
  // HTTP must never become a silent fallback.
  if (explicitEndpoint !== undefined && parsed.protocol === 'http:' && isLoopbackHostname(parsed.hostname)) {
    return endpoint
  }
  throw new DoubaoResponsesError('DOUBAO_API_ENDPOINT配置无效')
}

/** Race an operation with a caller-owned abort signal and clean up the listener. */
async function raceWithAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation()
  if (signal.aborted) throw abortError()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    // Abort can happen between the check above and listener registration.
    if (signal.aborted) onAbort()
  })
  try {
    // Keep the factory lazy: a pre-aborted signal must not start an operation
    // whose rejection would otherwise become unhandled after this function
    // exits on the signal check above.
    if (signal.aborted) throw abortError()
    return await Promise.race([operation(), aborted])
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Error responses are provider-controlled input. Keep only short code/message
 * fields and redact credentials before allowing them to reach the UI or DB.
 */
function safeProviderText(value: unknown, maxLength: number, apiKey: string): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  let text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!text) return null
  text = text
    .replace(
      /\b(authorization|api[-_ ]?key|access[-_ ]?token|token|secret|password)\b(\s*[:=]\s*)(Bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      (_match: string, label: string, separator: string, bearer?: string) => `${label}${separator}${bearer ?? ''}[REDACTED]`,
    )
  if (apiKey) text = text.replace(new RegExp(escapeRegExp(apiKey), 'g'), '[REDACTED]')
  text = text.replace(/\bBearer\s+[^\s,;}"']+/gi, 'Bearer [REDACTED]')
  text = text
    .trim()
  return text.slice(0, maxLength).trim() || null
}

function providerErrorFromBody(body: string, apiKey: string): DoubaoProviderError | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(0, MAX_PROVIDER_ERROR_BODY_LENGTH))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const nestedError = isRecord(parsed.error) ? parsed.error : null
  const code = safeProviderText(nestedError?.code ?? parsed.code, MAX_PROVIDER_ERROR_CODE_LENGTH, apiKey)
  const message = safeProviderText(nestedError?.message ?? parsed.message, MAX_PROVIDER_ERROR_MESSAGE_LENGTH, apiKey)
  if (!code && !message) return null
  return { code, message }
}

function formatProviderError(status: number, providerError: DoubaoProviderError | null): string {
  const base = `豆包请求失败（HTTP ${status}）`
  if (!providerError) return base
  const detail = [providerError.code, providerError.message].filter((value): value is string => Boolean(value)).join(': ')
  return detail ? `${base}：${detail}` : base
}

async function readProviderError(response: Response, apiKey: string): Promise<DoubaoProviderError | null> {
  try {
    return providerErrorFromBody(await response.text(), apiKey)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new DoubaoResponsesError('豆包请求超时')
    return null
  }
}

function streamedProviderError(value: unknown, apiKey: string): DoubaoProviderError | null {
  const candidates: unknown[] = [value]
  if (isRecord(value)) {
    candidates.unshift(value.error)
    const response = value.response
    if (isRecord(response)) candidates.unshift(response.error, response)
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const parsed = providerErrorFromBody(JSON.stringify(candidate), apiKey)
      if (parsed) return parsed
    } catch {
      // Ignore an unrepresentable provider payload and keep the safe generic
      // stream error instead.
    }
  }
  return null
}

function streamedFailure(type: string, value: unknown, apiKey: string): DoubaoResponsesError {
  const providerError = streamedProviderError(value, apiKey)
  const base = type === 'response.incomplete'
    ? '豆包流式响应未完成'
    : '豆包流式响应失败'
  if (!providerError) return new DoubaoResponsesError(base, null, null)
  const detail = [providerError.code, providerError.message]
    .filter((part): part is string => Boolean(part))
    .join(': ')
  return new DoubaoResponsesError(detail ? `${base}：${detail}` : base, null, providerError)
}

type StreamedResponse = Record<string, unknown>

/**
 * Read Ark's Responses SSE stream. A response.completed event is the only
 * terminal success signal; EOF, [DONE], failed, incomplete, and error events
 * are all failures. The reader is always cancelled so a late provider stream
 * cannot keep the request or per-request dispatcher alive.
 */
async function readStreamedResponse(
  response: Response,
  apiKey: string,
  onOutputTextDelta?: DoubaoOutputTextDeltaCallback,
  signal?: AbortSignal,
): Promise<StreamedResponse> {
  if (!response.body) throw new DoubaoResponsesError('豆包流式响应为空')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName = ''
  let dataLines: string[] = []
  let completed: StreamedResponse | null = null

  const processEvent = async (): Promise<void> => {
    const data = dataLines.join('\n')
    const currentEvent = eventName
    eventName = ''
    dataLines = []
    if (!data) return
    if (data.trim() === '[DONE]') throw new DoubaoResponsesError('豆包流式响应未完成')

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new DoubaoResponsesError('豆包流式响应格式无效')
    }
    if (!isRecord(parsed)) throw new DoubaoResponsesError('豆包流式响应格式无效')
    const type = typeof parsed.type === 'string' ? parsed.type : currentEvent
    if (type === 'response.output_text.delta') {
      if (typeof parsed.delta !== 'string') throw new DoubaoResponsesError('豆包流式响应格式无效')
      if (onOutputTextDelta) {
        try {
          await onOutputTextDelta(parsed.delta)
        } catch {
          throw new DoubaoResponsesError('豆包流式内容处理失败')
        }
      }
      return
    }
    if (type === 'response.completed') {
      if (!isRecord(parsed.response)) throw new DoubaoResponsesError('豆包流式响应格式无效')
      completed = parsed.response
      return
    }
    if (type === 'response.failed' || type === 'response.incomplete' || type === 'error') {
      throw streamedFailure(type, parsed, apiKey)
    }
    // Unknown event types are intentionally ignored for forward compatibility.
  }

  const processLine = async (line: string): Promise<void> => {
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (line === '') {
      await processEvent()
      return
    }
    if (line.startsWith(':')) return
    const separator = line.indexOf(':')
    const field = separator < 0 ? line : line.slice(0, separator)
    let value = separator < 0 ? '' : line.slice(separator + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') eventName = value
    if (field === 'data') dataLines.push(value)
  }

  try {
    while (!completed) {
      const readResult = await (async () => {
        if (!signal) return reader.read()
        if (signal.aborted) {
          const aborted = new Error('aborted')
          aborted.name = 'AbortError'
          throw aborted
        }
        return new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
          const onAbort = (): void => {
            const aborted = new Error('aborted')
            aborted.name = 'AbortError'
            reject(aborted)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          void reader.read().then(
            (result) => {
              signal.removeEventListener('abort', onAbort)
              resolve(result)
            },
            (error: unknown) => {
              signal.removeEventListener('abort', onAbort)
              reject(error)
            },
          )
        })
      })()
      if (readResult.done) break
      buffer += decoder.decode(readResult.value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        await processLine(line)
        if (completed) break
        newlineIndex = buffer.indexOf('\n')
      }
    }
    if (completed) return completed
    buffer += decoder.decode()
    if (buffer) await processLine(buffer)
    // SSE permits a final event without a trailing blank line. The line above
    // leaves its data pending, so flush it before deciding whether EOF failed.
    if (dataLines.length > 0) await processEvent()
    if (!completed) throw new DoubaoResponsesError('豆包流式响应未完成')
    return completed
  } catch (error) {
    if (error instanceof DoubaoResponsesError) throw error
    if (error instanceof Error && error.name === 'AbortError') throw new DoubaoResponsesError('豆包请求超时')
    throw new DoubaoResponsesError('豆包流式响应读取失败')
  } finally {
    try {
      await reader.cancel()
    } catch {
      // Reader cleanup is best-effort and must not replace the provider error.
    }
  }
}

/**
 * The small shared boundary for Ark Responses calls. Callers decide what is
 * sent in `input`; this client deliberately does not add a system prompt.
 */
export async function requestDoubaoResponses(options: DoubaoResponsesOptions): Promise<unknown> {
  if (!options.apiKey.trim()) throw new DoubaoResponsesError('未配置DOUBAO_API_KEY')
  if (!options.modelId.trim()) throw new DoubaoResponsesError('未配置DOUBAO_MODEL_ID')
  const endpoint = resolveEndpoint(options.endpoint)

  // A missing or zero timeout means that this client must not impose a local
  // deadline.  Keep negative/invalid values from becoming an accidental
  // immediate abort; only an explicit positive value enables the compatibility
  // timeout used by tests and controlled callers.
  const configuredTimeoutMs = options.timeoutMs ?? 0
  const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
    ? configuredTimeoutMs
    : 0
  const hasDeadline = timeoutMs > 0
  const startedAt = Date.now()
  const correlationId = randomUUID()
  const emitTiming = (event: DoubaoTimingEventName, values: Omit<Partial<DoubaoTimingEvent>, 'event' | 'correlationId' | 'elapsedMs' | 'timeoutMs'> = {}): void => {
    if (!options.onTiming) return
    const elapsedMs = Math.max(0, Date.now() - startedAt)
    try {
      options.onTiming({ event, correlationId, elapsedMs, timeoutMs, ...values })
    } catch {
      // Timing is diagnostic-only and must never alter request behavior.
    }
  }
  // Keep the existing AbortError -> timeout classification for callers that
  // already handle that message.  A caller-owned abort is not a conclusion
  // that the elapsed request time exceeded a deadline.
  const isTimeout = (error: unknown): boolean => (
    (error instanceof Error && error.name === 'AbortError')
    || (error instanceof DoubaoResponsesError && error.message === '豆包请求超时')
  )
  const bodyFailureKind = (error: unknown): DoubaoTimingFailureKind => {
    if (isTimeout(error)) return 'timeout'
    if (error instanceof SyntaxError) return 'parse'
    return 'network'
  }
  emitTiming('request_start')

  // Undici's default headers/body timeouts would still terminate an otherwise
  // intentionally unbounded AI request.  Disable those two defaults for the
  // no-deadline mode.  For an explicit timeout beyond Undici's defaults, keep
  // the per-request dispatcher so the caller's value remains authoritative.
  const dispatcher = timeoutMs === 0 || timeoutMs > 300_000
    ? new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
    : undefined
  const closeDispatcher = async (): Promise<void> => {
    if (!dispatcher) return
    try {
      await dispatcher.close()
    } catch {
      // Dispatcher cleanup is best-effort and must not replace the request result.
    }
  }

  const body: Record<string, unknown> = {
    model: options.modelId,
    input: options.input,
  }
  if (options.stream) body.stream = true
  if (options.store !== undefined) body.store = options.store
  if (options.thinking !== undefined) body.thinking = options.thinking
  if (options.tools) body.tools = options.tools
  if (options.textFormat) body.text = { format: options.textFormat }

  const controller = new AbortController()
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal
  const deadline = hasDeadline ? Date.now() + timeoutMs : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  if (hasDeadline) timer = setTimeout(() => controller.abort(), timeoutMs)
  const requestInit: DoubaoRequestInit = {
    method: 'POST',
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      'content-type': 'application/json',
      ...(options.stream ? { accept: 'text/event-stream' } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal,
  }
  if (dispatcher) requestInit.dispatcher = dispatcher
  async function readFullResponse<T>(operation: () => Promise<T>): Promise<T> {
    const appliesBodyDeadline = hasDeadline && (options.timeoutScope === 'full' || options.stream)
    // The external signal remains effective after response headers have
    // arrived, including for the default headers-only timeout scope.  This is
    // important when a project update invalidates a still-reading request.
    const externalSignal = options.signal
    if (!appliesBodyDeadline && !externalSignal) return operation()
    if (externalSignal?.aborted) throw abortError()
    const remaining = appliesBodyDeadline ? Math.max(0, (deadline as number) - Date.now()) : undefined
    if (remaining === 0) throw new DoubaoResponsesError('豆包请求超时')
    let bodyTimer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!appliesBodyDeadline) return await raceWithAbort(operation, externalSignal)
      const timeout = new Promise<never>((_, reject) => {
        bodyTimer = setTimeout(() => {
          controller.abort()
          reject(new DoubaoResponsesError('豆包请求超时'))
        }, remaining)
      })
      return await raceWithAbort(() => Promise.race([operation(), timeout]), externalSignal)
    } finally {
      if (bodyTimer) clearTimeout(bodyTimer)
    }
  }
  let response: Response
  let responseReceived = false
  try {
    const fetchWithDispatcher = (options.fetch ?? fetch) as DoubaoDispatcherFetch
    response = await raceWithAbort(() => fetchWithDispatcher(endpoint, {
      ...requestInit,
    }), requestSignal)
    responseReceived = true
  } catch (error) {
    if (timer) clearTimeout(timer)
    const failureKind: DoubaoTimingFailureKind = isTimeout(error) ? 'timeout' : 'network'
    emitTiming('request_failed', { failurePhase: 'waiting_headers', failureKind })
    if (isTimeout(error)) {
      throw new DoubaoResponsesError('豆包请求超时')
    }
    throw new DoubaoResponsesError('豆包请求失败')
  } finally {
    if (timer && options.timeoutScope !== 'full' && !options.stream) clearTimeout(timer)
    if (!responseReceived) await closeDispatcher()
  }

  const headersElapsedMs = Math.max(0, Date.now() - startedAt)
  const httpStatus = typeof response.status === 'number' ? response.status : undefined
  emitTiming('response_headers', { headersElapsedMs, httpStatus })
  const bodyStartedAt = Date.now()
  emitTiming('body_read_start', { headersElapsedMs, httpStatus })

  if (!response.ok) {
    try {
      const providerError = await readFullResponse(() => readProviderError(response, options.apiKey))
      emitTiming('body_read_end', {
        headersElapsedMs,
        bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
        bodyReadIncludesJson: true,
        httpStatus,
      })
      emitTiming('request_failed', {
        headersElapsedMs,
        bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
        httpStatus,
        failurePhase: 'reading_body',
        failureKind: 'http',
      })
      throw new DoubaoResponsesError(formatProviderError(response.status, providerError), response.status, providerError)
    } catch (error) {
      if (error instanceof DoubaoResponsesError && error.status !== null) throw error
      emitTiming('request_failed', {
        headersElapsedMs,
        bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
        httpStatus,
        failurePhase: 'reading_body',
        failureKind: bodyFailureKind(error),
      })
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      await closeDispatcher()
    }
  }

  if (options.stream) {
    try {
      const payload = await readFullResponse(() => readStreamedResponse(response, options.apiKey, options.onOutputTextDelta, requestSignal))
      emitTiming('body_read_end', {
        headersElapsedMs,
        bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
        bodyReadIncludesJson: true,
        httpStatus,
      })
      return payload
    } catch (error) {
      emitTiming('request_failed', {
        headersElapsedMs,
        bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
        httpStatus,
        failurePhase: 'reading_body',
        failureKind: bodyFailureKind(error),
      })
      if (error instanceof DoubaoResponsesError) throw error
      if (isTimeout(error)) throw new DoubaoResponsesError('豆包请求超时')
      throw new DoubaoResponsesError('豆包流式响应读取失败')
    } finally {
      if (timer) clearTimeout(timer)
      await closeDispatcher()
    }
  }

  try {
    const payload = await readFullResponse(() => response.json())
    emitTiming('body_read_end', {
      headersElapsedMs,
      bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
      bodyReadIncludesJson: true,
      httpStatus,
    })
    return payload
  } catch (error) {
    const failureKind = bodyFailureKind(error)
    emitTiming('request_failed', {
      headersElapsedMs,
      bodyReadMs: Math.max(0, Date.now() - bodyStartedAt),
      httpStatus,
      failurePhase: 'reading_body',
      failureKind,
    })
    if (error instanceof DoubaoResponsesError) throw error
    if (isTimeout(error)) throw new DoubaoResponsesError('豆包请求超时')
    throw new DoubaoResponsesError('豆包返回的内容无法解析')
  } finally {
    if (timer) clearTimeout(timer)
    await closeDispatcher()
  }
}

export function extractResponseText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  if (typeof record.output_text === 'string' && record.output_text.trim()) return record.output_text.trim()

  const textParts: string[] = []
  const output = record.output
  if (Array.isArray(output)) {
    for (const item of output) {
      if (!item || typeof item !== 'object') continue
      const content = (item as Record<string, unknown>).content
      if (!Array.isArray(content)) continue
      for (const part of content) {
        if (!part || typeof part !== 'object') continue
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string') textParts.push(text)
      }
    }
  }
  return textParts.join('').trim() || null
}

export function extractResponseModel(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const model = (payload as Record<string, unknown>).model
  return typeof model === 'string' && model.trim() ? model.trim() : null
}

function httpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return value.trim()
  } catch {
    return null
  }
}

function annotationUrl(annotation: unknown): string | null {
  if (!annotation || typeof annotation !== 'object') return null
  const record = annotation as Record<string, unknown>
  const direct = httpUrl(record.url)
  if (direct) return direct
  for (const key of ['source', 'link', 'citation']) {
    const nested = record[key]
    if (!nested || typeof nested !== 'object') continue
    const url = httpUrl((nested as Record<string, unknown>).url)
    if (url) return url
  }
  return null
}

/** Extract only URLs attached to Responses `annotations`, never arbitrary output URLs. */
export function extractCitationUrls(payload: unknown): string[] {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const record = value as Record<string, unknown>
    const annotations = record.annotations
    if (Array.isArray(annotations)) {
      for (const annotation of annotations) {
        const url = annotationUrl(annotation)
        if (url) found.add(url)
        visit(annotation)
      }
    }
    for (const [key, child] of Object.entries(record)) {
      if (key !== 'annotations') visit(child)
    }
  }
  visit(payload)
  return [...found]
}

export function parseJsonText(text: string): unknown {
  const trimmed = text.trim()
  const withoutFence = trimmed.startsWith('```')
    ? trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    : trimmed
  try {
    return JSON.parse(withoutFence)
  } catch {
    throw new DoubaoResponsesError('豆包返回的内容不是有效JSON')
  }
}

export const doubaoResponsesDefaults = {
  get endpoint(): string | undefined {
    return process.env.DOUBAO_API_ENDPOINT
  },
}
