import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import {
  DEFAULT_BIND_HOST,
  resolveBindHosts,
  isWideBind,
  wideBindWarnings,
  dashboardUrl,
  listenOnHosts,
  describeListenFailure,
} from './bindHosts.js'
import { canConnect, firstNonLoopbackIPv4 } from './testNetwork.js'

const TAILSCALE_STYLE_ADDRESS = '100.64.0.7'
const UNASSIGNED_TEST_NET_ADDRESS = '192.0.2.1'

describe('resolveBindHosts', () => {
  it('defaults to loopback-only when PIPELINELY_HOST is unset', () => {
    expect(resolveBindHosts({})).toEqual([DEFAULT_BIND_HOST])
    expect(DEFAULT_BIND_HOST).toBe('127.0.0.1')
  })

  it.each(['', '   ', ',', ' , , '])('treats %j as unset', (value) => {
    expect(resolveBindHosts({ PIPELINELY_HOST: value })).toEqual([DEFAULT_BIND_HOST])
  })

  it('accepts a single host', () => {
    expect(resolveBindHosts({ PIPELINELY_HOST: TAILSCALE_STYLE_ADDRESS })).toEqual([TAILSCALE_STYLE_ADDRESS])
  })

  it('accepts a comma-separated list and tolerates whitespace and a trailing comma', () => {
    expect(resolveBindHosts({ PIPELINELY_HOST: ` 127.0.0.1 ,${TAILSCALE_STYLE_ADDRESS} ,` })).toEqual([
      '127.0.0.1',
      TAILSCALE_STYLE_ADDRESS,
    ])
  })

  it('drops duplicate entries so the same address is never listened on twice', () => {
    expect(resolveBindHosts({ PIPELINELY_HOST: '127.0.0.1,127.0.0.1' })).toEqual(['127.0.0.1'])
  })

  it.each(['0.0.0.0', '::', '::1', 'localhost'])('accepts %s', (host) => {
    expect(resolveBindHosts({ PIPELINELY_HOST: host })).toEqual([host])
  })

  it.each(['not a host!', 'http://127.0.0.1', '127.0.0.1:3030', '999.1.1.1.1.1', '-bad.example'])(
    'fails loudly on the invalid entry %j, naming the variable and the entry',
    (entry) => {
      expect(() => resolveBindHosts({ PIPELINELY_HOST: entry })).toThrow(/PIPELINELY_HOST/)
      expect(() => resolveBindHosts({ PIPELINELY_HOST: entry })).toThrow(entry)
    },
  )

  it.each([
    ['0.0.0.0,127.0.0.1', ['0.0.0.0']],
    ['127.0.0.1,0.0.0.0', ['0.0.0.0']],
    ['0.0.0.0,192.168.1.20', ['0.0.0.0']],
    ['::,0.0.0.0', ['::']],
    ['0.0.0.0,::', ['::']],
    ['::,127.0.0.1,::1', ['::']],
    ['0.0.0.0,::1', ['0.0.0.0', '::1']],
    ['0.0.0.0,my-mac.local', ['0.0.0.0', 'my-mac.local']],
  ])('drops entries an overlapping wildcard already covers: %s', (value, expected) => {
    expect(resolveBindHosts({ PIPELINELY_HOST: value })).toEqual(expected)
  })

  it('fails on one bad entry in an otherwise valid list rather than dropping it', () => {
    expect(() => resolveBindHosts({ PIPELINELY_HOST: '127.0.0.1,bad host' })).toThrow(/bad host/)
  })
})

describe('isWideBind', () => {
  it.each(['127.0.0.1', '127.0.0.53', '::1', 'localhost', 'LOCALHOST', '::ffff:127.0.0.1'])(
    '%s is loopback, not wide',
    (host) => {
      expect(isWideBind(host)).toBe(false)
    },
  )

  it.each(['0.0.0.0', '::', TAILSCALE_STYLE_ADDRESS, '192.168.1.20', '10.0.0.5', 'my-mac.local', '::ffff:192.168.1.20'])(
    '%s is wide',
    (host) => {
      expect(isWideBind(host)).toBe(true)
    },
  )
})

