import { execa, type ResultPromise } from 'execa'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..', '..')
const TASKS_DIR = path.join(__dirname, 'tasks')
const REPOS_DIR = path.join(__dirname, 'repos')
const WORKTREES_DIR = path.join(__dirname, 'worktrees')
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

// A second, dedicated instance of the SAME src/server.ts, pointed at the
// exact same fixture TASKS_DIR every other e2e spec already reads/writes
// (see playwright.config.ts), but started with COCKPIT_DISPATCH_ENABLED=1 —
// the one thing the shared webServer must never set (see that config's own
// comment: canonical-dispatch-gate's whole point is that an e2e-launched
// server identifies as non-canonical by default). A handful of specs need
// more than that: real, deep osascript/tmux integration behavior (reattach,
// adopt-instead-of-reattach, stray-shell detection) that only actually runs
// once past the canonical gate, and that no mock can stand in for — see
// orchestrator-session-self-heal.spec.ts's own file header. Others just need
// canonical-dispatch-gate's two proactively-disabled CTAs (backlog "Run"/
// "Run selected", wave "Run wave") to render enabled at all. Every such spec
// starts this once for its own file or test (test.beforeAll or inline) and
// points requests at its baseURL instead of the shared server's.
//
// PORT=0 rather than a cwd-derived literal: multiple callers across
// different spec files can run concurrently under Playwright's
// `fullyParallel`, and a deterministic per-cwd port (see derivePort.ts)
// would have every one of them fight over the exact same port. The OS picks
// a free ephemeral port per process instead, and this reads the bound port
// back off the child's own startup log line — the same one a human watching
// `npm run dev`'s output would read.
//
// Keyed by baseUrl (not a single module-level handle) so unrelated callers'
// start/stop pairs can never cross-kill each other's process.
const processesByBaseUrl = new Map<string, ResultPromise>()

export async function startCanonicalServer(): Promise<string> {
  const proc = execa(TSX_BIN, [path.join(REPO_ROOT, 'src', 'server.ts')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      COCKPIT_DISPATCH_ENABLED: '1',
      TASKS_DIR,
      REPOS_DIR,
      WORKTREES_DIR,
      PORT: '0',
    },
    reject: false, // a kill() on teardown must not surface as an unhandled rejection
  })
  const baseUrl = await waitForBoundUrl(proc)
  processesByBaseUrl.set(baseUrl, proc)
  return baseUrl
}

export async function stopCanonicalServer(baseUrl: string): Promise<void> {
  const proc = processesByBaseUrl.get(baseUrl)
  if (!proc) return
  processesByBaseUrl.delete(baseUrl)
  proc.kill()
  await proc
}

// Reads the child's own "Pipelinely running at http://localhost:<port>"
// startup line off stdout — the actual OS-assigned port from PORT=0, not a
// guess. Falls back to polling GET /api/tasks against candidate output only
// once the log line itself has appeared, so this never races the server's
// own listen() callback.
async function waitForBoundUrl(proc: ResultPromise, timeoutMs = 20_000): Promise<string> {
  let stdout = ''
  let stderr = ''
  const onStdout = (chunk: Buffer) => { stdout += chunk.toString() }
  const onStderr = (chunk: Buffer) => { stderr += chunk.toString() }
  proc.stdout?.on('data', onStdout)
  proc.stderr?.on('data', onStderr)

  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const match = stdout.match(/Pipelinely running at (http:\/\/localhost:\d+)/)
      if (match) {
        const baseUrl = match[1]
        const res = await fetch(`${baseUrl}/api/tasks`).catch(() => null)
        if (res?.ok) return baseUrl
      }
      if (proc.exitCode !== null && proc.exitCode !== undefined) {
        throw new Error(`canonical test server exited early (code ${proc.exitCode}):\n${stderr || stdout}`)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error(`canonical test server never printed its bound port within ${timeoutMs}ms:\n${stderr || stdout}`)
  } finally {
    proc.stdout?.off('data', onStdout)
    proc.stderr?.off('data', onStderr)
  }
}
