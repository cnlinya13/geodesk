import { request as httpRequest, type IncomingHttpHeaders, type RequestOptions } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { createUnzip } from 'node:zlib'
import { Readable } from 'node:stream'

export const TECHNICAL_AUDIT_LIMITS = {
  maxRequests: 40,
  maxConcurrent: 2,
  requestTimeoutMs: 5_000,
  totalTimeoutMs: 45_000,
  maxDecompressedBytes: 2 * 1024 * 1024,
  maxWireBytes: 8 * 1024 * 1024,
  maxRedirects: 5,
} as const

export type PublicAddress = { address: string; family: 4 | 6 }

export type SafeHttpErrorDetails = {
  phase?: 'authorization' | 'dns' | 'tls' | 'transport' | 'redirect' | 'budget'
  dnsResolved?: boolean
  tlsEstablished?: boolean
  responseStatus?: number
  redirectTarget?: string
  redirects?: readonly string[]
}

export class TechnicalAuditHttpError extends Error {
  readonly code: string
  readonly url: string
  readonly phase?: SafeHttpErrorDetails['phase']
  readonly dnsResolved?: boolean
  readonly tlsEstablished?: boolean
  readonly responseStatus?: number
  readonly redirectTarget?: string
  readonly redirects?: readonly string[]

  constructor(code: string, message: string, url: string, details: SafeHttpErrorDetails = {}) {
    super(message)
    this.name = 'TechnicalAuditHttpError'
    this.code = code
    this.url = redactUrl(url)
    this.phase = details.phase
    this.dnsResolved = details.dnsResolved
    this.tlsEstablished = details.tlsEstablished
    this.responseStatus = details.responseStatus
    this.redirectTarget = details.redirectTarget ? redactUrl(details.redirectTarget) : undefined
    this.redirects = details.redirects?.map(redactUrl)
  }
}

export type SafeHttpResponse = {
  status: number
  headers: Record<string, string>
  body: Buffer
  url: string
  redirects: string[]
  elapsedMs: number
  /** Phase facts are internal evidence for the audit rules.  A response over
   * HTTPS necessarily means the TLS handshake and certificate checks passed. */
  dnsResolved?: boolean
  tlsEstablished?: boolean
}

export type SafeRequestTransport = (url: URL, address: PublicAddress, options: {
  timeoutMs: number
  headers: Record<string, string>
  maxWireBytes: number
  deadlineAt?: number
}) => Promise<{ status: number; headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>; body: Buffer }>

export type SafeUrlAuthorizationContext = {
  isRedirect: boolean
  redirects: readonly string[]
}

// The runner owns robots parsing/policy. The HTTP layer only invokes this
// optional gate before DNS and transport for every URL, including redirects.
// `false` blocks the request; `undefined` is treated as allow for convenient
// beforeRequest-style callbacks.
export type SafeUrlAuthorizer = (url: URL, context: SafeUrlAuthorizationContext) => boolean | void | Promise<boolean | void>

export type SafeHttpClientOptions = {
  origin: string
  deadlineAt?: number
  maxRequests?: number
  timeoutMs?: number
  maxDecompressedBytes?: number
  maxWireBytes?: number
  maxRedirects?: number
  resolveHost?: (hostname: string) => Promise<PublicAddress[]>
  transport?: SafeRequestTransport
  authorizeUrl?: SafeUrlAuthorizer
  beforeRequest?: SafeUrlAuthorizer
}

type RequestBudget = {
  used: number
  limit: number
}

function redactUrl(value: string): string {
  const text = String(value)
  try {
    const parsed = new URL(text)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    // Invalid user input can still contain a query or fragment. Do not retain it
    // in an error/evidence value just because URL parsing failed.
    return text.split(/[?#]/, 1)[0] ?? ''
  }
}

function originOf(url: URL): string {
  return url.origin.toLowerCase()
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null
  const values = parts.map(Number)
  return values.every((part) => part >= 0 && part <= 255) ? values : null
}

function ipv4InRange(address: string, base: number[], maskBits: number): boolean {
  const values = parseIpv4(address)
  if (!values) return false
  const value = ((values[0] * 256 + values[1]) * 256 + values[2]) * 256 + values[3]
  const network = ((base[0] * 256 + base[1]) * 256 + base[2]) * 256 + base[3]
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0
  return ((value >>> 0) & mask) === ((network >>> 0) & mask)
}

function ipv6Words(address: string): bigint[] | null {
  const lower = address.toLowerCase().split('%', 1)[0]
  if (!lower.includes(':')) return null
  const halves = lower.split('::')
  if (halves.length > 2) return null

  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const raw = half.split(':')
    const out: number[] = []
    for (const part of raw) {
      if (part.includes('.')) {
        const ipv4 = parseIpv4(part)
        if (!ipv4) return null
        out.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3])
      } else if (/^[0-9a-f]{1,4}$/.test(part)) {
        out.push(Number.parseInt(part, 16))
      } else {
        return null
      }
    }
    return out
  }

  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if (halves.length === 1 && missing !== 0) return null
  if (missing < 0) return null
  return [...left, ...Array.from({ length: missing }, () => 0), ...right].map(BigInt)
}

