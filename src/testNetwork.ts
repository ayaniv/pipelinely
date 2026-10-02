import http from 'node:http'
import net from 'node:net'
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

// Whether a TCP connection to host:port is accepted — used to assert which
// interfaces a server is (or is not) listening on.
export function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

export interface RawHttpResponse {
  status: number
  body: string
}

// One HTTP request to a loopback server with exactly the headers given —
// a forged `Host` included, which is what a DNS-rebinding page produces and
// what fetch() cannot be relied on to send unchanged.
export function rawHttpRequest(
  port: number,
  method: string,
  pathname: string,
  headers: Record<string, string>,
): Promise<RawHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}
