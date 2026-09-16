import { describe, it, expect } from 'vitest'
import { isLoopbackAddress, requestIsRemote } from './remoteAccess.js'

// The whole safety design of the auto-submit feature rests on this one
// predicate, so it is covered exhaustively in both directions — and, most
// importantly, in the fail-closed direction: anything this module cannot
// positively identify as a real, non-loopback peer must come back "local",
// because "local" is the answer that stages a command instead of running it.
// See tech-design.md's "Why this shape, given what happened on 2026-09-06".

describe('isLoopbackAddress — the local (safe) direction', () => {
  it('treats every form of 127.0.0.0/8 as local', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('127.0.0.53')).toBe(true)
    expect(isLoopbackAddress('127.1.2.3')).toBe(true)
    expect(isLoopbackAddress('127.255.255.254')).toBe(true)
  })

  it('treats IPv6 loopback as local, in both its compressed and expanded forms', () => {
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('0:0:0:0:0:0:0:1')).toBe(true)
  })

  // What a 0.0.0.0-bound Node server actually sees for a localhost request on
  // macOS — the single most important case in this file, since it is the real
  // desktop developer's real peer address.
  it('treats the IPv4-mapped IPv6 form of loopback as local', () => {
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.53')).toBe(true)
  })

  it('treats the literal string "localhost" as local', () => {
    expect(isLoopbackAddress('localhost')).toBe(true)
  })

  it('fails closed to local for a missing, empty, or unparseable peer address', () => {
    expect(isLoopbackAddress(undefined)).toBe(true)
    expect(isLoopbackAddress(null)).toBe(true)
    expect(isLoopbackAddress('')).toBe(true)
    expect(isLoopbackAddress('   ')).toBe(true)
    expect(isLoopbackAddress('not-an-address')).toBe(true)
    expect(isLoopbackAddress('127.1')).toBe(true)
    expect(isLoopbackAddress('999.999.999.999')).toBe(true)
  })
})

describe('isLoopbackAddress — the remote direction', () => {
  it('treats a tailnet address as remote', () => {
    expect(isLoopbackAddress('100.64.1.2')).toBe(false)
    expect(isLoopbackAddress('100.101.102.103')).toBe(false)
  })

  it('treats a LAN address as remote', () => {
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('10.0.0.3')).toBe(false)
    expect(isLoopbackAddress('172.16.0.9')).toBe(false)
  })

  it('treats the IPv4-mapped form of a non-loopback address as remote', () => {
    expect(isLoopbackAddress('::ffff:192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('::ffff:100.64.1.2')).toBe(false)
  })

  it('treats a routable IPv6 address as remote', () => {
    expect(isLoopbackAddress('2001:db8::1')).toBe(false)
    expect(isLoopbackAddress('fd00::1')).toBe(false)
  })
})

describe('requestIsRemote', () => {
  it('is the inverse of isLoopbackAddress for the request socket peer', () => {
    expect(requestIsRemote({ socket: { remoteAddress: '192.168.1.5' } })).toBe(true)
    expect(requestIsRemote({ socket: { remoteAddress: '::ffff:127.0.0.1' } })).toBe(false)
  })

  it('fails closed to "not remote" when the socket has no peer address at all', () => {
    expect(requestIsRemote({ socket: {} })).toBe(false)
    expect(requestIsRemote({ socket: { remoteAddress: undefined } })).toBe(false)
  })
})
