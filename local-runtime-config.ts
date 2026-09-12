/**
 * Local-only runtime endpoints shared by the Vite dev server and API.
 * Keep this allowlist deliberately small: it is not a general bind or CORS
 * configuration and must not admit remote hosts or arbitrary ports.
 */
export const LOCAL_RUNTIME_HOST = '127.0.0.1' as const
export const LOCAL_RUNTIME_API_PORT = 8787 as const
export const LOCAL_RUNTIME_FRONTEND_PORT = 5173 as const

export const LOCAL_RUNTIME_API_ORIGIN = `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_API_PORT}` as const
export const LOCAL_RUNTIME_FRONTEND_ORIGIN = `http://${LOCAL_RUNTIME_HOST}:${LOCAL_RUNTIME_FRONTEND_PORT}` as const

export const LOCAL_RUNTIME_ALLOWED_HOSTNAMES = ['localhost', '127.0.0.1', '::1'] as const
export const LOCAL_RUNTIME_ALLOWED_PORTS = [LOCAL_RUNTIME_API_PORT, LOCAL_RUNTIME_FRONTEND_PORT] as const

const allowedPorts = new Set<number>(LOCAL_RUNTIME_ALLOWED_PORTS)

/** Normalize URL.hostname and Host-header spellings for IPv6 loopback. */
function normalizedHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '')
}

export function isAllowedLocalRuntimeHostname(value: string): boolean {
  return (LOCAL_RUNTIME_ALLOWED_HOSTNAMES as readonly string[]).includes(normalizedHostname(value))
}

/** Return true only for the local hostnames on the two application ports. */
export function isAllowedLocalRuntimeHostHeader(value: string): boolean {
  const host = value.trim().toLowerCase()
  return (LOCAL_RUNTIME_ALLOWED_HOSTNAMES as readonly string[]).some((hostname) => {
    const hostPart = hostname === '::1' ? `[${hostname}]` : hostname
    for (const port of LOCAL_RUNTIME_ALLOWED_PORTS) {
      if (host === `${hostPart}:${port}`) return true
    }
    return false
  })
}

/** Validate a browser Origin without opening remote hosts or arbitrary ports. */
export function isAllowedLocalRuntimeOrigin(value: string): boolean {
  try {
    const origin = new URL(value)
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false
    if (!isAllowedLocalRuntimeHostname(origin.hostname)) return false
    const port = origin.port ? Number(origin.port) : (origin.protocol === 'https:' ? 443 : 80)
    return Number.isInteger(port) && allowedPorts.has(port)
  } catch {
    return false
  }
}

