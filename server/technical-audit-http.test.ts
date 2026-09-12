import { EventEmitter } from 'node:events'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'

type FakeRequestHandler = (options: Record<string, unknown>, callback: (response: FakeResponse) => void) => FakeRequest

const mocked = vi.hoisted(() => ({
  http: null as FakeRequestHandler | null,
  https: null as FakeRequestHandler | null,
}))

vi.mock('node:http', async () => {
  const actual = await vi.importActual<typeof import('node:http')>('node:http')
  return {
    ...actual,
    request: (options: Record<string, unknown>, callback: (response: FakeResponse) => void) => {
      if (!mocked.http) throw new Error('http fixture is not configured')
      return mocked.http(options, callback)
    },
  }
})

vi.mock('node:https', async () => {
  const actual = await vi.importActual<typeof import('node:https')>('node:https')
  return {
    ...actual,
    request: (options: Record<string, unknown>, callback: (response: FakeResponse) => void) => {
      if (!mocked.https) throw new Error('https fixture is not configured')
      return mocked.https(options, callback)
    },
  }
})

import {
  isPublicIpAddress,
  SafeAuditHttpClient,
  TechnicalAuditHttpError,
  type PublicAddress,
  type SafeRequestTransport,
} from './technical-audit-http.ts'

class FakeRequest extends EventEmitter {
  destroyed = false
  emitErrorOnDestroy = false

  end(): void {}

  destroy(): this {
    this.destroyed = true
    if (this.emitErrorOnDestroy) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })))
    }
    return this
  }
}

class FakeResponse extends EventEmitter {
  readonly statusCode: number
  readonly headers: Record<string, string>
  destroyed = false
  emitErrorOnDestroy = false

  constructor(statusCode: number, headers: Record<string, string> = {}) {
    super()
    this.statusCode = statusCode
    this.headers = headers
  }

  destroy(): this {
    this.destroyed = true
    if (this.emitErrorOnDestroy) {
      queueMicrotask(() => this.emit('error', Object.assign(new Error('response closed'), { code: 'ECONNRESET' })))
    }
    return this
  }
}

const publicAddress: PublicAddress = { address: '93.184.216.34', family: 4 }

function resolved(address: PublicAddress = publicAddress): Promise<PublicAddress[]> {
  return Promise.resolve([address])
}

function injectedResponse(status = 200, body: Buffer | string = 'ok', headers: Record<string, string> = {}) {
  return { status, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(body) }
}

function makeInjectedClient(
  transport: SafeRequestTransport,
  options: Partial<ConstructorParameters<typeof SafeAuditHttpClient>[0]> = {},
): SafeAuditHttpClient {
  return new SafeAuditHttpClient({
    origin: 'https://example.test',
    resolveHost: async () => resolved(),
    transport,
    ...options,
  })
}

async function expectHttpCode(operation: Promise<unknown>, code: string): Promise<TechnicalAuditHttpError> {
  try {
    await operation
    throw new Error('expected TechnicalAuditHttpError(' + code + ')')
  } catch (error) {
    expect(error).toBeInstanceOf(TechnicalAuditHttpError)
    expect((error as TechnicalAuditHttpError).code).toBe(code)
    return error as TechnicalAuditHttpError
  }
}

afterEach(() => {
  mocked.http = null
  mocked.https = null
})

describe('safe public address policy', () => {
  it('allows ordinary global IPv4 and IPv6 while rejecting private, reserved, mapped and special ranges', () => {
    expect(isPublicIpAddress('93.184.216.34')).toBe(true)
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true)

    for (const address of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '203.0.113.1',
      '224.0.0.1',
      '240.0.0.1',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:192.0.2.1',
      'fc00::1',
      'fe80::1',
      'fec0::1',
      '2001:db8::1',
      '2001:0::1',
      '2002:c000:0201::1',
      'ff02::1',
      '64:ff9b::c000:201',
    ]) {
      expect(isPublicIpAddress(address), address).toBe(false)
    }
  })

  it('rejects a DNS answer containing no usable public address', async () => {
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      resolveHost: async () => [{ address: '127.0.0.1', family: 4 }],
      transport: async () => injectedResponse(),
    })
    const error = await expectHttpCode(client.get('https://example.test/health?token=secret'), 'private_address')
    expect(error.dnsResolved).toBe(true)
    expect(error.phase).toBe('dns')
  })
})

