import http from 'node:http'
import net from 'node:net'
import { isLoopbackAddress } from './remoteAccess.js'

// The dashboard exposes endpoints that stage commands into terminal
// sessions, so it listens on loopback unless PIPELINELY_HOST explicitly opts
// into something wider (and then remote clients need the remote-access token).
export const DEFAULT_BIND_HOST = '127.0.0.1'
export const BIND_HOST_ENV_VAR = 'PIPELINELY_HOST'

// RFC 1123 hostname labels — enough to reject typos, URLs and host:port
// pastes up front. Whether a well-formed name actually resolves is left to
// listen(), which reports it.
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

// A name whose last label is all digits (e.g. 999.1.1.1) is a mistyped IP
// address, not a hostname — catch it here instead of as an opaque ENOTFOUND.
const NUMERIC_LAST_LABEL_PATTERN = /(^|\.)\d+$/

function isValidBindHost(host: string): boolean {
  if (net.isIP(host) !== 0) return true
  return HOSTNAME_PATTERN.test(host) && !NUMERIC_LAST_LABEL_PATTERN.test(host)
}

// PIPELINELY_HOST is a comma-separated list because a server bound only to a
// Tailscale address stops answering on localhost — reaching it from both the
// desktop and a phone needs one listener per address. Invalid entries throw
// rather than being dropped: silently ignoring one would either bind
// narrower than asked (a confusing outage) or, for a typo'd wide address,
// hide that the wide bind never happened.
export function resolveBindHosts(env: { PIPELINELY_HOST?: string }): string[] {
  const entries = (env.PIPELINELY_HOST ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')

  const invalidEntry = entries.find((entry) => !isValidBindHost(entry))
  if (invalidEntry !== undefined) {
    throw new Error(
      `${BIND_HOST_ENV_VAR} contains an invalid host "${invalidEntry}". Expected a comma-separated list of IP addresses or hostnames, e.g. ${BIND_HOST_ENV_VAR}=127.0.0.1,100.64.0.7`,
    )
  }

  if (entries.length === 0) return [DEFAULT_BIND_HOST]
  return dropEntriesCoveredByWildcard([...new Set(entries)])
}

const IPV4_WILDCARD = '0.0.0.0'
const IPV6_WILDCARD = '::'

// A wildcard listener already answers on every address it covers, and a second
// listen on one of them is EADDRINUSE on Linux while macOS quietly lets both
// coexist. `::` is dual-stack in Node, so it covers every IP; `0.0.0.0` covers
// every IPv4 one. Hostnames are kept: we cannot know what they resolve to.
function dropEntriesCoveredByWildcard(hosts: string[]): string[] {
  const hasIPv6Wildcard = hosts.includes(IPV6_WILDCARD)
  const hasIPv4Wildcard = hosts.includes(IPV4_WILDCARD)
  return hosts.filter((host) => {
    if (host === IPV6_WILDCARD) return true
    const ipVersion = net.isIP(host)
    if (hasIPv6Wildcard && ipVersion !== 0) return false
    if (hasIPv4Wildcard && ipVersion === 4 && host !== IPV4_WILDCARD) return false
    return true
  })
}

// isLoopbackAddress fails closed to "local" for anything it cannot parse,
// which is right for classifying a request peer but the opposite of right
// here: a hostname or wildcard we cannot positively call loopback must count
// as a wide bind, so the warning fires.
export function isWideBind(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  const isNamedLoopback = normalized === 'localhost'
  const isAddress = net.isIP(normalized.replace(/^::ffff:/, '')) !== 0
  if (!isNamedLoopback && !isAddress) return true
  return !isLoopbackAddress(normalized)
}

export function wideBindWarnings(hosts: string[], port: number, isRemoteAccessOn: boolean): string[] {
  const remoteAccessState = isRemoteAccessOn
    ? 'Remote clients must sign in with the remote-access token.'
    : "Remote access is off, so remote clients get 403 until you run 'npm run remote-token -- create'."
  return hosts
    .filter(isWideBind)
    .map(
      (host) =>
        `WARNING: the dashboard is network-accessible at ${formatHostPort(host, port)}. ${remoteAccessState} Bind a specific LAN/Tailscale address rather than 0.0.0.0 (a wildcard or Wi-Fi bind sends the token over plain HTTP), or drop ${BIND_HOST_ENV_VAR} to go back to localhost-only.`,
    )
}

function formatHostPort(host: string, port: number): string {
  return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`
}

// `localhost` may resolve to either family, so it is only an honest URL when
// an IPv4 loopback listener or a wildcard (dual-stack) one is bound. An
// ::1-only or tailnet-only bind has to name its address instead.
export function dashboardUrl(hosts: string[], port: number): string {
  const isReachableAsLocalhost = hosts.some(
    (host) => host === IPV4_WILDCARD || host === IPV6_WILDCARD || host === 'localhost' || (net.isIPv4(host) && host.startsWith('127.')),
  )
  return isReachableAsLocalhost ? `http://localhost:${port}` : `http://${formatHostPort(hosts[0], port)}`
}

const ADDRESS_NOT_ON_MACHINE_CODES = new Set(['EADDRNOTAVAIL', 'ENOTFOUND', 'EINVAL'])

// The hint has to match the cause: telling someone whose port is taken to
// check their host list hides the real problem.
function listenFailureHint(code: string | undefined): string {
  if (code === 'EADDRINUSE') return `Port already in use — check PORT and what else is listening on it.`
  if (code !== undefined && ADDRESS_NOT_ON_MACHINE_CODES.has(code)) {
    return `Check ${BIND_HOST_ENV_VAR}: every listed host must be an address on this machine.`
  }
  return ''
}

export function describeListenFailure(host: string, port: number, error: NodeJS.ErrnoException): Error {
  const hint = listenFailureHint(error.code)
  return new Error(
    `Cannot listen on ${formatHostPort(host, port)} (${error.code ?? 'unknown error'}: ${error.message}).${hint ? ` ${hint}` : ''}`,
    { cause: error },
  )
}

function listenOn(server: http.Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(describeListenFailure(host, port, error)))
    server.listen(port, host, resolve)
  })
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) return resolve()
    server.close(() => resolve())
  })
}