function ipv6InRange(address: string, base: bigint[], prefix: number): boolean {
  const words = ipv6Words(address)
  if (!words || words.length !== 8) return false
  let remaining = prefix
  for (let index = 0; index < 8 && remaining > 0; index += 1) {
    const bits = Math.min(remaining, 16)
    const mask = ((1n << BigInt(bits)) - 1n) << BigInt(16 - bits)
    if ((words[index] & mask) !== (base[index] & mask)) return false
    remaining -= bits
  }
  return true
}

function isPublicAddress(address: string): boolean {
  if (address.includes('%')) return false
  const family = isIP(address)

  if (family === 4) {
    // Allow only ordinary globally-routable IPv4 space. In particular, do not
    // rely on a short private-range list: documentation, benchmarking,
    // multicast, future-use and special-purpose blocks are not audit targets.
    const blocked: Array<[number[], number]> = [
      [[0, 0, 0, 0], 8], // "this" network / current host
      [[10, 0, 0, 0], 8], // private
      [[100, 64, 0, 0], 10], // shared address space
      [[127, 0, 0, 0], 8], // loopback
      [[169, 254, 0, 0], 16], // link-local / cloud metadata
      [[172, 16, 0, 0], 12], // private
      [[192, 0, 0, 0], 24], // IETF protocol assignments
      [[192, 0, 2, 0], 24], // documentation
      [[192, 31, 196, 0], 24], // AS112
      [[192, 52, 193, 0], 24], // documentation
      [[192, 88, 99, 0], 24], // 6to4 relay anycast
      [[192, 175, 48, 0], 24], // AS112
      [[192, 168, 0, 0], 16], // private
      [[198, 18, 0, 0], 15], // benchmarking
      [[198, 51, 100, 0], 24], // documentation
      [[203, 0, 113, 0], 24], // documentation
      [[224, 0, 0, 0], 4], // multicast
      [[240, 0, 0, 0], 4], // reserved / future use
    ]
    return !blocked.some(([base, prefix]) => ipv4InRange(address, base, prefix))
  }

  if (family === 6) {
    const mappedBase = [0n, 0n, 0n, 0n, 0n, 0xffffn, 0n, 0n]
    // IPv4-mapped addresses are subject to the IPv4 policy, rather than being
    // accepted merely because their outer address is syntactically IPv6.
    if (ipv6InRange(address, mappedBase, 96)) {
      const words = ipv6Words(address)
      if (!words) return false
      const mapped = String(Number(words[6] >> 8n)) + '.' + String(Number(words[6] & 255n)) + '.' + String(Number(words[7] >> 8n)) + '.' + String(Number(words[7] & 255n))
      return isPublicAddress(mapped)
    }

    // Conservative global-unicast allowlist. This excludes loopback, link
    // local, unique/site local, multicast, transition/translation prefixes and
    // other special-use ranges that can hide an embedded private address.
    if (!ipv6InRange(address, [0x2000n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 3)) return false
    const blocked: Array<[bigint[], number]> = [
      [[0x2001n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 32], // Teredo
      [[0x2001n, 0x1n, 0n, 0n, 0n, 0n, 0n, 0n], 32], // IANA special-use
      [[0x2001n, 0xdb8n, 0n, 0n, 0n, 0n, 0n, 0n], 32], // documentation
      [[0x2001n, 0x2n, 0n, 0n, 0n, 0n, 0n, 0n], 48], // benchmarking
      [[0x2001n, 0x10n, 0n, 0n, 0n, 0n, 0n, 0n], 28], // ORCHID
      [[0x2001n, 0x20n, 0n, 0n, 0n, 0n, 0n, 0n], 28], // ORCHIDv2
      [[0x2002n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 16], // 6to4
      [[0x3ffen, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 16], // 6bone
      [[0x5f00n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 16], // SRv6 SID block
      [[0x64n, 0xff9bn, 0n, 0n, 0n, 0n, 0n, 0n], 96], // NAT64
      [[0x64n, 0xff9bn, 0x1n, 0n, 0n, 0n, 0n, 0n], 48], // well-known IPv4-translated
      [[0x100n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 64], // discard-only
      [[0xfec0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], 10], // site-local
    ]
    return !blocked.some(([base, prefix]) => ipv6InRange(address, base, prefix))
  }

  return false
}

export function isPublicIpAddress(address: string): boolean {
  return isPublicAddress(address)
}

async function defaultResolveHost(hostname: string): Promise<PublicAddress[]> {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new TechnicalAuditHttpError('private_address', '目标地址不是公网地址', hostname, { phase: 'dns', dnsResolved: true })
    return [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
  }

  let addresses: Array<{ address: string; family: number }>
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true })
  } catch {
    throw new TechnicalAuditHttpError('dns_failed', 'DNS解析失败', hostname)
  }
  const publicAddresses = addresses
    .filter((value): value is { address: string; family: 4 | 6 } => (value.family === 4 || value.family === 6) && isPublicAddress(value.address))
  if (publicAddresses.length === 0) throw new TechnicalAuditHttpError('private_address', 'DNS解析结果不是公网地址', hostname, { phase: 'dns', dnsResolved: addresses.length > 0 })
  return publicAddresses
}

function flattenHeaders(headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue
    result[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

function isAtOrPast(deadlineAt: number): boolean {
  return Date.now() >= deadlineAt
}

function timeoutError(url: string, deadlineAt: number, globalDeadlineAt?: number, details: SafeHttpErrorDetails = {}): TechnicalAuditHttpError {
  const code = globalDeadlineAt !== undefined && isAtOrPast(globalDeadlineAt) ? 'total_budget_exhausted' : 'timeout'
  return new TechnicalAuditHttpError(code, code === 'timeout' ? '请求超时' : '已达到本轮时间预算', redactUrl(url), { phase: 'transport', ...details })
}

function withDeadline<T>(operation: () => Promise<T>, deadlineAt: number, globalDeadlineAt: number, url: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const remaining = Math.max(1, deadlineAt - Date.now())
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(timeoutError(url, deadlineAt, globalDeadlineAt))
    }, remaining)
    let pending: Promise<T>
    try {
      pending = operation()
    } catch (error) {
      clearTimeout(timer)
      settled = true
      reject(error)
      return
    }
    pending.then((value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }, (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
  })
}

async function readResponseBody(response: import('node:http').IncomingMessage, deadlineAt: number, maxBytes: number, url: string, globalDeadlineAt?: number, details: SafeHttpErrorDetails = {}): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false
    const remaining = Math.max(1, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const ignoreLateResponseError = () => {}

    const destroyResponse = () => {
      // Node may emit ECONNRESET asynchronously after destroy(). Keep a
      // one-shot sink until that late event has been delivered.
      response.once('error', ignoreLateResponseError)
      if (!response.destroyed) response.destroy()
    }

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      response.removeListener('data', onData)
      response.removeListener('end', onEnd)
      response.removeListener('error', onError)
      response.removeListener('aborted', onAborted)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer | string | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > maxBytes) {
        destroyResponse()
        fail(new TechnicalAuditHttpError('response_too_large', '响应内容超过大小限制', redactUrl(url), { phase: 'transport', ...details }))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: Error) => {
      destroyResponse()
      fail(error)
    }
    const onAborted = () => {
      destroyResponse()
      fail(new Error('response_aborted'))
    }

    timer = setTimeout(() => {
      destroyResponse()
      fail(timeoutError(url, deadlineAt, globalDeadlineAt, details))
    }, remaining)

    response.on('data', onData)
    response.once('end', onEnd)
    response.once('error', onError)
    response.once('aborted', onAborted)
  })
}

