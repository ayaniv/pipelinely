import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Regression coverage for a CR finding on POST /merge-pr/:slug's catch
// block: it used to call `await refreshTasks()` unguarded, but that's the
// same call whose own failure (in the 'merged' success branch) is what
// lands in this catch block in the first place — a second failure there
// used to throw past `res.status(500)` entirely, leaving the client with
// no response. mergeTask itself is mocked to a canned 'merged' outcome so
// this suite exercises only the route's own error handling, not the merge
// gate/gh logic already covered elsewhere.
const { mergeTaskMock } = vi.hoisted(() => ({ mergeTaskMock: vi.fn() }))

vi.mock('./taskCompletion.js', () => ({
  markTaskDone: vi.fn(),
  mergeTask: mergeTaskMock,
}))

vi.mock('./taskParser.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./taskParser.js')>()
  return { ...actual, parseAllTasks: vi.fn(actual.parseAllTasks) }
})

let handle: TestServerHandle
const slug = 'merge-pr-route-test'

beforeAll(async () => {
  handle = await startTestServer({}, async (tmpDir) => {
    const dir = path.join(tmpDir, slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'waiting: QA passed, ready to merge\n')
    await fs.writeFile(
      path.join(dir, 'TASK.md'),
      `# ${slug}\n\n## Workspace\n- Repo: fixture-repo\n- Branch: claude/${slug}\n`,
    )
  })
})

afterAll(async () => {
  await stopTestServer(handle)
})

it('still responds 500 (not a hung request) when refreshTasks fails again inside the catch block', async () => {
  mergeTaskMock.mockResolvedValueOnce({ outcome: 'merged', prNumber: '1', cleanupError: null })

  const { parseAllTasks } = await import('./taskParser.js')
  // Startup's own refreshTasks() already ran with the real implementation
  // (populating currentTasks with the seeded task above) before this
  // override takes effect — from here on, every refreshTasks() call fails,
  // reproducing both the route's own success-path call throwing AND the
  // catch block's retry of it failing too.
  vi.mocked(parseAllTasks).mockRejectedValue(new Error('fs exploded'))
  const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

  const res = await fetch(`http://127.0.0.1:${handle.boundPort}/merge-pr/${slug}`, { method: 'POST' })

  expect(res.status).toBe(500)
  const body = await res.json()
  expect(body.error).toContain('fs exploded')
  // Both failures are logged, not just the first.
  expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Failed to merge PR'))).toBe(true)
  expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Failed to refresh tasks after a failed merge'))).toBe(true)

  vi.mocked(parseAllTasks).mockReset()
  logSpy.mockRestore()
})
