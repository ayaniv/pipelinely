import { isKnownLoopbackAddress } from './remoteAccess.js'

// The one answer to "did this loopback request come from a page on another
// site?". A rebound DNS name or a cross-site form POST in the desktop browser
// reaches loopback routes that trust the peer address alone; the Host and
// Origin headers are the only evidence of where the page really came from.

export type LocalWriteRefusal = 'bad-host' | 'cross-site'

interface GuardableRequest {
  method?: string
  headers: Record<string, string | string[] | undefined>
}

const READ_METHODS = new Set(['GET', 'HEAD'])
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function hostName(host: string): string {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'))
  return host.split(':')[0]
}

function isLoopbackHostName(host: string): boolean {
  const name = hostName(host).toLowerCase()
  return name === 'localhost' || isKnownLoopbackAddress(name)
}

function isReadMethod(req: GuardableRequest): boolean {
  return READ_METHODS.has((req.method ?? 'GET').toUpperCase())
}

// Sec-Fetch-Site is set by the browser and cannot be forged by a page, so it
// is the one cross-site signal that survives a proxy rewriting Host.
export function checkFetchSite(req: GuardableRequest): LocalWriteRefusal | null {
  if (isReadMethod(req)) return null
  const fetchSite = singleHeader(req.headers['sec-fetch-site'])
  if (fetchSite !== undefined && !ALLOWED_FETCH_SITES.has(fetchSite)) return 'cross-site'
  return null
}

export function checkLoopbackHostAndOrigin(req: GuardableRequest): LocalWriteRefusal | null {
  const host = singleHeader(req.headers.host)
  if (!host || !isLoopbackHostName(host)) return 'bad-host'

  if (isReadMethod(req)) return null

  const origin = singleHeader(req.headers.origin)
  if (origin !== undefined && origin !== `http://${host}`) return 'cross-site'

  return checkFetchSite(req)
}