describe('safe audit URL and request budget rules', () => {
  it('rejects credentials and cross-origin targets without retaining query data in errors', async () => {
    const client = makeInjectedClient(async () => injectedResponse())
    const credentials = await expectHttpCode(
      client.get('https://user:password@example.test/private?token=secret'),
      'invalid_url',
    )
    expect(credentials.url).toBe('https://example.test/private')

    await expectHttpCode(client.get('https://other.example.test/path?token=secret'), 'cross_origin')
  })

  it('resolves and pins every redirect, rejects DNS rebinding and counts redirects against the request budget', async () => {
    const resolvedHosts: string[] = []
    let calls = 0
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      resolveHost: async (hostname) => {
        resolvedHosts.push(hostname)
        if (resolvedHosts.length === 1) return [publicAddress]
        return [{ address: '192.168.1.1', family: 4 }]
      },
      transport: async () => {
        calls += 1
        return injectedResponse(302, '', { location: '/next' })
      },
    })

    await expectHttpCode(client.get('https://example.test/start?secret=1'), 'private_address')
    expect(calls).toBe(1)
    expect(resolvedHosts).toEqual(['example.test', 'example.test'])
  })

  it('blocks a cross-origin or credential-bearing redirect before following it', async () => {
    const redirects: string[] = [
      'https://other.example.test/out',
      'https://user:pass@example.test/private?token=secret',
    ]
    for (const location of redirects) {
      const client = makeInjectedClient(async () => injectedResponse(302, '', { location }))
      const error = await expectHttpCode(client.get('https://example.test/start'), 'redirect_blocked')
      expect(error.url).not.toContain('token=')
      expect(error.url).not.toContain('pass')
    }
  })

  it('allows exactly the configured redirect count and rejects a further hop', async () => {
    let calls = 0
    const client = makeInjectedClient(
      async (url) => {
        calls += 1
        return injectedResponse(302, '', { location: '/hop-' + calls })
      },
      { maxRedirects: 1 },
    )
    const error = await expectHttpCode(client.get('https://example.test/start'), 'redirect_limit')
    expect(calls).toBe(2)
    expect(error.url).toBe('https://example.test/hop-2')
  })

  it('returns an explicit request-budget error before doing another DNS lookup', async () => {
    let resolutions = 0
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      maxRequests: 1,
      resolveHost: async () => {
        resolutions += 1
        return [publicAddress]
      },
      transport: async () => injectedResponse(302, '', { location: '/next' }),
    })
    await expectHttpCode(client.get('https://example.test/start'), 'budget_exhausted')
    expect(client.requestsUsed).toBe(1)
    expect(resolutions).toBe(1)
  })

  it('runs the optional URL authorizer before the initial request without touching DNS or transport', async () => {
    let authorizerCalls = 0
    let transportCalls = 0
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      authorizeUrl: async (url, context) => {
        authorizerCalls += 1
        expect(url.pathname).toBe('/blocked')
        expect(context.isRedirect).toBe(false)
        return false
      },
      resolveHost: async () => {
        throw new Error('DNS must not run')
      },
      transport: async () => {
        transportCalls += 1
        return injectedResponse()
      },
    })
    await expectHttpCode(client.get('https://example.test/blocked?token=secret'), 'robots_blocked')
    expect(authorizerCalls).toBe(1)
    expect(transportCalls).toBe(0)
    expect(client.requestsUsed).toBe(0)
  })

  it('rechecks redirects with the URL authorizer and never transports a blocked path', async () => {
    const checked: Array<{ path: string; redirect: boolean }> = []
    let transportCalls = 0
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      authorizeUrl: (url, context) => {
        checked.push({ path: url.pathname, redirect: context.isRedirect })
        return url.pathname !== '/blocked'
      },
      resolveHost: async () => [publicAddress],
      transport: async () => {
        transportCalls += 1
        return injectedResponse(302, '', { location: '/blocked' })
      },
    })
    await expectHttpCode(client.get('https://example.test/start'), 'robots_blocked')
    expect(checked).toEqual([
      { path: '/start', redirect: false },
      { path: '/blocked', redirect: true },
    ])
    expect(transportCalls).toBe(1)
    expect(client.requestsUsed).toBe(1)
  })
})

