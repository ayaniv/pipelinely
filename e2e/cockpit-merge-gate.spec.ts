import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { FIXTURE_REPOS_DIR, FIXTURE_TASKS_DIR, FIXTURE_WORKTREES_DIR } from './fixtures/fixtureDirs.js'
import { clearMergeCalls, clearDeleteRefCalls, fakeGhEnv, readDeleteRefCalls, readMergeCalls } from './fixtures/fakeGh.js'
import { withRestoredFixtureFiles } from './fixtures/restoreFixtureFiles.js'
import { openTask } from './fixtures/taskDetail.js'

// The merge preflight gate, end to end, through both human triggers that
// share it (see tech-design-cockpit-merge-skill.md, Design §3 "mergeTask"):
// the Merge tab's button (POST /merge-pr/:slug) and the /cockpit-merge CLI
// the skill runs. `gh` resolves to e2e/fixtures/bin/gh for the webServer and
// for every process spawned here, so each fixture PR's state is canned
// (e2e/fixtures/gh/prs/<N>.json) and a merge is only ever *recorded*
// (readMergeCalls), never sent to GitHub.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')

interface MergeBlocker { kind: string; name?: string }

// Every case may (or, if the gate is broken, might wrongly) write
// STATUS/TIMELINE and record a merge/remote-delete — restore/clear all of it
// either way so a failing run can't poison the next one.
async function withMergeFixture(slug: string, prNumber: number, fn: () => Promise<void>) {
  const branch = `claude/${slug}`
  await clearMergeCalls(prNumber)
  await clearDeleteRefCalls(branch)
  try {
    await withRestoredFixtureFiles(slug, ['STATUS', 'TIMELINE'], fn)
  } finally {
    await clearMergeCalls(prNumber)
    await clearDeleteRefCalls(branch)
  }
}

async function taskStatus(page: Page, slug: string): Promise<string> {
  const { tasks } = await (await page.request.get('/api/tasks')).json()
  return tasks.find((t: { slug: string }) => t.slug === slug).status
}

async function readTimeline(slug: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_TASKS_DIR, slug, 'TIMELINE'), 'utf-8')
}

async function openMergeTab(page: Page, slug: string) {
  await openTask(page, slug)
  await page.getByTestId('stage-chain-merge').click()
  const btn = page.getByTestId('task-detail').getByTestId('merge-pr-btn')
  await expect(btn).toBeEnabled()
  return btn
}

// Accepts the Merge confirm and returns the POST's response, plus the
// confirm's own message for the cases that assert on it.
async function clickMergeAndConfirm(page: Page, slug: string, btn: ReturnType<Page['getByTestId']>) {
  let dialogMessage = ''
  page.once('dialog', (d) => { dialogMessage = d.message(); d.accept() })
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes(`/merge-pr/${slug}`) && res.request().method() === 'POST'),
    btn.click(),
  ])
  return { response, dialogMessage }
}

// The persistent failure banner (Design §7) replaces the old 6s btn-err
// flash — every gate refusal and the merge-rejected case assert against it,
// not the button's own class/text.
function mergeBanner(page: Page) {
  return page.getByTestId('task-detail').getByTestId('merge-banner')
}

async function bannerLines(page: Page): Promise<string[]> {
  return mergeBanner(page).getByTestId('merge-banner-line').allInnerTexts()
}