async function decompressBounded(body: Buffer, encoding: string, maxBytes: number, deadlineAt: number, globalDeadlineAt: number, url: string): Promise<Buffer> {
  const normalizedEncoding = encoding.trim().toLowerCase()
  if (!normalizedEncoding || normalizedEncoding === 'identity') {
    if (body.byteLength > maxBytes) throw new TechnicalAuditHttpError('response_too_large', '响应内容超过大小限制', redactUrl(url))
    if (isAtOrPast(deadlineAt)) throw timeoutError(url, deadlineAt, globalDeadlineAt)
    return body
  }
  if (!/^(gzip|x-gzip|deflate)$/.test(normalizedEncoding)) {
    throw new TechnicalAuditHttpError('unsupported_encoding', '响应压缩格式不受支持', redactUrl(url))
  }

  const unzip = createUnzip()
  const source = Readable.from([body])
  const chunks: Buffer[] = []
  let total = 0

  return await new Promise<Buffer>((resolve, reject) => {
    let settled = false
    const remaining = Math.max(1, deadlineAt - Date.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const ignoreLateStreamError = () => {}

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      source.removeListener('error', onError)
      unzip.removeListener('data', onData)
      unzip.removeListener('end', onEnd)
      unzip.removeListener('error', onError)
    }
    const destroyStreams = () => {
      source.once('error', ignoreLateStreamError)
      unzip.once('error', ignoreLateStreamError)
      if (!source.destroyed) source.destroy()
      if (!unzip.destroyed) unzip.destroy()
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      destroyStreams()
      reject(error)
    }
    const onData = (chunk: Buffer | string | Uint8Array) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.byteLength
      if (total > maxBytes) {
        fail(new TechnicalAuditHttpError('response_too_large', '解压后响应内容超过大小限制', redactUrl(url)))
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks))
    }
    const onError = (error: unknown) => {
      if (error instanceof TechnicalAuditHttpError) {
        fail(error)
      } else {
        fail(new TechnicalAuditHttpError(
          total > maxBytes ? 'response_too_large' : 'invalid_encoding',
          '响应内容无法安全解压',
          redactUrl(url),
        ))
      }
    }

    timer = setTimeout(() => {
      fail(timeoutError(url, deadlineAt, globalDeadlineAt))
    }, remaining)

    source.once('error', onError)
    unzip.on('data', onData)
    unzip.once('end', onEnd)
    unzip.once('error', onError)
    source.pipe(unzip)
  })
}

