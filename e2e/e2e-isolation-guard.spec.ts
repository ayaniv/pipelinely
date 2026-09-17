import { test, expect } from '@playwright/test'
import { execa } from 'execa'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isCanonicalRepoPath } from '../src/derivePort.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const FIXTURE_TASKS_DIR = path.join(__dirname, 'fixtures', 'tasks')

// M0's two user-visible behaviours (src/e2eIsolation.ts, src/tasksDir.ts) are
// process-level, not page-level, so this spec asserts them by spawning real
// child processes rather than driving a page. It opens no iTerm2 window and
// touches no orchestrator pointer — real-integration in no sense — so it
// belongs in the local `ui` project and stays part of the fast loop.
test.describe('e2e isolation guard', () => {
  // `--list` loads every spec file (so a module-scope throw still surfaces)
  // but never starts the webServer, so this can't fail for the unrelated
  // reason of reuseExistingServer:false hitting an occupied port.
  //
  // Under the VM-era gate this passed no `env` at all, which was harmless
  // when the guard keyed off a file that never exists. A gate keyed off
  // environment variables would pass or fail depending on which shell
  // launched this test — run it from inside a consenting run.sh shell and
  // the child would inherit valid consent — so the consent env vars are
  // explicitly deleted from the child's env here.
  test('playwright test --project=integration refuses to load without consent', async () => {
    const envWithoutConsent: Record<string, string | undefined> = { ...process.env }
    delete envWithoutConsent.COCKPIT_E2E_CONSENT
    delete envWithoutConsent.COCKPIT_E2E_CONSENT_FILE
    const result = await execa('npx', ['playwright', 'test', '--project=integration', '--list'], {
      cwd: REPO_ROOT,
      env: envWithoutConsent,
      reject: false,
    })
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('no consent token')
    expect(result.stderr).toContain('npm run test:e2e:integration')
  })

  test('npx tsx src/server.ts refuses to boot in a worktree with no TASKS_DIR', async () => {
    // resolveTasksDir deliberately does NOT throw for the canonical checkout
    // (it gets the real default there, legitimately) — so this case only
    // proves anything from a worktree. Run from the canonical checkout, the
    // spawned server below would actually boot against the real
    // ~/Dev/pipelinely/tasks and open a real browser tab: skip loudly rather
    // than silently re-creating the exact stray-real-server incident this
    // milestone exists to prevent.
    test.skip(isCanonicalRepoPath(REPO_ROOT), 'this case only exercises the worktree failure path')

    const envWithoutTasksDir: Record<string, string | undefined> = { ...process.env }
    delete envWithoutTasksDir.TASKS_DIR
    const result = await execa('npx', ['tsx', 'src/server.ts'], {
      cwd: REPO_ROOT,
      env: envWithoutTasksDir,
      reject: false,
      timeout: 10_000,
    })
    expect(result.timedOut).toBe(false)
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('e2e/fixtures/tasks')
    expect(result.stderr).toContain('Dev/pipelinely/tasks')
  })

  // With no host given, app.listen(PORT) used to bind an IPv6-reachable
  // socket that did NOT conflict at the OS level with an unrelated stray
  // process bound to plain IPv4 0.0.0.0 on the same port — both silently
  // coexisted, and which one answered a request depended on whether the
  // client resolved 'localhost' to ::1 or 127.0.0.1 (QA found this: a plain
  // `python3 -m http.server` on the derived port let a real cockpit server
  // boot "successfully" alongside it, rather than the port conflict
  // playwright.config.ts's own webServer comment promises). Binding
  // '0.0.0.0' explicitly (see src/server.ts) means this must now be a real,
  // loud EADDRINUSE crash instead.
  test('src/server.ts refuses to boot when a stray process already holds the port', async () => {
    const strayServer = net.createServer()
    const strayPort = await new Promise<number>((resolve, reject) => {
      strayServer.once('error', reject)
      strayServer.listen(0, '0.0.0.0', () => {
        const address = strayServer.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })
    try {
      const result = await execa('npx', ['tsx', 'src/server.ts'], {
        cwd: REPO_ROOT,
        env: { ...process.env, TASKS_DIR: FIXTURE_TASKS_DIR, PORT: String(strayPort) },
        reject: false,
        timeout: 10_000,
      })
      expect(result.timedOut).toBe(false)
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toContain('EADDRINUSE')
    } finally {
      strayServer.close()
    }
  })

  // The failure path's counterpart: a guard whose suggested remedy is
  // untested is a guard that sends people down a dead end.
  test('the documented remedy — an explicit fixture TASKS_DIR — actually boots the server', async () => {
    const subprocess = execa('npx', ['tsx', 'src/server.ts'], {
      cwd: REPO_ROOT,
      env: { ...process.env, TASKS_DIR: FIXTURE_TASKS_DIR, PORT: '0' },
    })
    let output = ''
    subprocess.stdout?.on('data', (chunk) => (output += chunk.toString()))
    subprocess.stderr?.on('data', (chunk) => (output += chunk.toString()))
    try {
      await expect.poll(() => output, { timeout: 15_000 }).toContain('Pipelinely running at')
    } finally {
      subprocess.kill()
      await subprocess.catch(() => {})
    }
  })
})