test.describe('Merge button — the preflight gate refuses', () => {
  test('a failing check blocks the merge and names exactly which checks failed', async ({ page }) => {
    await withMergeFixture('merge-gate-failing-check', 901, async () => {
      const btn = await openMergeTab(page, 'merge-gate-failing-check')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-failing-check', btn)

      expect(response.status()).toBe(409)
      const body = await response.json()
      const failed = (body.blockers as MergeBlocker[]).filter((b) => b.kind === 'check-failed').map((b) => b.name)
      expect(failed.sort()).toEqual(['ci/coverage', 'unit-tests'])
      await expect(mergeBanner(page)).toBeVisible()
      await expect(mergeBanner(page)).toHaveAttribute('data-tone', 'error')
      expect((await bannerLines(page)).join('\n')).toContain('unit-tests')

      expect(await readMergeCalls(901)).toBeNull()
      expect(await readDeleteRefCalls('claude/merge-gate-failing-check')).toBeNull()
      expect(await taskStatus(page, 'merge-gate-failing-check')).not.toBe('done')
    })
  })

  test('failure banner survives an SSE-style re-render and is not timer-cleared', async ({ page }) => {
    await withMergeFixture('merge-gate-failing-check', 901, async () => {
      const btn = await openMergeTab(page, 'merge-gate-failing-check')
      await clickMergeAndConfirm(page, 'merge-gate-failing-check', btn)
      await expect(mergeBanner(page)).toBeVisible()
      const linesBefore = await bannerLines(page)

      // Same technique as e2e/focus-button-rerender-race.spec.ts: forces the
      // exact re-render an SSE broadcast triggers while this view is open —
      // the banner is client state (mergeBannerBySlug) a re-render reads,
      // not DOM a re-render wipes.
      await page.evaluate(() => { renderDashboard(currentTasks) })

      await page.clock.install()
      await page.clock.fastForward(10_000)

      await expect(mergeBanner(page)).toBeVisible()
      expect(await bannerLines(page)).toEqual(linesBefore)
    })
  })

  test('a new attempt clears the old banner while in flight', async ({ page }) => {
    await withMergeFixture('merge-gate-failing-check', 901, async () => {
      const btn = await openMergeTab(page, 'merge-gate-failing-check')
      await clickMergeAndConfirm(page, 'merge-gate-failing-check', btn)
      await expect(mergeBanner(page)).toBeVisible()

      // Held open until released below — the second click's own request
      // is genuinely in flight while we check the stale banner is gone.
      let releaseHold = () => {}
      const held = new Promise<void>((resolve) => { releaseHold = resolve })
      await page.route('**/merge-pr/merge-gate-failing-check', async (route) => {
        await held
        await route.continue()
      })

      page.once('dialog', (d) => d.accept())
      await btn.click()
      await expect(mergeBanner(page)).toBeHidden()

      releaseHold()
      await page.waitForResponse((res) => res.url().includes('/merge-pr/merge-gate-failing-check') && res.request().method() === 'POST')
      await expect(mergeBanner(page)).toBeVisible()

      await page.unroute('**/merge-pr/merge-gate-failing-check')
    })
  })

  test('merge conflicts block the merge', async ({ page }) => {
    await withMergeFixture('merge-gate-conflicts', 902, async () => {
      const btn = await openMergeTab(page, 'merge-gate-conflicts')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-conflicts', btn)

      expect(response.status()).toBe(409)
      const body = await response.json()
      expect((body.blockers as MergeBlocker[]).map((b) => b.kind)).toContain('conflicts')
      await expect(mergeBanner(page)).toBeVisible()
      await expect(mergeBanner(page)).toHaveAttribute('data-tone', 'error')
      expect(await readMergeCalls(902)).toBeNull()
      expect(await taskStatus(page, 'merge-gate-conflicts')).not.toBe('done')
    })
  })

  test('a still-running check blocks the merge as pending, not as failed', async ({ page }) => {
    await withMergeFixture('merge-gate-pending', 903, async () => {
      const btn = await openMergeTab(page, 'merge-gate-pending')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-pending', btn)

      expect(response.status()).toBe(409)
      const body = await response.json()
      expect(body.blockers).toEqual([expect.objectContaining({ kind: 'check-pending', name: 'e2e' })])
      await expect(mergeBanner(page)).toBeVisible()
      expect(await readMergeCalls(903)).toBeNull()
    })
  })

  test('mergeability GitHub has not finished computing blocks the merge after bounded re-reads', async ({ page }) => {
    await withMergeFixture('merge-gate-unknown', 908, async () => {
      const btn = await openMergeTab(page, 'merge-gate-unknown')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-unknown', btn)

      expect(response.status()).toBe(409)
      const body = await response.json()
      expect((body.blockers as MergeBlocker[]).map((b) => b.kind)).toEqual(['mergeability-unknown'])
      await expect(mergeBanner(page)).toBeVisible()
      expect(await readMergeCalls(908)).toBeNull()
    })
  })
})

