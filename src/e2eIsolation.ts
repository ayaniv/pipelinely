import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANONICAL_REPO_PATH } from './derivePort.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The pointer file that must be unreachable for a real-integration spec to
// run safely — never a fixture path. If this exists, the process can see
// (and corrupt) the developer's actual, live orchestrator session.
const REAL_ORCHESTRATOR_SESSION_PATH = path.join(CANONICAL_REPO_PATH, 'tasks', 'ORCHESTRATOR_SESSION')

// The only legal TASKS_DIR value for a real-integration run — derived from
// this module's own location, same as playwright.config.ts derives its
// fixture paths, so it works from the canonical checkout and from any
// worktree alike.
const FIXTURE_TASKS_DIR = path.join(__dirname, '..', 'e2e', 'fixtures', 'tasks')

// How long a consent token stays valid after being minted. Not session
// hygiene — that is isProcessAlive's job (a token's runner shell exiting
// invalidates it immediately). This bound exists only for the case where a
// runner was SIGKILLed before its `trap` could remove the token, and its pid
// was later recycled: macOS recycles a pid only after wrapping the whole
// pid space, so 4 hours is nowhere near enough for that to be a realistic
// accident. It must comfortably exceed the real-integration suite's whole
// wall clock — the guard runs at module import in every Playwright worker,
// so a shorter bound would fire mid-run and read as a bug rather than a
// refusal.
const CONSENT_TOKEN_MAX_AGE_MS = 4 * 60 * 60 * 1000

export interface ConsentToken {
  nonce: string
  issuedAt: number
  runnerPid: number
}

export interface IsolationProbe {
  consentNonce: string | undefined
  consentTokenPath: string | undefined
  tasksDir: string | undefined
  fixtureTasksDir: string
  realOrchestratorPointerPath: string
  readTokenFile(tokenPath: string): string | undefined
  isProcessAlive(pid: number): boolean
  now(): number
}

// Built in a function, not a module-level const: the env-derived fields must
// be read when the guard runs, not when this module is first imported. A
// module-level capture would be a stale-read waiting to happen, and would
// silently defeat verify-consent.ts, whose whole job is reading env set by
// its caller.
function buildDefaultProbe(): IsolationProbe {
  return {
    consentNonce: process.env.COCKPIT_E2E_CONSENT,
    consentTokenPath: process.env.COCKPIT_E2E_CONSENT_FILE,
    tasksDir: process.env.TASKS_DIR,
    fixtureTasksDir: FIXTURE_TASKS_DIR,
    realOrchestratorPointerPath: REAL_ORCHESTRATOR_SESSION_PATH,
    readTokenFile: (tokenPath) => {
      try {
        return fs.readFileSync(tokenPath, 'utf8')
      } catch {
        return undefined
      }
    },
    isProcessAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        if (code === 'ESRCH') return false
        // EPERM means the process exists but belongs to another user —
        // alive. Anything else is unexpected and rethrown rather than
        // guessed at.
        if (code === 'EPERM') return true
        throw err
      }
    },
    now: () => Date.now(),
  }
}

const REMEDY = 'run this suite via `npm run test:e2e:integration` instead'

function parseConsentToken(raw: string): ConsentToken | undefined {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.issuedAt === 'number' &&
      typeof parsed.runnerPid === 'number'
    ) {
      return parsed as ConsentToken
    }
    return undefined
  } catch {
    return undefined
  }
}

// This is informed consent, not authentication — the threat is the
// developer being ambushed by real windows/keystrokes without having just
// agreed to it, not an attacker forging a token. A determined developer can
// hand-craft a token; what they cannot do is trigger a run by accident, or
// inherit a `yes` from a previous session (check 4), or have that `yes`
// survive indefinitely (check 5), or have it excuse a run aimed at real
// space (check 6).
export function assertIsolatedEnvironment(probe: IsolationProbe = buildDefaultProbe()): void {
  if (!probe.consentNonce || !probe.consentTokenPath) {
    throw new Error(`assertIsolatedEnvironment: no consent token — ${REMEDY}.`)
  }

  const raw = probe.readTokenFile(probe.consentTokenPath)
  if (raw === undefined) {
    throw new Error(`assertIsolatedEnvironment: consent token file at ${probe.consentTokenPath} could not be read — ${REMEDY}.`)
  }

  const token = parseConsentToken(raw)
  if (!token) {
    throw new Error(`assertIsolatedEnvironment: consent token file at ${probe.consentTokenPath} is not valid — ${REMEDY}.`)
  }

  if (token.nonce !== probe.consentNonce) {
    throw new Error(`assertIsolatedEnvironment: consent token nonce mismatch — ${REMEDY}.`)
  }

  if (!probe.isProcessAlive(token.runnerPid)) {
    throw new Error(
      `assertIsolatedEnvironment: consent token's runner (pid ${token.runnerPid}) is no longer running — consent does not outlive the shell that granted it; ${REMEDY}.`
    )
  }

  if (probe.now() - token.issuedAt >= CONSENT_TOKEN_MAX_AGE_MS) {
    throw new Error(`assertIsolatedEnvironment: consent token is older than ${CONSENT_TOKEN_MAX_AGE_MS}ms — ${REMEDY}.`)
  }

  if (!probe.tasksDir) {
    throw new Error(`assertIsolatedEnvironment: TASKS_DIR is not set — ${REMEDY}.`)
  }

  if (path.resolve(probe.tasksDir) !== path.resolve(probe.fixtureTasksDir)) {
    const realTasksDir = path.dirname(probe.realOrchestratorPointerPath)
    throw new Error(
      `assertIsolatedEnvironment: TASKS_DIR (${probe.tasksDir}) is not the fixture tasks dir (${probe.fixtureTasksDir}) — a real-integration run must never be aimed at ${realTasksDir}; ${REMEDY}.`
    )
  }
}