function isTimeoutError(error: unknown): boolean {
  const value = error as { code?: unknown; message?: unknown } | null
  const text = String(value?.code ?? '') + ' ' + String(value?.message ?? error)
  return /(?:^|[\s_])(?:ETIMEDOUT|ESOCKETTIMEDOUT|TIMEOUT)(?:$|[\s_])|timed?\s*out/i.test(text)
}

function isTlsError(error: unknown): boolean {
  const value = error as { code?: unknown; name?: unknown; message?: unknown } | null
  const text = String(value?.code ?? '') + ' ' + String(value?.name ?? '') + ' ' + String(value?.message ?? value)
  return /TLS|CERT|SSL|EPROTO|SECURE_CONNECT|UNABLE_TO_VERIFY|SELF_SIGNED|ALTNAME|DEPTH_ZERO/i.test(text)
}

function classifyRequestError(error: unknown, url: URL, deadlineAt: number, details: SafeHttpErrorDetails = {}): TechnicalAuditHttpError {
  if (error instanceof TechnicalAuditHttpError) return withHttpDetails(error, url.toString(), details)
  if (isAtOrPast(deadlineAt) || isTimeoutError(error)) {
    return new TechnicalAuditHttpError('timeout', '请求超时', redactUrl(url.toString()), { phase: 'transport', ...details })
  }
  if (url.protocol === 'https:' && isTlsError(error)) {
    return new TechnicalAuditHttpError('tls_failed', 'HTTPS连接失败', redactUrl(url.toString()), { phase: 'tls', tlsEstablished: false, ...details })
  }
  return new TechnicalAuditHttpError('request_failure', '请求失败', redactUrl(url.toString()), { phase: 'transport', ...details })
}

function withHttpDetails(error: unknown, url: string, details: SafeHttpErrorDetails): TechnicalAuditHttpError {
  if (error instanceof TechnicalAuditHttpError) {
    return new TechnicalAuditHttpError(error.code, error.message, url, {
      phase: details.phase ?? error.phase,
      // Facts attached to the error belong to the current hop and must not be
      // overwritten by an aggregate value carried from a previous redirect.
      dnsResolved: error.dnsResolved ?? details.dnsResolved,
      tlsEstablished: error.tlsEstablished ?? details.tlsEstablished,
      responseStatus: error.responseStatus ?? details.responseStatus,
      redirectTarget: error.redirectTarget ?? details.redirectTarget,
      redirects: error.redirects ?? details.redirects,
    })
  }
  return new TechnicalAuditHttpError('request_failure', '请求失败', url, details)
}

