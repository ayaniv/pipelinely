import os from 'node:os'

// This machine's own first non-internal IPv4 address — the only way a single
// machine can present a server with a genuinely non-loopback peer, short of a
// second device. Null on a fully offline machine, in which case callers
// should skip their remote-direction cases explicitly rather than pass
// vacuously; loopback-direction cases (the regression constraint every one of
// these suites guards) always run regardless.
export function firstNonLoopbackIPv4(): string | null {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address
    }
  }
  return null
}
