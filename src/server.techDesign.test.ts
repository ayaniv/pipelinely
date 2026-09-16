import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, stopTestServer, type TestServerHandle } from './serverTestHarness.js'

// Covers GET /tech-design/:slug's summaryHtml/testGroups (fed by
// parseSummarySection/stripSummarySection in taskParser.ts and the new
// readSpecTitles helper in server.ts) and GET /qa-spec/:slug's continued
// behavior after readSpecTitles absorbed its own read loop. See
// tech-design-plan-summary-milestone-tests.md.
//
// Fixtures are written to TASKS_DIR/WORKTREES_DIR before main() starts (see
// startTestServer's populate hook) so they're already there for main()'s own
// initial refreshTasks() — currentTasks is never populated by the chokidar
// watcher in this suite, only by that one startup call.

let handle: TestServerHandle
let worktreesDir: string

async function writeTask(
  tasksDir: string,
  slug: string,
  techDesign: string | null,
): Promise<void> {
  const dir = path.join(tasksDir, slug)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'STATUS'), 'working\n')
  await fs.writeFile(
    path.join(dir, 'TASK.md'),
    `# ${slug}\n\n## Workspace\n- Repo: fixture-repo\n- Branch: fixture-branch\n`,
  )
  if (techDesign !== null) await fs.writeFile(path.join(dir, 'tech-design.md'), techDesign)
}

async function writeWorktreeSpec(worktreeSlug: string, relPath: string, titles: string[]): Promise<void> {
  const filePath = path.join(worktreesDir, worktreeSlug, relPath)
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, titles.map((t) => `test('${t}', async () => {})`).join('\n') + '\n')
}

beforeAll(async () => {
  worktreesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-techdesign-worktrees-'))

  // flat-with-spec: one group, worktree present.
  await writeWorktreeSpec('flat-with-spec', 'e2e/flat.spec.ts', ['flat case one', 'flat case two'])

  // plan-parent + its own worktree, holding M1's and M3's files (M0's own
  // copy exists too, to prove the dispatched child's copy wins over it).
  await writeWorktreeSpec('plan-parent', 'e2e/m0.spec.ts', ['m0 parent title'])
  await writeWorktreeSpec('plan-parent', 'e2e/m1.spec.ts', ['m1 parent title'])
  await fs.mkdir(path.join(worktreesDir, 'plan-parent', 'e2e', 'm3-dir.spec.ts'), { recursive: true })

  // plan-parent-m0: dispatched child, its own copy of M0's spec (different
  // title than the parent's, so the test can tell which one won).
  await writeWorktreeSpec('plan-parent-m0', 'e2e/m0.spec.ts', ['m0 child title'])

  // plan-parent-m1: dispatched child with a worktree, but no e2e/m1.spec.ts
  // of its own — a freshly-cut child branch that hasn't merged the parent's
  // planning commit yet.
  await fs.mkdir(path.join(worktreesDir, 'plan-parent-m1'), { recursive: true })

  handle = await startTestServer({ WORKTREES_DIR: worktreesDir }, async (tasksDir) => {
    await writeTask(
      tasksDir,
      'flat-with-spec',
      '# Flat with spec\n\n**QA Spec:** `e2e/flat.spec.ts`\n\n## Summary\nA flat task with one declared spec file.\n',
    )
    await writeTask(
      tasksDir,
      'flat-no-worktree',
      '# Flat no worktree\n\n**QA Spec:** `e2e/nowhere.spec.ts`\n\n## Summary\nA flat task with no worktree on disk.\n',
    )
    await writeTask(
      tasksDir,
      'flat-no-summary',
      '# Flat no summary\n\n## Approach\nThis plan predates the Summary requirement.\n',
    )
    await writeTask(
      tasksDir,
      'plan-parent',
      [
        '# Plan parent',
        '',
        '## Summary',
        'A milestone parent exercising every readSpecTitles path.',
        '',
        '## Milestones',
        '- M0: Child wins — needs: none — est: 1h — spec: e2e/m0.spec.ts',
        '- M1: Parent fallback — needs: none — est: 1h — spec: e2e/m1.spec.ts',
        '- M2: Missing everywhere — needs: none — est: 1h — spec: e2e/m2-missing.spec.ts',
        '- M3: Directory not file — needs: none — est: 1h — spec: e2e/m3-dir.spec.ts',
        '',
      ].join('\n'),
    )
    await writeTask(tasksDir, 'plan-parent-m0', null)
    await writeTask(tasksDir, 'plan-parent-m1', null)
  })
})