describe('wideBindWarnings', () => {
  const REMOTE_ACCESS_OFF = false
  const REMOTE_ACCESS_ON = true

  it('emits nothing for a loopback-only bind', () => {
    expect(wideBindWarnings(['127.0.0.1', '::1'], 3030, REMOTE_ACCESS_OFF)).toEqual([])
    expect(wideBindWarnings(['127.0.0.1', '::1'], 3030, REMOTE_ACCESS_ON)).toEqual([])
  })

  it('emits exactly one warning per wide host, naming the address and port', () => {
    const warnings = wideBindWarnings(['127.0.0.1', TAILSCALE_STYLE_ADDRESS, '0.0.0.0'], 3030, REMOTE_ACCESS_ON)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain(`${TAILSCALE_STYLE_ADDRESS}:3030`)
    expect(warnings[1]).toContain('0.0.0.0:3030')
  })

  it('with no token, says remote clients get 403 and names the command that turns remote access on', () => {
    const [warning] = wideBindWarnings(['0.0.0.0'], 3030, REMOTE_ACCESS_OFF)
    expect(warning).toContain('network-accessible')
    expect(warning).toContain('403')
    expect(warning).toContain('npm run remote-token -- create')
  })

  it('with a token, says remote clients must sign in and no longer calls the dashboard unauthenticated', () => {
    const [warning] = wideBindWarnings(['0.0.0.0'], 3030, REMOTE_ACCESS_ON)
    expect(warning).toContain('sign in')
    expect(warning).not.toContain('unauthenticated')
  })

  it('keeps the 0.0.0.0 advice when a token is set, because a wildcard bind sends the token in cleartext off the tailnet', () => {
    const [warning] = wideBindWarnings(['0.0.0.0'], 3030, REMOTE_ACCESS_ON)
    expect(warning).toContain('rather than 0.0.0.0')
  })
})

describe('dashboardUrl', () => {
  it('uses localhost when a loopback host is among those bound', () => {
    expect(dashboardUrl(['127.0.0.1', TAILSCALE_STYLE_ADDRESS], 3030)).toBe('http://localhost:3030')
  })

  it('uses localhost for a wildcard bind, which loopback also reaches', () => {
    expect(dashboardUrl(['0.0.0.0'], 3030)).toBe('http://localhost:3030')
    expect(dashboardUrl(['::'], 3030)).toBe('http://localhost:3030')
  })

  it('does not treat a 127.-prefixed hostname as loopback, matching isWideBind and its warning', () => {
    expect(isWideBind('127.example.com')).toBe(true)
    expect(dashboardUrl(['127.example.com'], 3030)).toBe('http://127.example.com:3030')
  })

  it('prints the bracketed literal for an ::1-only bind, which a localhost that resolves to 127.0.0.1 cannot reach', () => {
    expect(dashboardUrl(['::1'], 3030)).toBe('http://[::1]:3030')
    expect(dashboardUrl(['::1', TAILSCALE_STYLE_ADDRESS], 3030)).toBe('http://[::1]:3030')
  })

  it('points at the first host when nothing loopback-reachable is bound', () => {
    expect(dashboardUrl([TAILSCALE_STYLE_ADDRESS], 3030)).toBe(`http://${TAILSCALE_STYLE_ADDRESS}:3030`)
  })
})

