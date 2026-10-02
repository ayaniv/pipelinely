import { describe, it, expect } from 'vitest'
import { checkAnswerDialogRequest } from './answerDialogGuard.js'

type GuardRequest = Parameters<typeof checkAnswerDialogRequest>[0]

const loopbackJson = (overrides: { remoteAddress?: string; headers?: Record<string, string> } = {}): GuardRequest => ({
  method: 'POST',
  socket: { remoteAddress: overrides.remoteAddress ?? '127.0.0.1' },
  headers: { 'content-type': 'application/json', host: 'localhost:3030', ...overrides.headers },
})

describe('checkAnswerDialogRequest', () => {
  describe('accepts', () => {
    it('a JSON POST from loopback with a loopback Host and no Origin', () => {
      expect(checkAnswerDialogRequest(loopbackJson())).toBeNull()
    })

    it('the same request with a same-origin Origin and Sec-Fetch-Site', () => {
      const req = loopbackJson({ headers: { origin: 'http://localhost:3030', 'sec-fetch-site': 'same-origin' } })
      expect(checkAnswerDialogRequest(req)).toBeNull()
    })

    it('a JSON content type that carries a charset', () => {
      expect(checkAnswerDialogRequest(loopbackJson({ headers: { 'content-type': 'application/json; charset=utf-8' } }))).toBeNull()
    })

    it('an IPv4-mapped loopback peer and an IPv6 loopback Host', () => {
      expect(checkAnswerDialogRequest(loopbackJson({ remoteAddress: '::ffff:127.0.0.1', headers: { host: '[::1]:3030' } }))).toBeNull()
    })
  })

  describe('not-json', () => {
    it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp'])('refuses %s', (contentType) => {
      expect(checkAnswerDialogRequest(loopbackJson({ headers: { 'content-type': contentType } }))).toBe('not-json')
    })

    it('refuses a missing content type', () => {
      const req = loopbackJson()
      delete req.headers['content-type']
      expect(checkAnswerDialogRequest(req)).toBe('not-json')
    })
  })

  describe('remote', () => {
    it.each(['100.64.0.7', '::ffff:192.168.1.5', '10.0.0.2', 'fd7a:115c:a1e0::1'])('refuses the peer %s', (remoteAddress) => {
      expect(checkAnswerDialogRequest(loopbackJson({ remoteAddress }))).toBe('remote')
    })

    it('refuses a peer address that cannot be read, rather than guessing it is local', () => {
      expect(checkAnswerDialogRequest({ ...loopbackJson(), socket: {} })).toBe('remote')
    })

    it.each(['x-forwarded-for', 'forwarded', 'x-real-ip', 'tailscale-user-login'])('refuses a loopback request carrying %s, which is a local proxy', (header) => {
      expect(checkAnswerDialogRequest(loopbackJson({ headers: { [header]: '100.64.0.7' } }))).toBe('remote')
    })

    it('reports remote ahead of a bad Host, so a LAN peer learns nothing about the host check', () => {
      expect(checkAnswerDialogRequest(loopbackJson({ remoteAddress: '100.64.0.7', headers: { host: '100.64.0.7:3030' } }))).toBe('remote')
    })
  })

  describe('bad-host', () => {
    it.each(['evil.example:3030', '100.64.0.7:3030', '0.0.0.0:3030', ''])('refuses the Host %j from a loopback peer', (host) => {
      expect(checkAnswerDialogRequest(loopbackJson({ headers: { host } }))).toBe('bad-host')
    })
  })

  describe('cross-site', () => {
    it.each([
      ['another site', { origin: 'http://evil.example' }],
      ['Origin: null', { origin: 'null' }],
      ['a different port', { origin: 'http://localhost:4000' }],
      ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
    ])('refuses %s', (_label, headers) => {
      expect(checkAnswerDialogRequest(loopbackJson({ headers }))).toBe('cross-site')
    })
  })
})