describe('bounded DNS, transport and response handling', () => {
  it('classifies DNS failure, per-request timeout and total budget exhaustion separately', async () => {
    const dnsFailure = new SafeAuditHttpClient({
      origin: 'https://example.test',
      resolveHost: async () => { throw new Error('resolver unavailable') },
      transport: async () => injectedResponse(),
    })
    await expectHttpCode(dnsFailure.get('https://example.test/'), 'dns_failed')

    const slowDns = new SafeAuditHttpClient({
      origin: 'https://example.test',
      timeoutMs: 15,
      deadlineAt: Date.now() + 1_000,
      resolveHost: async () => new Promise<PublicAddress[]>(() => {}),
      transport: async () => injectedResponse(),
    })
    await expectHttpCode(slowDns.get('https://example.test/'), 'timeout')

    const totalBudget = new SafeAuditHttpClient({
      origin: 'https://example.test',
      timeoutMs: 100,
      deadlineAt: Date.now() + 15,
      resolveHost: async () => new Promise<PublicAddress[]>((resolve) => setTimeout(() => resolve([publicAddress]), 50)),
      transport: async () => injectedResponse(),
    })
    await expectHttpCode(totalBudget.get('https://example.test/'), 'total_budget_exhausted')
  })

  it('does not let a custom transport bypass the connection deadline', async () => {
    const client = makeInjectedClient(
      async () => new Promise(() => {}),
      { timeoutMs: 15 },
    )
    await expectHttpCode(client.get('https://example.test/hang'), 'timeout')
  })

  it('shares one hop deadline across slow DNS and slow transport', async () => {
    const started = Date.now()
    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      timeoutMs: 60,
      deadlineAt: started + 1_000,
      resolveHost: async () => new Promise<PublicAddress[]>((resolve) => setTimeout(() => resolve([publicAddress]), 45)),
      transport: async () => new Promise((resolve) => setTimeout(() => resolve(injectedResponse()), 45)),
    })
    await expectHttpCode(client.get('https://example.test/slow-hop'), 'timeout')
    expect(Date.now() - started).toBeLessThan(90)
  })

  it('enforces the wire limit even when a custom transport returns an oversized body', async () => {
    const client = makeInjectedClient(
      async () => injectedResponse(200, Buffer.alloc(9, 65)),
      { maxWireBytes: 8 },
    )
    await expectHttpCode(client.get('https://example.test/large'), 'response_too_large')
  })

  it('bounds decompressed output and rejects truncated or invalid compressed streams', async () => {
    const bomb = gzipSync(Buffer.alloc(128 * 1024, 65))
    const client = makeInjectedClient(
      async () => injectedResponse(200, bomb, { 'content-encoding': 'gzip' }),
      { maxDecompressedBytes: 1_024 },
    )
    await expectHttpCode(client.get('https://example.test/bomb'), 'response_too_large')

    const invalid = makeInjectedClient(
      async () => injectedResponse(200, Buffer.from('not-gzip'), { 'content-encoding': 'gzip' }),
    )
    await expectHttpCode(invalid.get('https://example.test/invalid'), 'invalid_encoding')
  })
})