describe('listenOnHosts (real sockets, ephemeral ports)', () => {
  const app: http.RequestListener = (_req, res) => res.end('ok')
  let primary: http.Server | null
  let strayServer: net.Server | null

  beforeEach(() => {
    primary = null
    strayServer = null
  })

  afterEach(async () => {
    if (primary?.listening) await new Promise((resolve) => primary!.close(resolve))
    if (strayServer?.listening) await new Promise((resolve) => strayServer!.close(resolve))
  })

  const boundPort = (server: http.Server): number => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('expected a network address')
    return address.port
  }

  it('listens on loopback and serves requests', async () => {
    primary = await listenOnHosts(app, ['127.0.0.1'], 0)
    const res = await fetch(`http://127.0.0.1:${boundPort(primary)}/`)
    expect(await res.text()).toBe('ok')
  })

  it('refuses connections on an interface that is not listed', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return // offline machine: nothing to connect to
    primary = await listenOnHosts(app, ['127.0.0.1'], 0)
    expect(await canConnect(lanAddress, boundPort(primary))).toBe(false)
  })

  it('listens on every listed host on the same port, including with an ephemeral port', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return
    primary = await listenOnHosts(app, ['127.0.0.1', lanAddress], 0)
    const port = boundPort(primary)
    expect(await canConnect('127.0.0.1', port)).toBe(true)
    expect(await canConnect(lanAddress, port)).toBe(true)
  })

  it('closing the returned server closes the listeners on the other hosts too', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return
    primary = await listenOnHosts(app, ['127.0.0.1', lanAddress], 0)
    const port = boundPort(primary)
    await new Promise((resolve) => primary!.close(resolve))
    expect(await canConnect(lanAddress, port)).toBe(false)
  })

  it('rejects with a message naming the host and PIPELINELY_HOST when a host cannot be bound', async () => {
    await expect(listenOnHosts(app, [UNASSIGNED_TEST_NET_ADDRESS], 0)).rejects.toThrow(
      new RegExp(`${UNASSIGNED_TEST_NET_ADDRESS}.*PIPELINELY_HOST|PIPELINELY_HOST.*${UNASSIGNED_TEST_NET_ADDRESS}`),
    )
  })

  it('leaves no listener behind when a later host fails to bind', async () => {
    const primaryProbe = net.createServer()
    await new Promise<void>((resolve) => primaryProbe.listen(0, '127.0.0.1', resolve))
    const freePort = (primaryProbe.address() as net.AddressInfo).port
    await new Promise((resolve) => primaryProbe.close(resolve))

    await expect(listenOnHosts(app, ['127.0.0.1', UNASSIGNED_TEST_NET_ADDRESS], freePort)).rejects.toThrow(
      UNASSIGNED_TEST_NET_ADDRESS,
    )
    expect(await canConnect('127.0.0.1', freePort)).toBe(false)
  })

  it('does not probe 127.0.0.1 when only a non-loopback host is configured', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return
    strayServer = net.createServer()
    await new Promise<void>((resolve) => strayServer!.listen(0, '127.0.0.1', resolve))
    const strayPort = (strayServer.address() as net.AddressInfo).port

    primary = await listenOnHosts(app, [lanAddress], strayPort)
    expect(await canConnect(lanAddress, strayPort)).toBe(true)
  })

  it('rejects with EADDRINUSE for a non-loopback-only host list when a stray process holds the port on the wildcard', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return
    strayServer = net.createServer()
    await new Promise<void>((resolve) => strayServer!.listen(0, '0.0.0.0', resolve))
    const strayPort = (strayServer.address() as net.AddressInfo).port

    await expect(listenOnHosts(app, [lanAddress], strayPort)).rejects.toThrow(/EADDRINUSE/)
  })

  it('detects a stray IPv4 wildcard listener when the host is the :: wildcard', async () => {
    strayServer = net.createServer()
    await new Promise<void>((resolve) => strayServer!.listen(0, '0.0.0.0', resolve))
    const strayPort = (strayServer.address() as net.AddressInfo).port

    await expect(listenOnHosts(app, ['::'], strayPort)).rejects.toThrow(/EADDRINUSE/)
  })

  it('probes hosts concurrently, so startup delay is bounded by one probe timeout, not one per host', async () => {
    const unassignedAddresses = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4', '192.0.2.5']
    const startedAt = Date.now()
    await expect(listenOnHosts(app, unassignedAddresses, 45998)).rejects.toThrow(/PIPELINELY_HOST/)
    expect(Date.now() - startedAt).toBeLessThan(1500)
  })

  it('rejects on an unassigned address without hanging on the port probe', async () => {
    const startedAt = Date.now()
    await expect(listenOnHosts(app, [UNASSIGNED_TEST_NET_ADDRESS], 45999)).rejects.toThrow(UNASSIGNED_TEST_NET_ADDRESS)
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })

  it('rejects with EADDRINUSE naming the host when a later host is already taken, releasing the earlier ones', async () => {
    const lanAddress = firstNonLoopbackIPv4()
    if (lanAddress === null) return
    strayServer = net.createServer()
    await new Promise<void>((resolve) => strayServer!.listen(0, lanAddress, resolve))
    const strayPort = (strayServer.address() as net.AddressInfo).port

    await expect(listenOnHosts(app, ['127.0.0.1', lanAddress], strayPort)).rejects.toThrow(
      new RegExp(`${lanAddress}.*EADDRINUSE|EADDRINUSE.*${lanAddress}`),
    )
    expect(await canConnect('127.0.0.1', strayPort)).toBe(false)
  })

  // macOS lets a loopback bind coexist with an unrelated wildcard listener on
  // the same port without EADDRINUSE, so listenOnHosts probes for one itself.
  it('rejects with EADDRINUSE when a stray process already holds the port on a wider address', async () => {
    strayServer = net.createServer()
    await new Promise<void>((resolve) => strayServer!.listen(0, '0.0.0.0', resolve))
    const strayPort = (strayServer.address() as net.AddressInfo).port

    await expect(listenOnHosts(app, ['127.0.0.1'], strayPort)).rejects.toThrow(/EADDRINUSE/)
  })
})

describe('describeListenFailure', () => {
  const failure = (code: string) => Object.assign(new Error(`listen ${code}`), { code })

  it.each(['EADDRNOTAVAIL', 'ENOTFOUND', 'EINVAL'])('says every listed host must be on this machine for %s', (code) => {
    const message = describeListenFailure('100.64.0.7', 3030, failure(code)).message
    expect(message).toContain('100.64.0.7:3030')
    expect(message).toContain(code)
    expect(message).toContain('must be an address on this machine')
  })

  it('says the port is already in use, and to check PORT, for EADDRINUSE — without the wrong host hint', () => {
    const message = describeListenFailure('127.0.0.1', 3030, failure('EADDRINUSE')).message
    expect(message).toContain('EADDRINUSE')
    expect(message).toMatch(/port already in use/i)
    expect(message).toContain('PORT')
    expect(message).not.toContain('must be an address on this machine')
  })

  it('adds no misleading hint for an unrelated error code, and keeps the cause', () => {
    const cause = failure('EACCES')
    const error = describeListenFailure('127.0.0.1', 80, cause)
    expect(error.message).toContain('EACCES')
    expect(error.message).not.toContain('must be an address on this machine')
    expect(error.cause).toBe(cause)
  })
})
