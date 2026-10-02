import { describe, it, expect } from 'vitest'
import { checkFetchSite, checkLoopbackHostAndOrigin } from './localWriteGuard.js'

// The one answer to "did this loopback request come from a page on another
// site?", shared by the remote-auth gate (every loopback request) and the
// answer-dialog route (dashboard-answer-blocked-workers). Pure, so the rules
// are pinned here and the HTTP wiring is proven in remoteAuth.test.ts.

function request(method: string, headers: Record<string, string | undefined>) {
  return { method, headers }
}

describe('checkLoopbackHostAndOrigin — Host (DNS rebinding)', () => {
  it('accepts localhost, the 127.0.0.0/8 block and [::1], with or without a port, in any case', () => {
    for (const host of ['localhost:3030', 'LOCALHOST:3030', '127.0.0.1:3030', '127.0.0.53', '[::1]:3030', 'localhost']) {
      expect(checkLoopbackHostAndOrigin(request('GET', { host })), host).toBeNull()
    }
  })

  // Configured bind hosts are deliberately not accepted: a request to a
  // tailnet or LAN address arrives from that interface and needs a session.
  it('refuses any other name, a wildcard address, a bind address and a missing Host', () => {
    for (const host of ['attacker.example:3030', '0.0.0.0:3030', '100.64.1.2:3030', 'localhost.attacker.example', undefined]) {
      expect(checkLoopbackHostAndOrigin(request('GET', { host })), String(host)).toBe('bad-host')
    }
  })
})

describe('checkLoopbackHostAndOrigin — Origin and Sec-Fetch-Site (CSRF)', () => {
  const host = '127.0.0.1:3030'

  it('accepts a same-origin write, and a write with neither header (curl, scripts)', () => {
    expect(checkLoopbackHostAndOrigin(request('POST', { host, origin: 'http://127.0.0.1:3030', 'sec-fetch-site': 'same-origin' }))).toBeNull()
    expect(checkLoopbackHostAndOrigin(request('POST', { host, 'sec-fetch-site': 'none' }))).toBeNull()
    expect(checkLoopbackHostAndOrigin(request('POST', { host }))).toBeNull()
  })

  it('refuses a write whose Origin is not exactly http://<Host>, null included', () => {
    for (const origin of ['http://attacker.example', 'null', 'http://localhost:3030', 'https://127.0.0.1:3030']) {
      expect(checkLoopbackHostAndOrigin(request('POST', { host, origin })), origin).toBe('cross-site')
    }
  })

  it('refuses a write that Sec-Fetch-Site marks as cross-site or same-site', () => {
    for (const site of ['cross-site', 'same-site']) {
      expect(checkLoopbackHostAndOrigin(request('POST', { host, 'sec-fetch-site': site })), site).toBe('cross-site')
    }
  })

  // Reads change nothing, and the browser withholds a cross-site response
  // without CORS headers, so only the Host rule applies to them.
  it('does not apply the Origin rule to GET and HEAD', () => {
    for (const method of ['GET', 'HEAD']) {
      expect(checkLoopbackHostAndOrigin(request(method, { host, origin: 'http://attacker.example', 'sec-fetch-site': 'cross-site' })), method).toBeNull()
    }
  })

  it('applies it to every other method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(checkLoopbackHostAndOrigin(request(method, { host, origin: 'http://attacker.example' })), method).toBe('cross-site')
    }
  })
})

// The remote half of the gate: Host is rewritten by `tailscale serve`, so only
// Sec-Fetch-Site is checked there.
describe('checkFetchSite — Sec-Fetch-Site alone, whatever the Host', () => {
  it('passes reads, same-origin and none, and a request with no Sec-Fetch-Site', () => {
    expect(checkFetchSite(request('GET', { 'sec-fetch-site': 'cross-site' }))).toBeNull()
    for (const site of ['same-origin', 'none', undefined]) {
      expect(checkFetchSite(request('POST', { host: '100.64.1.2:3030', 'sec-fetch-site': site })), String(site)).toBeNull()
    }
  })

  it('refuses a write marked same-site or cross-site', () => {
    for (const site of ['same-site', 'cross-site']) {
      expect(checkFetchSite(request('POST', { host: '100.64.1.2:3030', 'sec-fetch-site': site })), site).toBe('cross-site')
    }
  })
})
