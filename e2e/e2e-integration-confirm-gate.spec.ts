import { test, expect } from '@playwright/test'
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANONICAL_REPO_PATH } from '../src/derivePort.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const RUN_SCRIPT = path.join('scripts', 'e2e-integration', 'run.sh')
const VERIFY_CONSENT_SCRIPT = path.join('scripts', 'e2e-integration', 'verify-consent.ts')
const INTEGRATION_DIR = path.join(__dirname, 'integration')
const FIXTURE_TASKS_DIR = path.join(__dirname, 'fixtures', 'tasks')

// The one directory a real-integration run must never be aimed at, however
// enthusiastically a human confirmed it — see tech-design's check 6.
const REAL_TASKS_DIR = path.join(CANONICAL_REPO_PATH, 'tasks')

const REMEDY = 'npm run test:e2e:integration'
const CONSENT_ACCEPTED_MARKER = 'CONSENT_ACCEPTED'
// run.sh prints this once it has minted a token, so a test can find the file
// and assert the trap cleaned it up.
const TOKEN_PATH_RE = /CONSENT_TOKEN=(\S+)/
const CONSENT_TOKEN_PREFIX = 'cockpit-e2e-consent-'
// Deliberately NOT sharing CONSENT_TOKEN_PREFIX: consentTokensInTmp() scans
// the same directory, and a driver file matching that prefix would read as a
// leaked consent token.
const PTY_DRIVER_PREFIX = 'cockpit-e2e-pty-drive-'
// run.sh's last output before `read` — the gate's contract, not incidental
// copy, so it is what the pty driver synchronises on.
const PROMPT_MARKER = '\\[y/N\\]'
// Distinct from any exit status run.sh itself produces, so a hung prompt is
// never mistaken for a refusal.
const PTY_TIMEOUT_EXIT_CODE = 99
let ptyDriverSeq = 0
const ptyDriverFiles: string[] = []

// These assertions match on process stderr/stdout, not on rendered copy —
// the repo's "never select by text content" rule is about DOM queries, and
// there is no DOM here. The strings asserted on ARE the behaviour under
// test: an isolation guard whose remedy text is wrong sends the developer
// down a dead end, which is the failure mode e2e-isolation-guard.spec.ts's
// own comment already calls out.

// Every invocation in this file passes --dry-run, with no opt-out: the flag
// makes run.sh mint consent exactly as a real run does and then execute
// verify-consent.ts instead of Playwright. That is what lets the happy path
// be tested at all — the standing rule is that no real-integration run
// happens without asking the developer first, every single time, and this
// spec lives in the local-safe `ui` project precisely because it opens no
// window and types no keystroke.
// `expect` allocates the pty itself, so run.sh's `[ -t 0 ] && [ -t 1 ]` check
// is genuinely satisfied rather than stubbed — testing the TTY gate against a
// faked TTY would prove nothing about the gate.
//
// `script -q /dev/null` was the obvious choice and does not work, in two ways
// that both had to be measured rather than reasoned about: it calls
// tcgetattr() on its own stdin and dies with "Operation not supported on
// socket" when Node hands it a piped stdin, and even given a stdin it accepts
// it closes the pty before the child reaches `read`, so the answer arrives as
// empty. `expect` waits for the prompt to appear before answering, which is a
// real synchronisation point rather than a hope about scheduling.
//
// KEY is a single keystroke ('y', 'n', or '' for a bare Enter); the driver
// adds the carriage return.
function runUnderPty(key: string) {
  const driverPath = path.join(os.tmpdir(), `${PTY_DRIVER_PREFIX}${process.pid}-${ptyDriverSeq++}.exp`)
  fs.writeFileSync(
    driverPath,
    [
      'set timeout 120',
      `spawn bash ${RUN_SCRIPT} --dry-run`,
      'expect {',
      `  "${PROMPT_MARKER}" {}`,
      // Refusing before the prompt is a legitimate outcome for some cases —
      // propagate run.sh's status instead of hanging until the timeout.
      '  eof { catch wait spawnResult; exit [lindex $spawnResult 3] }',
      `  timeout { exit ${PTY_TIMEOUT_EXIT_CODE} }`,
      '}',
      `send "${key}\\r"`,
      'expect eof',
      'catch wait spawnResult',
      'exit [lindex $spawnResult 3]',
    ].join('\n')
  )
  ptyDriverFiles.push(driverPath)
  return execa('expect', ['-f', driverPath], {
    cwd: REPO_ROOT,
    reject: false,
    timeout: 180_000,
    all: true,
  })
}

function consentTokensInTmp(): string[] {
  return fs
    .readdirSync(os.tmpdir())
    .filter((entry) => entry.startsWith(CONSENT_TOKEN_PREFIX))
    .sort()
}

function integrationSpecStems(): string[] {
  return fs
    .readdirSync(INTEGRATION_DIR)
    .filter((entry) => entry.endsWith('.spec.ts'))
    .map((entry) => entry.replace(/\.spec\.ts$/, ''))
}

function runVerifyConsent(env: Record<string, string | undefined>) {
  return execa('npx', ['tsx', VERIFY_CONSENT_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    reject: false,
    timeout: 60_000,
  })
}

