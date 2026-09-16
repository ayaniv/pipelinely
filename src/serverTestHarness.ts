import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'
import type { Server } from 'node:http'

export interface TestServerHandle {
  server: Server
  tmpDir: string
  boundPort: number
  logSpy: ReturnType<typeof vi.spyOn>
}

// Shared bootstrap for tests that need a real, listening instance of
// server.ts's main() against a throwaway TASKS_DIR/PORT=0 pair, with its
// startup log muted. Centralized so every caller gets the same cleanup
// guarantees (see stopTestServer) instead of each test file carrying its
// own copy that can drift — e.g. one copy remembering to delete TASKS_DIR
// and another not. `seed`, when given, runs against the fresh tmpDir after
// mkdtemp and before server.js is imported/main() runs — main()'s own
// startup refreshTasks() call needs whatever task dirs a caller wants
// currentTasks populated with to already be on disk by the time it runs.
export async function startTestServer(
  extraEnv: Record<string, string> = {},
  seed?: (tmpDir: string) => Promise<void>,
): Promise<TestServerHandle> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-server-test-'))
  if (seed) await seed(tmpDir)
  process.env.TASKS_DIR = tmpDir
  process.env.PORT = '0'
  for (const [key, value] of Object.entries(extraEnv)) process.env[key] = value

  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

  const { main } = await import('./server.js')
  const server = await main()

  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('expected a network address')

  return { server, tmpDir, boundPort: address.port, logSpy }
}

// Closes the server before removing its tmpDir/env vars, in a `finally` so
// a rejected `server.close()` can't skip cleanup and leak the tmpDir or a
// stale env var into later tests.
export async function stopTestServer(handle: TestServerHandle, extraEnvKeys: string[] = []): Promise<void> {
  try {
    await new Promise<void>((resolve, reject) => {
      handle.server.close((err) => (err ? reject(err) : resolve()))
    })
  } finally {
    vi.restoreAllMocks()
    await fs.rm(handle.tmpDir, { recursive: true, force: true })
    delete process.env.PORT
    delete process.env.TASKS_DIR
    for (const key of extraEnvKeys) delete process.env[key]
  }
}
