import type { IncomingHttpHeaders } from 'node:http'
import { checkLoopbackHostAndOrigin, type LocalWriteRefusal } from './localWriteGuard.js'
import { requestNeedsRemoteAuth } from './remoteAuth.js'

// Answering a dialog types into a live session, so unlike the dashboard's other
// routes it is loopback-only whether or not the request is signed in
// (privacy-remote-auth-plan's gate only ever makes a request stricter, and
// lifting this is a separate decision). It reuses the shared remote
// classification and Host/Origin guard rather than carrying its own copies.

export type AnswerDialogRefusal = 'not-json' | 'remote' | LocalWriteRefusal

interface GuardableRequest {
  method?: string
  headers: IncomingHttpHeaders
  socket?: { remoteAddress?: string }
}

const JSON_MEDIA_TYPE = 'application/json'

// A form or text/plain POST is a cross-site "simple" request a page can send
// with no preflight; requiring JSON means the browser must preflight, and the
// server never answers one.
function isJsonRequest(req: GuardableRequest): boolean {
  const contentType = req.headers['content-type']
  return typeof contentType === 'string' && contentType.split(';')[0].trim().toLowerCase() === JSON_MEDIA_TYPE
}

export function checkAnswerDialogRequest(req: GuardableRequest): AnswerDialogRefusal | null {
  if (!isJsonRequest(req)) return 'not-json'
  if (requestNeedsRemoteAuth(req)) return 'remote'
  return checkLoopbackHostAndOrigin(req)
}
