import { describe, expect, it } from 'vitest'
import {
  isAllowedLocalRuntimeHostHeader,
  isAllowedLocalRuntimeOrigin,
  LOCAL_RUNTIME_API_ORIGIN,
  LOCAL_RUNTIME_API_PORT,
  LOCAL_RUNTIME_FRONTEND_PORT,
  LOCAL_RUNTIME_FRONTEND_ORIGIN,
  LOCAL_RUNTIME_HOST,
} from './local-runtime-config'

describe('local runtime configuration', () => {
  it('keeps the API and frontend on the documented loopback endpoints', () => {
    expect(LOCAL_RUNTIME_HOST).toBe('127.0.0.1')
    expect(LOCAL_RUNTIME_API_PORT).toBe(8787)
    expect(LOCAL_RUNTIME_FRONTEND_PORT).toBe(5173)
    expect(LOCAL_RUNTIME_API_ORIGIN).toBe('http://127.0.0.1:8787')
    expect(LOCAL_RUNTIME_FRONTEND_ORIGIN).toBe('http://127.0.0.1:5173')
  })

  it('allows only local hostnames on the API or frontend ports', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      for (const port of [8787, 5173]) expect(isAllowedLocalRuntimeHostHeader(`${hostname}:${port}`)).toBe(true)
    }
    expect(isAllowedLocalRuntimeHostHeader('example.test:8787')).toBe(false)
    expect(isAllowedLocalRuntimeHostHeader('127.0.0.1:3000')).toBe(false)
    expect(isAllowedLocalRuntimeHostHeader('127.0.0.1')).toBe(false)
  })

  it('rejects remote and arbitrary-port Origins while accepting local Origins', () => {
    expect(isAllowedLocalRuntimeOrigin('http://localhost:8787')).toBe(true)
    expect(isAllowedLocalRuntimeOrigin('http://[::1]:5173')).toBe(true)
    expect(isAllowedLocalRuntimeOrigin('https://127.0.0.1:8787')).toBe(true)
    expect(isAllowedLocalRuntimeOrigin('http://example.test:8787')).toBe(false)
    expect(isAllowedLocalRuntimeOrigin('http://127.0.0.1:3000')).toBe(false)
    expect(isAllowedLocalRuntimeOrigin('http://127.0.0.1')).toBe(false)
    expect(isAllowedLocalRuntimeOrigin('not-an-origin')).toBe(false)
  })
})