function writeConsentToken(token: { nonce: string; issuedAt: number; runnerPid: number }): string {
  const tokenPath = path.join(os.tmpdir(), `${CONSENT_TOKEN_PREFIX}spec-${process.pid}.json`)
  fs.writeFileSync(tokenPath, JSON.stringify(token))
  return tokenPath
}

test.describe('real-integration confirmation gate', () => {
  test.describe.configure({ mode: 'serial' })

  // Serial, and each case cleans up after itself: consentTokensInTmp() is a
  // directory-wide observation, so two of these running concurrently would
  // see each other's tokens.
  const strayTokens: string[] = []
  test.afterEach(() => {
    for (const tokenPath of strayTokens.splice(0)) {
      fs.rmSync(tokenPath, { force: true })
    }
    for (const driverPath of ptyDriverFiles.splice(0)) {
      fs.rmSync(driverPath, { force: true })
    }
  })

  test('refuses a non-interactive caller, which cannot be informed and so cannot consent', async () => {
    const tokensBefore = consentTokensInTmp()

    const result = await execa('bash', [RUN_SCRIPT, '--dry-run'], {
      cwd: REPO_ROOT,
      input: 'y\n',
      reject: false,
      timeout: 60_000,
      all: true,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.all).toContain('interactive terminal')
    // A piped `y` must not reach the prompt at all — the point is that a CI
    // job or a nested agent can never satisfy this gate by writing to stdin.
    expect(result.all).not.toContain(CONSENT_ACCEPTED_MARKER)
    expect(consentTokensInTmp()).toEqual(tokensBefore)
  })

  test('answering n aborts and mints no consent token', async () => {
    const tokensBefore = consentTokensInTmp()

    const result = await runUnderPty('n')

    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBe(PTY_TIMEOUT_EXIT_CODE)
    expect(result.all).toContain('aborted')
    expect(result.all).not.toContain(CONSENT_ACCEPTED_MARKER)
    expect(consentTokensInTmp()).toEqual(tokensBefore)
  })

  // The developer chose a plain y/N over typing a phrase, so this is the
  // case that carries the weight the phrase would have: a reflexive Enter on
  // a half-read warning must not start a desktop takeover.
  test('bare Enter is not consent — empty input defaults to No', async () => {
    const tokensBefore = consentTokensInTmp()

    const result = await runUnderPty('')

    expect(result.exitCode).not.toBe(0)
    expect(result.exitCode).not.toBe(PTY_TIMEOUT_EXIT_CODE)
    expect(result.all).toContain('aborted')
    expect(result.all).not.toContain(CONSENT_ACCEPTED_MARKER)
    expect(consentTokensInTmp()).toEqual(tokensBefore)
  })

  test('answering y mints a token the guard accepts, and the trap removes it afterwards', async () => {
    const result = await runUnderPty('y')

    expect(result.exitCode).toBe(0)
    expect(result.all).toContain(CONSENT_ACCEPTED_MARKER)

    const tokenPathMatch = result.all?.match(TOKEN_PATH_RE)
    expect(tokenPathMatch, 'run.sh must print CONSENT_TOKEN=<path> once it mints one').toBeTruthy()
    const tokenPath = tokenPathMatch![1]
    if (fs.existsSync(tokenPath)) strayTokens.push(tokenPath)

    // Consent is scoped to the shell that granted it: once run.sh exits, the
    // token is gone, so tomorrow morning there is nothing left to inherit.
    expect(fs.existsSync(tokenPath)).toBe(false)
  })

  // The informed half of informed consent. Generated from the directory, not
  // a maintained literal, so a spec added next month cannot run under a
  // warning that fails to mention it.
  test('the warning names every spec file under e2e/integration/', async () => {
    const result = await runUnderPty('n')

    const stems = integrationSpecStems()
    expect(stems.length).toBeGreaterThan(0)
    for (const stem of stems) {
      expect(result.all, `the confirmation prompt must name ${stem}`).toContain(stem)
    }
  })

  test('a token whose runner shell has exited is refused — consent cannot outlive the run it was given for', async () => {
    // A pid that was real and is now definitively not: the exact shape of
    // last night's leftover token.
    const shortLived = execa('true')
    const deadPid = shortLived.pid!
    await shortLived

    const nonce = 'dead-runner-nonce'
    const tokenPath = writeConsentToken({ nonce, issuedAt: Date.now(), runnerPid: deadPid })
    strayTokens.push(tokenPath)

    const result = await runVerifyConsent({
      COCKPIT_E2E_CONSENT: nonce,
      COCKPIT_E2E_CONSENT_FILE: tokenPath,
      TASKS_DIR: FIXTURE_TASKS_DIR,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(REMEDY)
  })

  test('valid consent still does not permit a run aimed at the real tasks dir', async () => {
    const nonce = 'live-runner-nonce'
    // process.pid is alive by definition — this isolates the TASKS_DIR check
    // from the liveness check, so a failure here can only mean check 6.
    const tokenPath = writeConsentToken({ nonce, issuedAt: Date.now(), runnerPid: process.pid })
    strayTokens.push(tokenPath)

    const result = await runVerifyConsent({
      COCKPIT_E2E_CONSENT: nonce,
      COCKPIT_E2E_CONSENT_FILE: tokenPath,
      TASKS_DIR: REAL_TASKS_DIR,
    })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain(REAL_TASKS_DIR)
  })
})