async function defaultTransport(url: URL, address: PublicAddress, options: { timeoutMs: number; headers: Record<string, string>; maxWireBytes: number; deadlineAt?: number }): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const requestFunction = url.protocol === 'https:' ? httpsRequest : httpRequest
  const requestDeadlineAt = options.deadlineAt ?? Date.now() + Math.max(1, options.timeoutMs)

  const pinnedLookup = ((hostname: string, lookupOptions: { all?: boolean } | undefined, callback: (...args: unknown[]) => void) => {
    if (hostname.toLowerCase() !== url.hostname.toLowerCase()) {
      callback(new Error('lookup_host_mismatch'))
      return
    }
    if (lookupOptions?.all) {
      callback(null, [{ address: address.address, family: address.family }])
    } else {
      callback(null, address.address, address.family)
    }
  }) as NonNullable<RequestOptions['lookup']>

  const requestOptions: RequestOptions & Record<string, unknown> = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: (url.pathname || '/') + url.search,
    method: 'GET',
    headers: options.headers,
    agent: false,
    family: address.family,
    lookup: pinnedLookup,
    // Do not let Node race addresses or perform a second DNS lookup. The
    // custom lookup is bound to the address selected by the guarded resolver.
    autoSelectFamily: false,
    ...(url.protocol === 'https:' ? {
      servername: url.hostname,
      rejectUnauthorized: true,
    } : {}),
  }

  return await new Promise((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: import('node:http').ClientRequest | undefined
    let responseStatus: number | undefined
    let tlsEstablished = url.protocol !== 'https:'
    const ignoreLateRequestError = () => {}

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      request?.removeListener('error', onRequestError)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      if (request) {
        // destroy() can emit ECONNRESET on a later turn. The normal listener
        // is removed during cleanup, so install a one-shot sink first.
        request.once('error', ignoreLateRequestError)
        if (!request.destroyed) request.destroy()
      }
      const details: SafeHttpErrorDetails = {
        phase: url.protocol === 'https:' && !tlsEstablished ? 'tls' : 'transport',
        dnsResolved: true,
        tlsEstablished,
        responseStatus,
      }
      reject(classifyRequestError(error, url, requestDeadlineAt, details))
    }
    const succeed = (value: { status: number; headers: IncomingHttpHeaders; body: Buffer }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const onRequestError = (error: Error) => {
      fail(error)
    }

    const remaining = requestDeadlineAt - Date.now()
    if (remaining <= 0) {
      fail(timeoutError(url.toString(), requestDeadlineAt))
      return
    }
    timer = setTimeout(() => {
      fail(new TechnicalAuditHttpError('timeout', '请求超时', redactUrl(url.toString())))
    }, remaining)

    try {
      request = requestFunction(requestOptions, (response) => {
        if (settled) {
          response.destroy()
          return
        }
        // An HTTPS response can only arrive after a successful TLS handshake
        // (the secureConnect event is normally observed first).  Retain this
        // fact as a fallback for transports/test doubles that do not expose a
        // socket event; certificate failures never reach this callback.
        if (url.protocol === 'https:') tlsEstablished = true
        responseStatus = response.statusCode
        const responseDetails: SafeHttpErrorDetails = {
          phase: 'transport',
          dnsResolved: true,
          tlsEstablished,
          responseStatus,
        }
        readResponseBody(response, requestDeadlineAt, options.maxWireBytes, url.toString())
          .then((body) => succeed({ status: response.statusCode ?? 0, headers: response.headers, body }))
          .catch((error) => fail(withHttpDetails(error, url.toString(), responseDetails)))
      })
      request.once('error', onRequestError)
      if (url.protocol === 'https:') {
        request.once('socket', (socket) => {
          const secureSocket = socket as import('node:tls').TLSSocket
          secureSocket.once('secureConnect', () => {
            tlsEstablished = true
          })
        })
      }
      request.end()
    } catch (error) {
      fail(error)
    }
  })
}

export class SafeAuditHttpClient {
  private readonly origin: string
  private readonly deadlineAt: number
  private readonly maxRequests: number
  private readonly timeoutMs: number
  private readonly maxDecompressedBytes: number
  private readonly maxWireBytes: number
  private readonly maxRedirects: number
  private readonly resolveHost: (hostname: string) => Promise<PublicAddress[]>
  private readonly transport: SafeRequestTransport
  private readonly authorizeUrl: SafeUrlAuthorizer | undefined
  private readonly budget: RequestBudget