describe('default production HTTP transport', () => {
  it('uses a fixed address lookup, handles all=true, reads the stream and redacts evidence URL', async () => {
    let requestOptions: Record<string, unknown> | undefined
    mocked.http = (options, callback) => {
      requestOptions = options
      const request = new FakeRequest()
      request.end = () => {
        queueMicrotask(() => {
          const response = new FakeResponse(200, { 'content-type': 'text/plain' })
          callback(response)
          queueMicrotask(() => {
            response.emit('data', Buffer.from('fixture'))
            response.emit('end')
          })
        })
      }
      return request
    }

    const client = new SafeAuditHttpClient({
      origin: 'http://example.test',
      resolveHost: async () => [publicAddress],
      timeoutMs: 500,
    })
    const result = await client.get('http://example.test/health?token=secret')
    expect(result.body.toString()).toBe('fixture')
    expect(result.url).toBe('http://example.test/health')
    expect(result.headers['content-type']).toBe('text/plain')
    expect(requestOptions?.hostname).toBe('example.test')
    expect(requestOptions?.path).toBe('/health?token=secret')
    expect(requestOptions?.family).toBe(4)
    expect(requestOptions?.autoSelectFamily).toBe(false)
    expect(String((requestOptions?.headers as Record<string, string>)['user-agent'])).not.toContain('GPTBot')

    const lookupFunction = requestOptions?.lookup as ((hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void)
    const allAnswer = await new Promise<unknown[]>((resolve) => lookupFunction('example.test', { all: true }, (...args) => resolve(args)))
    expect(allAnswer[1]).toEqual([{ address: publicAddress.address, family: publicAddress.family }])
    const oneAnswer = await new Promise<unknown[]>((resolve) => lookupFunction('example.test', { all: false }, (...args) => resolve(args)))
    expect(oneAnswer[1]).toBe(publicAddress.address)
    expect(oneAnswer[2]).toBe(4)
  })

  it('classifies TLS certificate errors without weakening hostname or certificate verification', async () => {
    let requestOptions: Record<string, unknown> | undefined
    mocked.https = (options) => {
      requestOptions = options
      const request = new FakeRequest()
      request.end = () => {
        queueMicrotask(() => {
          const error = Object.assign(new Error('certificate name mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
          request.emit('error', error)
        })
      }
      return request
    }

    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      resolveHost: async () => [publicAddress],
      timeoutMs: 500,
    })
    await expectHttpCode(client.get('https://example.test/path?token=secret'), 'tls_failed')
    expect(requestOptions?.servername).toBe('example.test')
    expect(requestOptions?.rejectUnauthorized).toBe(true)
    expect(String((requestOptions?.headers as Record<string, string>)['user-agent'])).not.toContain('GPTBot')
  })

  it('does not turn a pre-handshake TCP reset into an explicit TLS failure', async () => {
    mocked.https = () => {
      const request = new FakeRequest()
      request.end = () => {
        queueMicrotask(() => request.emit('error', Object.assign(new Error('socket reset'), { code: 'ECONNRESET' })))
      }
      return request
    }

    const client = new SafeAuditHttpClient({
      origin: 'https://example.test',
      resolveHost: async () => [publicAddress],
      timeoutMs: 500,
    })
    const error = await expectHttpCode(client.get('https://example.test/reset'), 'request_failure')
    expect(error.tlsEstablished).toBe(false)
    expect(error.phase).toBe('tls')
  })

  it('preserves an explicit TLS failure on a later redirect hop', async () => {
    let calls = 0
    const client = makeInjectedClient(async (url) => {
      calls += 1
      if (calls === 1) return injectedResponse(302, '', { location: '/second' })
      throw new TechnicalAuditHttpError('tls_failed', '证书校验失败', url.toString(), { phase: 'tls', tlsEstablished: false })
    })
    const error = await expectHttpCode(client.get('https://example.test/first'), 'tls_failed')
    expect(calls).toBe(2)
    expect(error.tlsEstablished).toBe(false)
    expect(error.phase).toBe('tls')
  })

  it('classifies an interrupted response and a read timeout and releases request state', async () => {
    let request: FakeRequest | undefined
    let mode: 'error' | 'timeout' = 'error'
    mocked.http = (_options, callback) => {
      request = new FakeRequest()
      request.emitErrorOnDestroy = mode === 'timeout'
      request.end = () => {
        queueMicrotask(() => {
          const response = new FakeResponse(200)
          response.emitErrorOnDestroy = true
          callback(response)
          if (mode === 'error') {
            queueMicrotask(() => {
              response.emit('data', Buffer.from('partial'))
              response.emit('error', new Error('socket reset'))
            })
          }
        })
      }
      return request
    }

    const interrupted = new SafeAuditHttpClient({
      origin: 'http://example.test',
      resolveHost: async () => [publicAddress],
      timeoutMs: 100,
    })
    const interruptedError = await expectHttpCode(interrupted.get('http://example.test/partial'), 'request_failure')
    expect(interruptedError.responseStatus).toBe(200)
    expect(interruptedError.dnsResolved).toBe(true)
    expect(interruptedError.tlsEstablished).toBe(true)
    expect(request?.destroyed).toBe(true)

    mode = 'timeout'
    const timedOut = new SafeAuditHttpClient({
      origin: 'http://example.test',
      resolveHost: async () => [publicAddress],
      timeoutMs: 15,
    })
    await expectHttpCode(timedOut.get('http://example.test/slow'), 'timeout')
    expect(request?.destroyed).toBe(true)
  })

  it('enforces the wire cap while consuming the actual response stream', async () => {
    let request: FakeRequest | undefined
    mocked.http = (_options, callback) => {
      request = new FakeRequest()
      request.end = () => {
        queueMicrotask(() => {
          const response = new FakeResponse(200)
          response.emitErrorOnDestroy = true
          callback(response)
          queueMicrotask(() => {
            response.emit('data', Buffer.from('1234'))
            response.emit('data', Buffer.from('5678'))
          })
        })
      }
      return request
    }

    const client = new SafeAuditHttpClient({
      origin: 'http://example.test',
      resolveHost: async () => [publicAddress],
      maxWireBytes: 5,
      timeoutMs: 200,
    })
    await expectHttpCode(client.get('http://example.test/large'), 'response_too_large')
    expect(request?.destroyed).toBe(true)
  })
})
