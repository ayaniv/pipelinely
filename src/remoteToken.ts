import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

// The remote-access token is the only secret this server holds. It lives in
// the user's config directory, never under a repo checkout (TASKS_DIR sits
// inside one), and is readable by the owner only.

export const REMOTE_TOKEN_FILE_ENV_VAR = 'PIPELINELY_REMOTE_TOKEN_FILE'

// The CLI writes 43 characters. The floor exists because the file is plain
// text someone can overwrite by hand and there is no login rate limiter, so a
// short token could be guessed online.
export const MIN_REMOTE_TOKEN_LENGTH = 32

const TOKEN_BYTES = 32
const OWNER_ONLY_DIR_MODE = 0o700
const OWNER_ONLY_FILE_MODE = 0o600

export function remoteTokenPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'pipelinely', 'remote-token')
}

// The override exists for one caller: playwright.config.ts's fixture server,
// which must never read (or need) the developer's real token.
export function resolveRemoteTokenPath(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[REMOTE_TOKEN_FILE_ENV_VAR]?.trim()
  return override ? override : remoteTokenPath(homeDir)
}

export function generateRemoteToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url')
}

export async function writeRemoteToken(tokenFile: string, token: string): Promise<void> {
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: OWNER_ONLY_DIR_MODE })
  await fs.writeFile(tokenFile, token, { mode: OWNER_ONLY_FILE_MODE })
  // writeFile's mode only applies when it creates the file; a hand-made,
  // wider file would otherwise keep its mode.
  await fs.chmod(tokenFile, OWNER_ONLY_FILE_MODE)
}

// null means "remote access is off" (no file, or nothing in it). Any other
// read error is thrown so the caller fails the request closed and logs it.
export async function readRemoteToken(tokenFile: string): Promise<string | null> {
  let contents: string
  try {
    contents = await fs.readFile(tokenFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const token = contents.trim()
  return token ? token : null
}

function sha256(value: string): Buffer {
  return crypto.createHash('sha256').update(value).digest()
}

// Digests have a fixed length, so neither content nor length differences leak
// through timing.
export function tokensMatch(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false
  return crypto.timingSafeEqual(sha256(candidate), sha256(expected))
}
