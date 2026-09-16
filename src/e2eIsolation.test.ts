import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CANONICAL_REPO_PATH } from './derivePort.js'
import {
  assertIsolatedEnvironment,
  scanForRealIntegrationLeaks,
  findWebServerIsolationViolations,
  IsolationProbe,
  WebServerIsolation,
} from './e2eIsolation.js'

const FIXTURE_TASKS_DIR = '/fake/e2e/fixtures/tasks'
const REAL_TASKS_DIR = '/fake/Dev/pipelinely/tasks'
const NONCE = 'fake-nonce'
const RUNNER_PID = 12345
const ISSUED_AT = 1_000_000

function fakeProbe(overrides: Partial<IsolationProbe> = {}): IsolationProbe {
  return {
    consentNonce: NONCE,
    consentTokenPath: '/fake/consent-token.json',
    tasksDir: FIXTURE_TASKS_DIR,
    fixtureTasksDir: FIXTURE_TASKS_DIR,
    realOrchestratorPointerPath: path.join(REAL_TASKS_DIR, 'ORCHESTRATOR_SESSION'),
    readTokenFile: () => JSON.stringify({ nonce: NONCE, issuedAt: ISSUED_AT, runnerPid: RUNNER_PID }),
    isProcessAlive: () => true,
    now: () => ISSUED_AT + 1000,
    ...overrides,
  }
}

