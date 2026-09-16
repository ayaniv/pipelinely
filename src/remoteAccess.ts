import net from 'node:net'

// The single definition of "did this request originate on the machine the
// dashboard is running on?".
//
// Loopback means the desktop browser — the developer sitting at the keyboard,
// whose staged-command-then-manual-Return gate must never change (see
// tech-design.md's "Why this shape, given what happened on 2026-09-06").
// Everything else is a remote access context: a phone on the tailnet, another
// machine on the LAN.
//
// The signal is deliberately the request's own TCP peer address and nothing
// else. `Host`, `Origin` and `X-Forwarded-For` are all client-supplied strings
// a bookmark, a stale service worker, or a client bug could set to anything;
// `req.socket.remoteAddress` is filled in by the kernel from the actual
// connection and cannot be forged by the peer. `app.set('trust proxy', …)` is
// likewise never enabled — it would make `req.ip` honour a forgeable header,
// which is the exact inversion of this design.

const IPV4_MAPPED_PREFIX = '::ffff:'

// True means "treat as local", which is the *safe* answer: local stages the
// command and waits for a human Return. Every path that cannot positively
// identify a real, non-loopback peer therefore lands here — a missing address,
// an empty one, or anything that does not parse as an IP at all. Making the
// unsafe direction require positive evidence is the point.
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return true

  const trimmed = address.trim().toLowerCase()
  if (!trimmed || trimmed === 'localhost') return true

  // A server bound to 0.0.0.0 sees IPv4 peers in IPv4-mapped IPv6 form
  // (`::ffff:127.0.0.1`) on macOS — that, not the bare `127.0.0.1`, is the
  // real desktop developer's real peer address, so it must reduce to the
  // same answer as the plain IPv4 form rather than being classified as some
  // separate kind of IPv6.
  const candidate = trimmed.startsWith(IPV4_MAPPED_PREFIX)
    ? trimmed.slice(IPV4_MAPPED_PREFIX.length)
    : trimmed

  switch (net.isIP(candidate)) {
    case 4:
      // The whole 127.0.0.0/8 block, not just 127.0.0.1 — macOS resolvers
      // legitimately use other addresses in it (127.0.0.53 and friends).
      return candidate.startsWith('127.')
    case 6:
      return candidate === '::1' || candidate === '0:0:0:0:0:0:0:1'
    default:
      // Not an address we can read: fail closed to local.
      return true
  }
}

// The single named accessor every call site uses. No route reads
// `req.socket.remoteAddress` directly, so the day this has to understand a
// reverse proxy there is exactly one place to teach.
export function requestIsRemote(req: { socket?: { remoteAddress?: string } }): boolean {
  return !isLoopbackAddress(req.socket?.remoteAddress)
}