  constructor(options: SafeHttpClientOptions) {
    let parsedOrigin: URL
    try {
      parsedOrigin = new URL(options.origin)
    } catch {
      throw new TechnicalAuditHttpError('invalid_url', '官网origin不是有效URL', redactUrl(options.origin))
    }
    if ((parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') || parsedOrigin.username || parsedOrigin.password || (parsedOrigin.pathname !== '/' && parsedOrigin.pathname !== '')) {
      throw new TechnicalAuditHttpError('invalid_url', '官网origin格式不受支持', redactUrl(options.origin))
    }
    parsedOrigin.pathname = '/'
    parsedOrigin.search = ''
    parsedOrigin.hash = ''
    this.origin = originOf(parsedOrigin)
    this.deadlineAt = options.deadlineAt ?? Date.now() + TECHNICAL_AUDIT_LIMITS.totalTimeoutMs
    this.maxRequests = Math.max(0, Math.floor(options.maxRequests ?? TECHNICAL_AUDIT_LIMITS.maxRequests))
    this.timeoutMs = Math.max(1, Math.floor(options.timeoutMs ?? TECHNICAL_AUDIT_LIMITS.requestTimeoutMs))
    this.maxDecompressedBytes = Math.max(0, Math.floor(options.maxDecompressedBytes ?? TECHNICAL_AUDIT_LIMITS.maxDecompressedBytes))
    this.maxWireBytes = Math.max(0, Math.floor(options.maxWireBytes ?? TECHNICAL_AUDIT_LIMITS.maxWireBytes))
    this.maxRedirects = Math.max(0, Math.floor(options.maxRedirects ?? TECHNICAL_AUDIT_LIMITS.maxRedirects))
    this.resolveHost = options.resolveHost ?? defaultResolveHost
    this.transport = options.transport ?? defaultTransport
    this.authorizeUrl = options.authorizeUrl ?? options.beforeRequest
    this.budget = { used: 0, limit: this.maxRequests }
  }

  get requestsUsed(): number { return this.budget.used }
  get requestLimit(): number { return this.budget.limit }

  async get(input: string | URL, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1'): Promise<SafeHttpResponse> {
    let current: URL
    try {
      current = typeof input === 'string' ? new URL(input) : new URL(input.toString())
    } catch {
      throw new TechnicalAuditHttpError('invalid_url', '目标地址不是有效URL', redactUrl(String(input)))
    }

    if ((current.protocol !== 'http:' && current.protocol !== 'https:') || current.username || current.password) {
      throw new TechnicalAuditHttpError('invalid_url', '目标地址协议或凭据格式不受支持', redactUrl(current.toString()))
    }
    if (originOf(current) !== this.origin) {
      throw new TechnicalAuditHttpError('cross_origin', '目标地址不在官网origin范围内', redactUrl(current.toString()))
    }
    current.hash = ''

    const redirects: string[] = []
    const visited = new Set<string>([current.toString()])
    const started = Date.now()
    let redirectCount = 0
    let dnsResolved = false
    let tlsEstablished: boolean | undefined = current.protocol === 'https:' ? undefined : true

    while (true) {
      if (isAtOrPast(this.deadlineAt)) {
        throw new TechnicalAuditHttpError('total_budget_exhausted', '已达到本轮时间预算', redactUrl(current.toString()), { phase: 'budget', dnsResolved, tlsEstablished, redirects })
      }
      if (this.budget.used >= this.budget.limit) {
        throw new TechnicalAuditHttpError('budget_exhausted', '已达到本轮请求预算', redactUrl(current.toString()), { phase: 'budget', dnsResolved, tlsEstablished, redirects })
      }

      // A hop includes authorization, DNS, connection, body read and
      // decompression. Do not restart the five-second clock for each phase.
      const hopDeadlineAt = Math.min(this.deadlineAt, Date.now() + this.timeoutMs)

      if (this.authorizeUrl) {
        let allowed: boolean | void
        try {
          allowed = await withDeadline(
            () => Promise.resolve(this.authorizeUrl!(new URL(current.toString()), {
              isRedirect: redirectCount > 0,
              redirects: redirects.slice(),
            })),
            hopDeadlineAt,
            this.deadlineAt,
            current.toString(),
          )
        } catch (error) {
          if (error instanceof TechnicalAuditHttpError) {
            throw withHttpDetails(error, current.toString(), { phase: error.phase ?? 'authorization', dnsResolved, tlsEstablished, redirects })
          }
          throw new TechnicalAuditHttpError('authorization_failed', '请求范围校验失败', redactUrl(current.toString()), { phase: 'authorization', dnsResolved, tlsEstablished, redirects })
        }
        if (isAtOrPast(hopDeadlineAt)) {
          throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
        }
        if (allowed === false) {
          throw new TechnicalAuditHttpError('robots_blocked', '请求被robots范围策略阻止', redactUrl(current.toString()), { phase: 'authorization', dnsResolved, tlsEstablished, redirects })
        }
      }

      const resolveDeadlineAt = hopDeadlineAt
      let addresses: PublicAddress[]
      try {
        addresses = await new Promise<PublicAddress[]>((resolve, reject) => {
          const remaining = Math.max(1, resolveDeadlineAt - Date.now())
          const timer = setTimeout(() => {
            reject(timeoutError(current.toString(), resolveDeadlineAt, this.deadlineAt, { phase: 'dns', dnsResolved: false, redirects }))
          }, remaining)
          this.resolveHost(current.hostname).then((value) => {
            clearTimeout(timer)
            resolve(value)
          }, (error) => {
            clearTimeout(timer)
            reject(error)
          })
        })
      } catch (error) {
        if (error instanceof TechnicalAuditHttpError) {
          throw withHttpDetails(error, current.toString(), { phase: error.phase ?? 'dns', dnsResolved: error.dnsResolved ?? false, redirects })
        }
        if (isAtOrPast(this.deadlineAt)) {
          throw new TechnicalAuditHttpError('total_budget_exhausted', '已达到本轮时间预算', redactUrl(current.toString()), { phase: 'dns', dnsResolved: false, redirects })
        }
        if (isAtOrPast(hopDeadlineAt)) {
          throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { phase: 'dns', dnsResolved: false, redirects })
        }
        throw new TechnicalAuditHttpError('dns_failed', 'DNS解析失败', redactUrl(current.toString()), { phase: 'dns', dnsResolved: false, redirects })
      }

      const address = addresses.find((value) => value && (value.family === 4 || value.family === 6) && isPublicAddress(value.address))
      if (!address) {
        throw new TechnicalAuditHttpError('private_address', '目标地址不是公网地址', redactUrl(current.toString()), { phase: 'dns', dnsResolved: addresses.length > 0, redirects })
      }
      dnsResolved = true

      if (isAtOrPast(hopDeadlineAt)) {
        throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
      }
      if (this.budget.used >= this.budget.limit) {
        throw new TechnicalAuditHttpError('budget_exhausted', '已达到本轮请求预算', redactUrl(current.toString()), { phase: 'budget', dnsResolved, tlsEstablished, redirects })
      }

      this.budget.used += 1
      const requestDeadlineAt = hopDeadlineAt
      const remaining = Math.max(1, requestDeadlineAt - Date.now())
      let result: { status: number; headers: IncomingHttpHeaders | Record<string, string | string[] | undefined>; body: Buffer }
      try {
        const executeTransport = () => this.transport(current, address, {
          timeoutMs: remaining,
          headers: {
            accept,
            'accept-encoding': 'identity',
            'user-agent': 'GEODesk Technical Audit/1.0',
          },
          maxWireBytes: this.maxWireBytes,
          deadlineAt: requestDeadlineAt,
        })
        // defaultTransport owns the request/socket timer and can destroy the
        // actual ClientRequest. A caller-supplied transport has no such
        // cancellation contract, so guard it with the same deadline here.
        result = this.transport === defaultTransport
          ? await executeTransport()
          : await withDeadline(executeTransport, requestDeadlineAt, this.deadlineAt, current.toString())
      } catch (error) {
        if (error instanceof TechnicalAuditHttpError) {
          if (error.code === 'timeout' && isAtOrPast(this.deadlineAt)) {
            throw new TechnicalAuditHttpError('total_budget_exhausted', '已达到本轮时间预算', redactUrl(current.toString()), { phase: error.phase ?? 'transport', dnsResolved, tlsEstablished, redirects })
          }
          throw withHttpDetails(error, current.toString(), { phase: error.phase ?? 'transport', dnsResolved, tlsEstablished, redirects })
        }
        if (isAtOrPast(this.deadlineAt)) {
          throw new TechnicalAuditHttpError('total_budget_exhausted', '已达到本轮时间预算', redactUrl(current.toString()), { phase: 'transport', dnsResolved, tlsEstablished, redirects })
        }
        if (isAtOrPast(hopDeadlineAt)) {
          throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
        }
        throw new TechnicalAuditHttpError('request_failure', '请求失败', redactUrl(current.toString()), { phase: 'transport', dnsResolved, tlsEstablished, redirects })
      }

      if (current.protocol === 'https:') tlsEstablished = true

      if (isAtOrPast(hopDeadlineAt)) {
        throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
      }
      // The default transport enforces this while reading the wire stream.
      // Keep the invariant at the client boundary as well so a test or future
      // transport implementation cannot bypass the wire-size limit.
      if (result.body.byteLength > this.maxWireBytes) {
        throw new TechnicalAuditHttpError('response_too_large', '响应内容超过大小限制', redactUrl(current.toString()), { phase: 'transport', dnsResolved, tlsEstablished, redirects })
      }

      const headers = flattenHeaders(result.headers)
      let body: Buffer
      try {
        body = await decompressBounded(
          result.body,
          headers['content-encoding'] ?? '',
          this.maxDecompressedBytes,
          hopDeadlineAt,
          this.deadlineAt,
          current.toString(),
        )
      } catch (error) {
        if (error instanceof TechnicalAuditHttpError) {
          throw withHttpDetails(error, current.toString(), { phase: error.phase ?? 'transport', dnsResolved, tlsEstablished, redirects })
        }
        if (isAtOrPast(this.deadlineAt)) {
          throw new TechnicalAuditHttpError('total_budget_exhausted', '已达到本轮时间预算', redactUrl(current.toString()), { phase: 'transport', dnsResolved, tlsEstablished, redirects })
        }
        if (isAtOrPast(hopDeadlineAt)) {
          throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
        }
        throw new TechnicalAuditHttpError('invalid_encoding', '响应内容无法安全解压', redactUrl(current.toString()), { phase: 'transport', dnsResolved, tlsEstablished, redirects })
      }

      if (isAtOrPast(hopDeadlineAt)) {
        throw timeoutError(current.toString(), hopDeadlineAt, this.deadlineAt, { dnsResolved, tlsEstablished, redirects })
      }

      if ([301, 302, 303, 307, 308].includes(result.status)) {
        const location = headers.location
        if (!location) throw new TechnicalAuditHttpError('redirect_invalid', '重定向缺少目标地址', redactUrl(current.toString()), { phase: 'redirect', dnsResolved, tlsEstablished, responseStatus: result.status, redirects })

        let next: URL
        try {
          next = new URL(location, current)
        } catch {
          throw new TechnicalAuditHttpError('redirect_invalid', '重定向目标不是有效URL', redactUrl(current.toString()), { phase: 'redirect', dnsResolved, tlsEstablished, responseStatus: result.status, redirects, redirectTarget: location })
        }
        next.hash = ''
        if ((next.protocol !== 'http:' && next.protocol !== 'https:') || next.username || next.password || originOf(next) !== this.origin) {
          throw new TechnicalAuditHttpError('redirect_blocked', '重定向目标超出官网origin范围或包含凭据', redactUrl(next.toString()), { phase: 'redirect', dnsResolved, tlsEstablished, responseStatus: result.status, redirects, redirectTarget: next.toString() })
        }
        if (visited.has(next.toString())) {
          throw new TechnicalAuditHttpError('redirect_loop', '重定向出现循环', redactUrl(next.toString()), { phase: 'redirect', dnsResolved, tlsEstablished, responseStatus: result.status, redirects, redirectTarget: next.toString() })
        }
        if (redirectCount >= this.maxRedirects) {
          throw new TechnicalAuditHttpError('redirect_limit', '重定向次数超过限制', redactUrl(next.toString()), { phase: 'redirect', dnsResolved, tlsEstablished, responseStatus: result.status, redirects, redirectTarget: next.toString() })
        }

        redirects.push(redactUrl(current.toString()))
        visited.add(next.toString())
        redirectCount += 1
        current = next
        continue
      }

      return {
        status: result.status,
        headers,
        body,
        url: redactUrl(current.toString()),
        redirects,
        elapsedMs: Date.now() - started,
        dnsResolved,
        tlsEstablished,
      }
    }
  }
}