// tech-design.md's 11 vitest cases: 2-10 are the failure paths required by
// the engineering constraints, 1 and 11 are the happy paths.
describe('assertIsolatedEnvironment', () => {
  it('case 1: fresh nonce, matching token, live pid, fixture TASKS_DIR — does not throw', () => {
    expect(() => assertIsolatedEnvironment(fakeProbe())).not.toThrow()
  })

  it('case 2: COCKPIT_E2E_CONSENT unset — throws, names the remedy', () => {
    const probe = fakeProbe({ consentNonce: undefined })
    expect(() => assertIsolatedEnvironment(probe)).toThrow(/npm run test:e2e:integration/)
  })

  it('case 3: env nonce set, token file missing — throws', () => {
    const probe = fakeProbe({ readTokenFile: () => undefined })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 4: token file present but unparseable — throws', () => {
    const probe = fakeProbe({ readTokenFile: () => 'not json' })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 5: token nonce does not match env nonce — throws', () => {
    const probe = fakeProbe({
      readTokenFile: () => JSON.stringify({ nonce: 'a-different-nonce', issuedAt: ISSUED_AT, runnerPid: RUNNER_PID }),
    })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 6: runnerPid not alive — throws', () => {
    const probe = fakeProbe({ isProcessAlive: () => false })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 7: issuedAt older than the 4h bound, pid alive — throws', () => {
    const fourHoursMs = 4 * 60 * 60 * 1000
    const probe = fakeProbe({ now: () => ISSUED_AT + fourHoursMs })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 8: TASKS_DIR unset — throws', () => {
    const probe = fakeProbe({ tasksDir: undefined })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 9: TASKS_DIR is the real tasks dir — throws, naming that directory', () => {
    const probe = fakeProbe({ tasksDir: REAL_TASKS_DIR })
    expect(() => assertIsolatedEnvironment(probe)).toThrow(new RegExp(REAL_TASKS_DIR.replace(/\//g, '\\/')))
  })

  it('case 10: TASKS_DIR is a third real directory, neither fixture nor real tasks dir — throws (the allowlist case a denylist would let through)', () => {
    const probe = fakeProbe({ tasksDir: '/fake/some/other/real/place' })
    expect(() => assertIsolatedEnvironment(probe)).toThrow()
  })

  it('case 11: isProcessAlive throws EPERM for a live process owned by another user — does not throw', () => {
    // Exercises the real default probe (no injected probe), so the EPERM
    // errno branch inside its isProcessAlive is what's actually under test —
    // an injected fake would only prove the fake's own contract.
    const tokenPath = path.join(os.tmpdir(), `e2e-isolation-test-token-${process.pid}.json`)
    const otherUsersPid = 4
    fs.writeFileSync(tokenPath, JSON.stringify({ nonce: NONCE, issuedAt: Date.now(), runnerPid: otherUsersPid }))
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      if (pid === otherUsersPid) {
        const err = new Error('EPERM') as NodeJS.ErrnoException
        err.code = 'EPERM'
        throw err
      }
      return true
    })
    const originalEnv = { ...process.env }
    try {
      process.env.COCKPIT_E2E_CONSENT = NONCE
      process.env.COCKPIT_E2E_CONSENT_FILE = tokenPath
      process.env.TASKS_DIR = path.join(__dirname, '..', 'e2e', 'fixtures', 'tasks')
      expect(() => assertIsolatedEnvironment()).not.toThrow()
    } finally {
      process.env = originalEnv
      killSpy.mockRestore()
      fs.rmSync(tokenPath, { force: true })
    }
  })
})

// Structural checks (tech-design.md M0 cases 7-9): these are what keep the
// guard load-bearing rather than conventional — a future spec cannot opt out
// by import or by inlining the AppleScript itself.
describe('scanForRealIntegrationLeaks', () => {
  it('finds no real-integration leaks outside e2e/integration/ in this repo', () => {
    const e2eRoot = path.join(__dirname, '..', 'e2e')
    expect(scanForRealIntegrationLeaks(e2eRoot)).toEqual([])
  })

  it('flags a synthetic spec outside integration/ that references osascript directly, even inside a comment-adjacent line', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-isolation-scan-'))
    try {
      fs.mkdirSync(path.join(tmpRoot, 'integration'), { recursive: true })
      const violatingSpec = path.join(tmpRoot, 'raw-shell.spec.ts')
      fs.writeFileSync(
        violatingSpec,
        `import { test } from '@playwright/test'\n` +
          `// safe comment mentioning osascript, must be stripped before matching\n` +
          `test('shells out directly', async () => {\n` +
          `  await execa('osascript', ['-e', 'tell application "iTerm2"'])\n` +
          `})\n`
      )
      const safeSpec = path.join(tmpRoot, 'integration', 'real.spec.ts')
      fs.writeFileSync(
        safeSpec,
        `import { test } from '@playwright/test'\n` +
          `import { openScratchSession } from '../fixtures/itermSessions.js'\n` +
          `test('real integration', async () => { await openScratchSession() })\n`
      )
      const violations = scanForRealIntegrationLeaks(tmpRoot)
      expect(violations).toEqual([violatingSpec])
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })

  it('flags a synthetic spec outside integration/ that imports the guarded fixtures', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-isolation-scan-'))
    try {
      const violatingSpec = path.join(tmpRoot, 'imports-fixture.spec.ts')
      fs.writeFileSync(
        violatingSpec,
        `import { test } from '@playwright/test'\n` +
          `import { openScratchSession } from './fixtures/itermSessions.js'\n` +
          `test('uses the guarded fixture', async () => { await openScratchSession() })\n`
      )
      expect(scanForRealIntegrationLeaks(tmpRoot)).toEqual([violatingSpec])
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})

describe('module-scope isolation guard placement', () => {
  it('itermSessions.ts calls assertIsolatedEnvironment at module scope', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'itermSessions.ts'), 'utf8')
    expect(source).toMatch(/^assertIsolatedEnvironment\(\)/m)
  })

  it('orchestratorSessionLock.ts calls assertIsolatedEnvironment at module scope', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'e2e', 'fixtures', 'orchestratorSessionLock.ts'), 'utf8')
    expect(source).toMatch(/^assertIsolatedEnvironment\(\)/m)
  })
})