test.describe('Merge button — a green PR', () => {
  test('a green PR with zero checks merges, pinned to the checked head commit, and marks the task done', async ({ page }) => {
    await withMergeFixture('merge-gate-green', 904, async () => {
      const btn = await openMergeTab(page, 'merge-gate-green')
      const { response, dialogMessage } = await clickMergeAndConfirm(page, 'merge-gate-green', btn)

      expect(dialogMessage).toContain('#904')
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ merged: true, prNumber: '904', cleaned: true, cleanupError: null })

      const calls = await readMergeCalls(904)
      expect(calls).toContain('--merge')
      expect(calls).toContain(`--match-head-commit ${'904'.padStart(40, '0')}`)
      expect(await readDeleteRefCalls('claude/merge-gate-green')).not.toBeNull()

      expect(await taskStatus(page, 'merge-gate-green')).toBe('done')
      expect(await readTimeline('merge-gate-green')).toMatch(/Z merge merged PR #904\n$/)
      // Same as a successful Mark done fired from inside the overlay.
      await expect(page.getByTestId('task-detail')).toBeHidden()
    })
  })

  test('with a worktree: the confirm names the branch, and a cleanup failure is surfaced without undoing the merge', async ({ page }) => {
    await withMergeFixture('merge-gate-green-worktree', 905, async () => {
      const btn = await openMergeTab(page, 'merge-gate-green-worktree')
      const { response, dialogMessage } = await clickMergeAndConfirm(page, 'merge-gate-green-worktree', btn)

      expect(dialogMessage).toContain('claude/merge-gate-green-worktree')
      expect(response.status()).toBe(200)
      const body = await response.json()
      // merge-gate-repo is not a git checkout (see fakeGh.ts), so worktree
      // removal fails deterministically — after the merge already landed.
      expect(body.merged).toBe(true)
      expect(body.cleaned).toBe(false)
      expect(body.cleanupError).toMatch(/couldn't remove worktree/)

      expect(await readMergeCalls(905)).not.toBeNull()
      // The remote head is exactly the commit GitHub just merged, so its
      // delete runs regardless of the local worktree cleanup's own outcome.
      expect(await readDeleteRefCalls('claude/merge-gate-green-worktree')).not.toBeNull()
      expect(await taskStatus(page, 'merge-gate-green-worktree')).toBe('done')

      // The overlay stays open specifically so this warning is actually
      // read — it doesn't copy markDone's close-on-any-2xx.
      await expect(page.getByTestId('task-detail')).toBeVisible()
      await expect(mergeBanner(page)).toBeVisible()
      await expect(mergeBanner(page)).toHaveAttribute('data-tone', 'warning')
      expect((await bannerLines(page)).join('\n')).toContain("couldn't remove worktree")
    })
  })

  test('dismissing the confirm sends no request and merges nothing', async ({ page }) => {
    await withMergeFixture('merge-gate-green-worktree-dismiss', 906, async () => {
      const btn = await openMergeTab(page, 'merge-gate-green-worktree-dismiss')
      const mergeRequests: string[] = []
      page.on('request', (req) => { if (req.url().includes('/merge-pr/')) mergeRequests.push(req.url()) })

      page.once('dialog', (d) => d.dismiss())
      await btn.click()
      await page.waitForTimeout(300)

      expect(mergeRequests).toEqual([])
      expect(await readMergeCalls(906)).toBeNull()
      expect(await readDeleteRefCalls('claude/merge-gate-green-worktree-dismiss')).toBeNull()
      expect(await taskStatus(page, 'merge-gate-green-worktree-dismiss')).not.toBe('done')
      await expect(page.getByTestId('task-detail')).toBeVisible()
    })
  })

  test('remote branch already gone counts as clean', async ({ page }) => {
    await withMergeFixture('merge-gate-remote-gone', 909, async () => {
      const btn = await openMergeTab(page, 'merge-gate-remote-gone')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-remote-gone', btn)

      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ merged: true, cleaned: true, cleanupError: null })
      // The DELETE was still attempted once — "already gone" is confirmed
      // via matching-refs, not skipped outright.
      expect(await readDeleteRefCalls('claude/merge-gate-remote-gone')).not.toBeNull()
      expect(await taskStatus(page, 'merge-gate-remote-gone')).toBe('done')
      await expect(mergeBanner(page)).toBeHidden()
    })
  })

  test('remote delete failure is surfaced, never undoes the merge', async ({ page }) => {
    await withMergeFixture('merge-gate-remote-delete-fails', 910, async () => {
      const btn = await openMergeTab(page, 'merge-gate-remote-delete-fails')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-remote-delete-fails', btn)

      expect(response.status()).toBe(200)
      const body = await response.json()
      expect(body.merged).toBe(true)
      expect(body.cleaned).toBe(false)
      expect(body.cleanupError).toContain("couldn't delete remote branch claude/merge-gate-remote-delete-fails")
      expect(await readDeleteRefCalls('claude/merge-gate-remote-delete-fails')).not.toBeNull()
      expect(await taskStatus(page, 'merge-gate-remote-delete-fails')).toBe('done')

      await expect(page.getByTestId('task-detail')).toBeVisible()
      await expect(mergeBanner(page)).toBeVisible()
      await expect(mergeBanner(page)).toHaveAttribute('data-tone', 'warning')
    })
  })
})

test.describe('Merge button — gh merge itself fails', () => {
  test('GitHub rejecting the merge surfaces gh\'s own error and leaves the task un-done', async ({ page }) => {
    await withMergeFixture('merge-gate-merge-rejected', 907, async () => {
      const timelineBefore = await readTimeline('merge-gate-merge-rejected')
      const btn = await openMergeTab(page, 'merge-gate-merge-rejected')
      const { response } = await clickMergeAndConfirm(page, 'merge-gate-merge-rejected', btn)

      expect(response.status()).toBe(503)
      expect((await response.json()).error).toContain('Head branch was modified')
      await expect(mergeBanner(page)).toBeVisible()
      await expect(mergeBanner(page)).toHaveAttribute('data-tone', 'error')
      expect((await bannerLines(page)).join('\n')).toContain('Head branch was modified')
      await expect(btn).toBeEnabled()

      expect(await readDeleteRefCalls('claude/merge-gate-merge-rejected')).toBeNull()
      expect(await taskStatus(page, 'merge-gate-merge-rejected')).not.toBe('done')
      expect(await readTimeline('merge-gate-merge-rejected')).toBe(timelineBefore)
    })
  })
})