// The addresses a client on this machine would use to reach a listener bound
// to `host`. Wildcards are reached over loopback — `::` is dual-stack, so it
// claims both families and a stray listener on either one is a conflict. Any
// other address is probed as itself: a connect to a locally-assigned address
// only reaches a listener that covers that address (the wildcard, or that
// address), so an unrelated loopback-only process is not a false positive for
// a tailnet/LAN-only bind.
function probeAddresses(host: string): string[] {
  if (host === IPV4_WILDCARD || host === 'localhost') return [DEFAULT_BIND_HOST]
  if (host === IPV6_WILDCARD) return [DEFAULT_BIND_HOST, '::1']
  return [host]
}

// Bounded so an address that is not on this machine (a typo, Tailscale down)
// cannot hang startup — the real listen then reports it properly.
const PROBE_TIMEOUT_MS = 500

function probeForListener(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

// macOS lets a narrower bind coexist with an unrelated wildcard listener on
// the same port without EADDRINUSE. Binding the wildcard used to make a
// stray process holding the port a loud crash; now that we bind narrower, a
// connect probe is what keeps "some other process already serves this port"
// from silently splitting traffic between two servers.
// Probes run concurrently so total startup delay is one PROBE_TIMEOUT_MS at
// worst however long the host list is; addresses that are assigned here
// answer (or refuse) in milliseconds, so only a config that is about to fail
// anyway ever waits.
async function assertPortUnclaimed(hosts: string[], port: number): Promise<void> {
  const addresses = [...new Set(hosts.flatMap(probeAddresses))]
  const results = await Promise.all(
    addresses.map(async (address) => ({ address, isClaimed: await probeForListener(address, port) })),
  )
  const claimed = results.find((result) => result.isClaimed)
  if (claimed) {
    throw new Error(
      `Cannot listen on ${formatHostPort(claimed.address, port)} (EADDRINUSE): another process is already accepting connections on it. Port already in use — check PORT and what else is listening on it.`,
    )
  }
}

// One listener per host, all on the same port; for port 0 the OS-assigned
// port of the first listener is reused for the rest. Returns the first
// server so callers keep a single handle — closing it closes the others.
export async function listenOnHosts(app: http.RequestListener, hosts: string[], port: number): Promise<http.Server> {
  if (port !== 0) await assertPortUnclaimed(hosts, port)

  const [primaryHost, ...otherHosts] = hosts
  const primary = http.createServer(app)
  await listenOn(primary, primaryHost, port)

  const address = primary.address()
  const sharedPort = address !== null && typeof address === 'object' ? address.port : port

  const secondaries: http.Server[] = []
  try {
    for (const host of otherHosts) {
      const secondary = http.createServer(app)
      secondaries.push(secondary)
      await listenOn(secondary, host, sharedPort)
    }
  } catch (error) {
    await Promise.all([primary, ...secondaries].map(closeServer))
    throw error
  }

  primary.on('close', () => {
    secondaries.forEach((secondary) => secondary.close())
  })
  return primary
}
