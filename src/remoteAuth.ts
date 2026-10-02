import express from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { checkFetchSite, checkLoopbackHostAndOrigin } from './localWriteGuard.js'
import type { LocalWriteRefusal } from './localWriteGuard.js'
import { isKnownLoopbackAddress, requestCameThroughProxy } from './remoteAccess.js'
import { MIN_REMOTE_TOKEN_LENGTH, tokensMatch } from './remoteToken.js'

export const LOGIN_PATH = '/remote-login'
export const LOGOUT_PATH = '/remote-logout'
export const REMOTE_SESSION_COOKIE = 'pipelinely_remote'
export const REMOTE_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

const LOGIN_BODY_LIMIT = '4kb'

export type RequestAccess = 'loopback' | 'remote-authenticated'

type RequestShape = Pick<Request, 'headers'> & { socket?: { remoteAddress?: string } }

export interface RemoteAuthOptions {
  // Per request, so `rotate` and `disable` take effect with no restart.
  // Null means remote access is off; a throw means it is unusable (fail closed).
  readToken: () => Promise<string | null>
  needsAuth?: (req: RequestShape) => boolean
}

// Fails closed: unlike requestIsRemote (which must call "unknown" local so
// auto-submit never fires by accident), a peer that is not positively
// loopback has to sign in.
export function requestNeedsRemoteAuth(req: RequestShape): boolean {
  return !isKnownLoopbackAddress(req.socket?.remoteAddress) || requestCameThroughProxy(req)
}

const ACCESS_LOCAL = 'pipelinelyRequestAccess'

export function requestAccess(res: Response): RequestAccess {
  return res.locals[ACCESS_LOCAL] === 'remote-authenticated' ? 'remote-authenticated' : 'loopback'
}

type TokenState =
  | { kind: 'disabled' }
  | { kind: 'unavailable' }
  | { kind: 'ready'; token: string }

function describePeer(req: Request): string {
  return req.socket?.remoteAddress ?? 'unknown-peer'
}

async function loadTokenState(req: Request, readToken: RemoteAuthOptions['readToken']): Promise<TokenState> {
  let token: string | null
  try {
    token = await readToken()
  } catch (err) {
    console.error(`remote-auth: cannot read the remote token file (${req.path} from ${describePeer(req)}); refusing remote requests`, err)
    return { kind: 'unavailable' }
  }
  if (token === null) return { kind: 'disabled' }
  if (token.length < MIN_REMOTE_TOKEN_LENGTH) {
    console.error(`remote-auth: the remote token is shorter than ${MIN_REMOTE_TOKEN_LENGTH} characters and is refused; run 'npm run remote-token -- rotate'`)
    return { kind: 'unavailable' }
  }
  return { kind: 'ready', token }
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie
  if (!header) return undefined
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    if (pair.slice(0, separator).trim() === REMOTE_SESSION_COOKIE) return decodeCookieValue(pair.slice(separator + 1).trim())
  }
  return undefined
}

// res.cookie percent-encodes the value, so a base64 token's + / = arrive
// escaped. A malformed value is simply not a session.
function decodeCookieValue(value: string): string | undefined {
  try {
    return decodeURIComponent(value)
  } catch {
    console.warn('remote-auth: ignoring a session cookie that is not valid percent-encoding')
    return undefined
  }
}

const SESSION_COOKIE_ATTRIBUTES = { httpOnly: true, sameSite: 'strict', path: '/' } as const

function setSessionCookie(res: Response, token: string): void {
  // No `secure`: the default transport is plain HTTP inside the tailnet.
  res.cookie(REMOTE_SESSION_COOKIE, token, { ...SESSION_COOKIE_ATTRIBUTES, maxAge: REMOTE_SESSION_MAX_AGE_SECONDS * 1000 })
}

function clearSessionCookie(res: Response): void {
  res.cookie(REMOTE_SESSION_COOKIE, '', { ...SESSION_COOKIE_ATTRIBUTES, maxAge: 0 })
}

const LOGIN_PAGE_STYLE = 'body{font:16px system-ui,sans-serif;margin:0;padding:24px;max-width:420px}input,button{font:inherit;padding:10px;width:100%;box-sizing:border-box;margin-top:12px}.error{color:#b00020}'