// The exact command .claude/skills/cockpit-merge/SKILL.md tells the
// orchestrator to run, against the same fixture data and fake gh.
async function runCockpitMerge(...args: string[]) {
  return execa('npm', ['run', '--silent', 'cockpit-merge', '--', ...args], {
    cwd: REPO_ROOT,
    reject: false,
    all: true,
    env: {
      ...fakeGhEnv(),
      TASKS_DIR: FIXTURE_TASKS_DIR,
      REPOS_DIR: FIXTURE_REPOS_DIR,
      WORKTREES_DIR: FIXTURE_WORKTREES_DIR,
    },
  })
}

async function readStatusFile(slug: string): Promise<string> {
  return fs.readFile(path.join(FIXTURE_TASKS_DIR, slug, 'STATUS'), 'utf-8')
}

test.describe('/cockpit-merge CLI — what the skill runs', () => {
  test('refuses a PR with failing checks: exits 2 and prints each failing check by name', async () => {
    await withMergeFixture('merge-cli-blocked', 911, async () => {
      const result = await runCockpitMerge('merge-cli-blocked')

      expect(result.exitCode).toBe(2)
      expect(result.all).toContain('unit-tests')
      expect(result.all).toContain('ci/coverage')
      expect(result.all).not.toMatch(/\blint\b/)
      expect(await readMergeCalls(911)).toBeNull()
      expect(await readDeleteRefCalls('claude/merge-cli-blocked')).toBeNull()
      expect(await readStatusFile('merge-cli-blocked')).toBe('waiting: QA passed, ready to merge\n')
    })
  })

  test('merges a green PR: exits 0, writes the merge TIMELINE line and STATUS done', async () => {
    await withMergeFixture('merge-cli-green', 912, async () => {
      const result = await runCockpitMerge('merge-cli-green')

      expect(result.exitCode).toBe(0)
      expect(await readMergeCalls(912)).toContain(`--match-head-commit ${'912'.padStart(40, '0')}`)
      expect(await readDeleteRefCalls('claude/merge-cli-green')).not.toBeNull()
      expect(await readStatusFile('merge-cli-green')).toBe('done\n')
      expect(await readTimeline('merge-cli-green')).toMatch(/Z merge merged PR #912\n$/)
    })
  })

  test('refuses a task with no recorded PR: exits 1 without calling gh merge', async () => {
    await withRestoredFixtureFiles('merge-cli-no-pr', ['STATUS', 'TIMELINE'], async () => {
      const result = await runCockpitMerge('merge-cli-no-pr')

      expect(result.exitCode).toBe(1)
      expect(result.all).toContain('No PR recorded')
      expect(await readStatusFile('merge-cli-no-pr')).toBe('waiting: QA passed, ready to merge\n')
    })
  })

  test('rejects a missing, unknown or path-traversing slug: exits 1 and touches nothing', async () => {
    await withMergeFixture('merge-cli-green', 912, async () => {
      for (const args of [[], ['does-not-exist'], ['../tasks/merge-cli-green']]) {
        const result = await runCockpitMerge(...args)
        expect(result.exitCode, `args: ${JSON.stringify(args)}`).toBe(1)
      }
      expect(await readMergeCalls(912)).toBeNull()
      expect(await readStatusFile('merge-cli-green')).toBe('waiting: QA passed, ready to merge\n')
    })
  })

  // Regression: resolveTasksDir/parseTask run before main()'s own
  // try/catch, so a throw from either used to surface as a raw
  // unhandled-rejection stack trace (Node's default handling) rather than
  // this file's own clean, single-line stderr message — the exact
  // env-leak scenario resolveTasksDir's own comment warns about.
  test('a TASKS_DIR that cannot be resolved fails cleanly, not with a raw stack trace', async () => {
    const result = await execa('npm', ['run', '--silent', 'cockpit-merge', '--', 'merge-cli-green'], {
      cwd: REPO_ROOT,
      reject: false,
      all: true,
      // extendEnv: false so this can't accidentally inherit a real TASKS_DIR
      // from whatever ran this test suite itself — HOME/PATH kept, npm needs
      // both to run at all.
      extendEnv: false,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
    })

    expect(result.exitCode).toBe(1)
    expect(result.all).toContain('refusing to silently bind the real tasks dir')
    expect(result.all).not.toContain('at main')
    expect(result.all).not.toContain('node:internal')
  })
})
