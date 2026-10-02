import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// POST /open-pr/:slug must never open a PR belonging to another branch, and
// must say why it refused. gitOps is mocked so no real gh runs.
const { openPrInBrowserMock, readPrHeadBranchMock } = vi.hoisted(() => ({
  openPrInBrowserMock: vi.fn(),
  readPrHeadBranchMock: vi.fn(),
}))

vi.mock('./gitOps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gitOps.js')>()
  return {
    ...actual,
    findPrByBranch: vi.fn().mockResolvedValue(null),
    openPrInBrowser: openPrInBrowserMock,
    readPrHeadBranch: readPrHeadBranchMock,
  }
})

let handle: TestServerHandle
const withPrSlug = 'open-pr-with-pr'
const noPrSlug = 'open-pr-without-pr'

async function seedTask(tmpDir: string, slug: string, timeline: string) {
  const dir = path.join(tmpDir, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'STATUS'), 'waiting: PR open, ready for CR\n')
  await fs.writeFile(path.join(dir, 'TIMELINE'), timeline)
  await fs.writeFile(path.join(dir, 'TASK.md'), `# ${slug}\n\n## Workspace\n- Repo: fixture-repo\n- Branch: claude/${slug}\n`)
}

beforeAll(async () => {
  handle = await startTestServer({}, async (tmpDir) => {
    await seedTask(tmpDir, withPrSlug, '2026-09-23T15:20:57Z dev PR #117 opened: my change\n')
    await seedTask(tmpDir, noPrSlug, '2026-09-23T15:20:57Z dev rebased on master\n')
  })
})

afterAll(async () => {
  await stopTestServer(handle)
})

beforeEach(() => {
  openPrInBrowserMock.mockReset()
  readPrHeadBranchMock.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

const openPr = (slug: string) => fetch(`http://127.0.0.1:${handle.boundPort}/open-pr/${slug}`, { method: 'POST' })

describe('POST /open-pr/:slug', () => {
  it('opens the PR when its head branch is the task\'s own branch', async () => {
    readPrHeadBranchMock.mockResolvedValueOnce({ ok: true, headRefName: `claude/${withPrSlug}`, isCrossRepository: false })
    openPrInBrowserMock.mockResolvedValueOnce({ ok: true })
    expect((await openPr(withPrSlug)).status).toBe(200)
    expect(openPrInBrowserMock).toHaveBeenCalledWith(expect.any(String), '117')
  })

  it('refuses with 409 and a clear message, opening nothing, when the PR belongs to another branch', async () => {
    readPrHeadBranchMock.mockResolvedValueOnce({ ok: true, headRefName: 'claude/some-other-task', isCrossRepository: false })
    const res = await openPr(withPrSlug)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toContain('PR #117')
    expect(body.error).toContain('claude/some-other-task')
    expect(openPrInBrowserMock).not.toHaveBeenCalled()
  })

  it('returns 503 with the reason, opening nothing, when the head branch cannot be read', async () => {
    readPrHeadBranchMock.mockResolvedValueOnce({ ok: false, error: 'gh: rate limited' })
    const res = await openPr(withPrSlug)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toContain('rate limited')
    expect(openPrInBrowserMock).not.toHaveBeenCalled()
  })

  it('returns 404 with a clear message when no PR resolves for the task', async () => {
    const res = await openPr(noPrSlug)
    expect(res.status).toBe(404)
    expect((await res.json()).error).toContain('No PR')
    expect(openPrInBrowserMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an unknown task', async () => {
    expect((await openPr('does-not-exist')).status).toBe(404)
  })
})