// The env vars playwright.config.ts's webServer must pin, mapped to the
// fixture subdirectory each one has to resolve to. One table rather than
// three near-identical checks, so adding a fourth pinned dir is a one-line
// change here and nowhere else.
const REQUIRED_FIXTURE_ENV_DIRS = {
  TASKS_DIR: 'tasks',
  REPOS_DIR: 'repos',
  WORKTREES_DIR: 'worktrees',
} as const

// Structurally the part of playwright.config.ts's webServer that this
// repo's isolation depends on. Deliberately not Playwright's own
// TestConfigWebServer: importing @playwright/test's types into src/ would
// make the app's typecheck depend on the test runner, and only these two
// fields are load-bearing here.
export interface WebServerIsolation {
  reuseExistingServer?: boolean
  env?: Record<string, string | number | boolean>
}

// The webServer guarantees that make a real-integration run safe, checked
// against the real, evaluated config object rather than its source text.
//
// This exists because each is a single line in playwright.config.ts, and
// their absence is the whole of the 2026-09-01 incident: Playwright adopted
// a stray dev server that was scoped to the developer's real TASKS_DIR, and
// the suite's self-heal rewrote the developer's live ORCHESTRATOR_SESSION
// pointer. `reuseExistingServer` defaulting back to true would re-arm that
// silently, with every existing test still green — so it gets a test.
//
// Returns one message per broken guarantee (empty means isolated) rather
// than throwing: a config with three unpinned dirs should report three
// problems at once, not hide two behind the first.
export function findWebServerIsolationViolations(
  webServer: WebServerIsolation,
  fixtureRootDir: string,
): string[] {
  const violations: string[] = []

  // Exactly `false`, not merely falsy: the incident's config had no
  // `reuseExistingServer` key at all, and Playwright's own default is to
  // reuse. An absent key must fail this check the same way `true` does.
  if (webServer.reuseExistingServer !== false) {
    violations.push(
      `webServer.reuseExistingServer must be exactly false (got ${JSON.stringify(webServer.reuseExistingServer)}) — ` +
        `anything else lets Playwright adopt a stray server running against the developer's real tasks dir.`
    )
  }

  for (const [envVar, fixtureSubdir] of Object.entries(REQUIRED_FIXTURE_ENV_DIRS)) {
    const expected = path.join(fixtureRootDir, fixtureSubdir)
    const actual = webServer.env?.[envVar]
    if (typeof actual !== 'string' || path.resolve(actual) !== path.resolve(expected)) {
      violations.push(
        `webServer.env.${envVar} must be pinned to ${expected} (got ${JSON.stringify(actual)}) — ` +
          `an unpinned value lets the server under test read and rewrite real pointer files.`
      )
    }
  }

  return violations
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function findSpecFiles(rootDir: string): string[] {
  const results: string[] = []
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const fullPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      results.push(...findSpecFiles(fullPath))
    } else if (entry.isFile() && entry.name.endsWith('.spec.ts')) {
      results.push(fullPath)
    }
  }
  return results
}

function isUnderIntegrationDir(specFile: string, integrationDir: string): boolean {
  const relative = path.relative(integrationDir, specFile)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

// A spec written next month that imports the guarded fixtures, or shells
// out to osascript/tmux inline the way backlog-batch-dispatch.spec.ts
// already does, must not be able to quietly opt out of isolation by living
// outside e2e/integration/. Comments are stripped first —
// plannotator-button.spec.ts's own header discusses "no real iTerm2/tmux
// side effect" in a `//` comment, which a raw text scan would flag on day
// one.
const GUARDED_FIXTURE_IMPORT_RE = /\b(itermSessions|orchestratorSessionLock)(\.js)?['"]/

// The danger is reaching real osascript/tmux, not process-spawning as such —
// e2e-isolation-guard.spec.ts (this milestone's own ui-project spec)
// legitimately spawns `npx playwright`/`npx tsx` child processes to test
// this very guard's CLI-level behaviour, and never touches osascript/tmux.
// So a bare `execa(`/`child_process` isn't itself a marker; it only counts
// alongside the actual binary name, which the alternation below already
// requires.
const RAW_INTEGRATION_MARKER_RE = /\bosascript\b|\btmux[ '"]/

export function scanForRealIntegrationLeaks(e2eRootDir: string): string[] {
  const integrationDir = path.join(e2eRootDir, 'integration')
  const violations: string[] = []
  for (const specFile of findSpecFiles(e2eRootDir)) {
    if (isUnderIntegrationDir(specFile, integrationDir)) continue
    const source = stripComments(fs.readFileSync(specFile, 'utf8'))
    if (GUARDED_FIXTURE_IMPORT_RE.test(source) || RAW_INTEGRATION_MARKER_RE.test(source)) {
      violations.push(specFile)
    }
  }
  return violations
}