afterAll(async () => {
  await stopTestServer(handle, ['WORKTREES_DIR'])
  await fs.rm(worktreesDir, { recursive: true, force: true })
})

describe('GET /tech-design/:slug', () => {
  it('flat task: one group, roots from its own worktree', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/flat-with-spec`)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.summaryHtml).toContain('<p>')
    expect(body.testGroups).toEqual([
      {
        milestoneId: null,
        name: null,
        specFile: 'e2e/flat.spec.ts',
        titles: ['flat case one', 'flat case two'],
        missingSpecFiles: [],
        hasWorktree: true,
      },
    ])
  })

  it('parent: prefers the dispatched child\'s worktree over the parent\'s when both have the file', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/plan-parent`)
    const body = await res.json()

    const m0 = body.testGroups.find((g: { milestoneId: string }) => g.milestoneId === 'M0')
    expect(m0.titles).toEqual(['m0 child title'])
    expect(m0.missingSpecFiles).toEqual([])
  })

  it('parent: falls back to the parent\'s worktree when the dispatched child\'s copy is missing', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/plan-parent`)
    const body = await res.json()

    const m1 = body.testGroups.find((g: { milestoneId: string }) => g.milestoneId === 'M1')
    expect(m1.titles).toEqual(['m1 parent title'])
    expect(m1.missingSpecFiles).toEqual([])
  })

  it('a spec file missing from every candidate root is listed missing, not logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/plan-parent`)
      const body = await res.json()

      const m2 = body.testGroups.find((g: { milestoneId: string }) => g.milestoneId === 'M2')
      expect(m2.titles).toEqual([])
      expect(m2.missingSpecFiles).toEqual(['e2e/m2-missing.spec.ts'])
      expect(m2.hasWorktree).toBe(true)
      // M3's own directory-not-a-file case (covered separately below) does
      // legitimately log on this same request — only M2's own ENOENT must
      // stay silent.
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining('m2-missing.spec.ts'), expect.anything())
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('a declared spec path that is a directory is listed missing and logged', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/plan-parent`)
      const body = await res.json()

      const m3 = body.testGroups.find((g: { milestoneId: string }) => g.milestoneId === 'M3')
      expect(m3.titles).toEqual([])
      expect(m3.missingSpecFiles).toEqual(['e2e/m3-dir.spec.ts'])
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('plan-parent'),
        expect.anything(),
      )
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('no worktree on disk at all: the declared path is missing with hasWorktree false', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/flat-no-worktree`)
    const body = await res.json()

    expect(body.testGroups).toEqual([
      {
        milestoneId: null,
        name: null,
        specFile: 'e2e/nowhere.spec.ts',
        titles: [],
        missingSpecFiles: ['e2e/nowhere.spec.ts'],
        hasWorktree: false,
      },
    ])
  })

  it('no Summary section: summaryHtml is null but the document still renders', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/tech-design/flat-no-summary`)
    const body = await res.json()

    expect(body.summaryHtml).toBeNull()
    expect(body.testGroups).toEqual([])
    expect(body.html).toContain('<h2>')
  })
})

describe('GET /qa-spec/:slug', () => {
  it('still returns { titles } after the readSpecTitles extraction', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.boundPort}/qa-spec/flat-with-spec`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ titles: ['flat case one', 'flat case two'] })
  })
})