// The guarantee orchestrator-session-self-heal.spec.ts's un-quarantine rests
// on. Both halves are one line each in playwright.config.ts, and their
// absence is exactly what let a stray, real-TASKS_DIR server be adopted on
// 2026-09-01 — so they get a test rather than a comment.
const FIXTURE_ROOT = path.join(__dirname, '..', 'e2e', 'fixtures')

// playwright.config.ts sits at the repo root, outside tsconfig's `rootDir`
// ("src"), so a static import fails the build with TS6059 — and widening
// rootDir to satisfy one test would change the shape of `dist/`. Loaded
// through a runtime-built URL instead. A dynamic import of a non-literal
// specifier is untyped, so the shape it is narrowed to has to be stated here
// rather than inferred; only the fields this assertion actually reads are
// declared.
async function loadPlaywrightWebServer(): Promise<WebServerIsolation> {
  const configUrl = pathToFileURL(path.join(__dirname, '..', 'playwright.config.ts')).href
  const config = (await import(/* @vite-ignore */ configUrl)) as {
    default: { webServer?: WebServerIsolation | WebServerIsolation[] }
  }
  const { webServer } = config.default
  if (!webServer || Array.isArray(webServer)) {
    throw new Error(
      `playwright.config.ts must define exactly one webServer for this contract to mean anything (got ${JSON.stringify(webServer)})`
    )
  }
  return webServer
}

function safeWebServer(overrides: Partial<WebServerIsolation> = {}): WebServerIsolation {
  return {
    reuseExistingServer: false,
    env: {
      TASKS_DIR: path.join(FIXTURE_ROOT, 'tasks'),
      REPOS_DIR: path.join(FIXTURE_ROOT, 'repos'),
      WORKTREES_DIR: path.join(FIXTURE_ROOT, 'worktrees'),
    },
    ...overrides,
  }
}

describe('findWebServerIsolationViolations', () => {
  it("the repo's own playwright.config.ts webServer is isolated — no violations", async () => {
    // Asserts the real, evaluated config object rather than scanning its
    // source text, so a value that merely *looks* right cannot pass.
    expect(findWebServerIsolationViolations(await loadPlaywrightWebServer(), FIXTURE_ROOT)).toEqual([])
  })

  it('reuseExistingServer: true — flags it by name', () => {
    const violations = findWebServerIsolationViolations(safeWebServer({ reuseExistingServer: true }), FIXTURE_ROOT)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/reuseExistingServer/)
  })

  it('reuseExistingServer absent — flags it too; the 2026-09-01 incident was the default, not an explicit true', () => {
    const violations = findWebServerIsolationViolations(safeWebServer({ reuseExistingServer: undefined }), FIXTURE_ROOT)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/reuseExistingServer/)
  })

  it('TASKS_DIR pointing at the real tasks dir — flags it and names the offending value', () => {
    const realTasksDir = path.join(CANONICAL_REPO_PATH, 'tasks')
    const webServer = safeWebServer({
      env: { ...safeWebServer().env, TASKS_DIR: realTasksDir },
    })
    const violations = findWebServerIsolationViolations(webServer, FIXTURE_ROOT)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/TASKS_DIR/)
    expect(violations[0]).toContain(realTasksDir)
  })

  it('REPOS_DIR pointing outside the fixture root — flags it', () => {
    const webServer = safeWebServer({
      env: { ...safeWebServer().env, REPOS_DIR: path.join(os.homedir(), 'Dev') },
    })
    const violations = findWebServerIsolationViolations(webServer, FIXTURE_ROOT)
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatch(/REPOS_DIR/)
  })

  it('no env at all — reports every pinned dir as missing rather than throwing', () => {
    const violations = findWebServerIsolationViolations({ reuseExistingServer: false }, FIXTURE_ROOT)
    expect(violations).toHaveLength(3)
    expect(violations.join('\n')).toMatch(/TASKS_DIR[\s\S]*REPOS_DIR[\s\S]*WORKTREES_DIR/)
  })
})
