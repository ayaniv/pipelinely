import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Single-line pointer file in the tasks dir, same convention as
// ORCHESTRATOR_SESSION / WEEKLY_FOCUS. It lives in a file rather than an env
// var because every worker's launch.sh does `unset REPOS_DIR` — a file is the
// only per-machine setting that survives that.
export const REPOS_DIR_FILE = 'REPOS_DIR'

export type ReposDirSource = 'env' | 'file' | 'default'

export interface ResolvedReposDir {
  reposDir: string
  source: ReposDirSource
}

export interface ResolveReposDirInput {
  envValue: string | undefined
  tasksDir: string
  homeDir: string
}

// A quoted `~/Dev` reaches us unexpanded (the shell only expands an unquoted
// one), and the ask-once prompt promises "~/Dev", so honor a leading ~.
function expandHome(value: string, homeDir: string): string {
  if (value === '~') return homeDir
  return value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value
}

// path.resolve also drops a trailing slash, so every source reports one
// canonical absolute form.
function normalizeRoot(value: string, homeDir: string): string {
  return path.resolve(expandHome(value, homeDir))
}

// NUL and other control characters (newline included), plus U+FFFD, which is
// what a non-UTF-8 byte decodes to — none of them belong in a path we write
// to a one-line pointer file and bake into shell launch scripts.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNCLEAN_TEXT = /[\u0000-\u001f\u007f\ufffd]/

export type ReposRootCheck = { ok: true; reposDir: string } | { ok: false; reason: string }

// The one validator for a user-chosen repo root, shared by `repos-dir set` and
// the dashboard-side resolve so the two cannot disagree about what is usable.
// Callers resolve any relative input against their own cwd first: a saved
// value must already be absolute because the CLI and the server have
// different cwds.
export function validateReposRoot(value: string, homeDir: string): ReposRootCheck {
  if (UNCLEAN_TEXT.test(value)) {
    return { ok: false, reason: 'it contains a control character, newline or invalid text' }
  }
  const expanded = expandHome(value, homeDir)
  if (!path.isAbsolute(expanded)) return { ok: false, reason: `${value} is not an absolute path` }
  const reposDir = path.resolve(expanded)
  let stat: fs.Stats
  try {
    stat = fs.statSync(reposDir)
  } catch {
    return { ok: false, reason: `repo root does not exist: ${reposDir}` }
  }
  if (!stat.isDirectory()) return { ok: false, reason: `repo root is not a directory: ${reposDir}` }
  try {
    fs.accessSync(reposDir, fs.constants.R_OK | fs.constants.X_OK)
  } catch {
    return { ok: false, reason: `repo root is not readable: ${reposDir}` }
  }
  return { ok: true, reposDir }
}

// A broken file is re-read on every dashboard poll; logging each time would
// bury the log under one failure.
const loggedFailures = new Set<string>()

function logOnce(failureKey: string, message: string, err?: unknown): void {
  if (loggedFailures.has(failureKey)) return
  loggedFailures.add(failureKey)
  if (err === undefined) console.error(message)
  else console.error(message, err)
}

function readSavedReposDir(tasksDir: string): string | null {
  const filePath = path.join(tasksDir, REPOS_DIR_FILE)
  try {
    return fs.readFileSync(filePath, 'utf-8').trim() || null
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    // A present-but-unreadable file is a broken setting, not an unset one —
    // falling back silently would send every repo operation to ~/Dev with no
    // hint why the saved root stopped applying.
    logOnce(
      `${filePath}:${(err as NodeJS.ErrnoException).code}`,
      `resolveReposDir: could not read ${filePath}, falling back to the default repo root:`,
      err,
    )
    return null
  }
}

// Env first because the server's e2e fixtures map REPOS_DIR to fixture space
// (see e2eIsolation.ts); read live on every call so `repos-dir set` takes
// effect in a running dashboard without a restart.
export function resolveReposDir({ envValue, tasksDir, homeDir }: ResolveReposDirInput): ResolvedReposDir {
  if (envValue) return { reposDir: normalizeRoot(envValue, homeDir), source: 'env' }
  const saved = readSavedReposDir(tasksDir)
  if (saved) {
    const check = validateReposRoot(saved, homeDir)
    if (check.ok) return { reposDir: check.reposDir, source: 'file' }
    // A hand edit, corruption or a since-deleted directory: warn and use the
    // default rather than point every repo operation at a bad root. The CLI
    // resolves through here too, so it behaves identically.
    logOnce(
      `${tasksDir}:${saved}:${check.reason}`,
      `resolveReposDir: ignoring saved repo root in ${path.join(tasksDir, REPOS_DIR_FILE)} (${JSON.stringify(saved)}): ${check.reason}; falling back to the default repo root`,
    )
  }
  return { reposDir: path.join(homeDir, 'Dev'), source: 'default' }
}

// Returns the absolute path that was saved. Validates before writing and
// renames a temp file into place, so a refused or interrupted set never
// leaves a partial or replaced value behind.
export function writeReposDir(tasksDir: string, dir: string, cwd: string, homeDir: string = os.homedir()): string {
  const check = validateReposRoot(path.resolve(cwd, expandHome(dir, homeDir)), homeDir)
  if (!check.ok) throw new Error(`Cannot use ${dir} as the repo root: ${check.reason}`)
  const absoluteDir = check.reposDir

  const filePath = path.join(tasksDir, REPOS_DIR_FILE)
  const tempPath = `${filePath}.${process.pid}.tmp`
  try {
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(tempPath, `${absoluteDir}\n`)
    fs.renameSync(tempPath, filePath)
  } catch (err) {
    fs.rmSync(tempPath, { force: true })
    throw err
  }
  return absoluteDir
}
