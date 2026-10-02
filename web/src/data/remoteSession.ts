import type { Logger } from '../log'

// Mirrors LOGIN_PATH in src/remoteAuth.ts; the web bundle can't import server
// code, and this is a URL, not logic that can drift silently (the e2e spec
// navigates to it).
export const REMOTE_LOGIN_PATH = '/remote-login'

export interface RemoteSessionDeps {
  log: Logger
  navigate?: (path: string) => void
}

const REFUSALS_THAT_MEAN_SIGN_IN = new Set(['remote-auth-required', 'remote-access-disabled'])

async function refusalError(response: Response): Promise<unknown> {
  try {
    return ((await response.clone().json()) as { error?: unknown }).error
  } catch {
    // Not a JSON refusal from the remote-auth gate (a proxy's HTML error
    // page, say): an ordinary failure, left to the caller.
    return undefined
  }
}

// One place that turns "the server wants a session" into the login page, so
// no fetch wrapper re-implements the status check. Returns whether it
// redirected; the response body is left unread for the caller.
export async function redirectToRemoteLogin(response: Response, { log, navigate }: RemoteSessionDeps): Promise<boolean> {
  if (response.status !== 401 && response.status !== 403) return false
  if (!REFUSALS_THAT_MEAN_SIGN_IN.has(String(await refusalError(response)))) return false
  log(`[remote-session] ${response.status} from the dashboard; sending this device to ${REMOTE_LOGIN_PATH}`)
  const go = navigate ?? ((path: string) => window.location.assign(path))
  go(REMOTE_LOGIN_PATH)
  return true
}