function renderLoginPage(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in</title><style>${LOGIN_PAGE_STYLE}</style></head><body>${body}</body></html>`
}

function renderLoginForm(hasError: boolean): string {
  const error = hasError ? '<p class="error" data-testid="remote-login-error">That token was not accepted.</p>' : ''
  return renderLoginPage(
    `<h1>Sign in</h1><p>Paste the remote-access token from the Mac (<code>npm run remote-token -- show</code>).</p>${error}` +
      `<form method="post" action="${LOGIN_PATH}" data-testid="remote-login-form">` +
      '<input type="password" name="token" autocomplete="off" data-testid="remote-login-token" aria-label="Token">' +
      '<button type="submit" data-testid="remote-login-submit">Sign in</button></form>',
  )
}

function renderDisabledPage(): string {
  return renderLoginPage(
    '<h1>Remote access is off</h1><div data-testid="remote-access-disabled"><p>Run <code>npm run remote-token -- create</code> on the Mac to turn it on.</p></div>',
  )
}

function wantsHtmlPage(req: Request): boolean {
  return req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')
}

// Loopback trusts a same-origin click, so no other site may frame the
// dashboard and steer the developer into one.
function refuseFraming(res: Response): void {
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
}

function refuseRequest(req: Request, res: Response, refusal: LocalWriteRefusal): void {
  console.warn(`remote-auth: refused ${req.method} ${req.path} from ${describePeer(req)} (${refusal})`)
  // `reason` is the machine-readable twin of `error`, the field the dashboard's own routes use for refusals.
  res.status(403).json({ error: refusal, reason: refusal })
}

function rejectUnavailable(res: Response): void {
  res.status(503).json({ error: 'remote-auth-unavailable' })
}

// One gate in front of everything, installed before any body parser or static
// mount. Loopback (the desktop) needs no token and is only checked for being
// driven from another site; anything remote needs the session cookie, and a
// remote write must also come from the dashboard's own origin, because
// SameSite treats every port of the tailnet IP as the same site.
export function installRemoteAuth(app: Express, options: RemoteAuthOptions): void {
  const needsAuth = options.needsAuth ?? requestNeedsRemoteAuth
  const loadState = (req: Request) => loadTokenState(req, options.readToken)

  app.use((req: Request, res: Response, next: NextFunction) => {
    refuseFraming(res)
    const isRemote = needsAuth(req)
    const refusal = isRemote ? checkFetchSite(req) : checkLoopbackHostAndOrigin(req)
    if (refusal !== null) return refuseRequest(req, res, refusal)
    if (!isRemote) res.locals[ACCESS_LOCAL] = 'loopback'
    next()
  })

  app.get(LOGIN_PATH, async (req, res, next) => {
    if (!needsAuth(req)) return next()
    const state = await loadState(req)
    if (state.kind === 'unavailable') return rejectUnavailable(res)
    res.type('html').send(state.kind === 'disabled' ? renderDisabledPage() : renderLoginForm(false))
  })

  app.post(LOGIN_PATH, express.urlencoded({ extended: false, limit: LOGIN_BODY_LIMIT }), async (req, res, next) => {
    if (!needsAuth(req)) return next()
    const state = await loadState(req)
    if (state.kind === 'unavailable') return rejectUnavailable(res)
    if (state.kind === 'disabled') {
      res.status(403).type('html').send(renderDisabledPage())
      return
    }
    const submitted: unknown = req.body?.token
    if (typeof submitted === 'string' && tokensMatch(submitted.trim(), state.token)) {
      setSessionCookie(res, state.token)
      res.redirect(303, '/')
      return
    }
    console.warn(`remote-auth: failed sign-in from ${describePeer(req)}`)
    res.status(401).type('html').send(renderLoginForm(true))
  })

  app.post(LOGOUT_PATH, (req, res, next) => {
    if (!needsAuth(req)) return next()
    clearSessionCookie(res)
    res.redirect(303, LOGIN_PATH)
  })

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!needsAuth(req)) return next()
    const state = await loadState(req)
    if (state.kind === 'unavailable') return rejectUnavailable(res)

    if (state.kind === 'ready' && tokensMatch(readSessionCookie(req), state.token)) {
      res.locals[ACCESS_LOCAL] = 'remote-authenticated'
      return next()
    }

    const reason = state.kind === 'disabled' ? 'remote-access-disabled' : 'remote-auth-required'
    console.warn(`remote-auth: rejected ${req.method} ${req.path} from ${describePeer(req)} (${reason})`)
    if (wantsHtmlPage(req)) return res.redirect(303, LOGIN_PATH)
    res.status(state.kind === 'disabled' ? 403 : 401).json({ error: reason })
  })
}
