import { test, expect } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'

// Bookmarks M0 — `npm run bookmarks -- <command>`, exactly as the
// /pipelinely-bookmark skill runs it from inside a Claude tab: a real process, real argv,
// the quote on stdin, the session id from CLAUDE_CODE_SESSION_ID. The command
// logic is unit-tested in src/bookmarksCli.test.ts; this proves the wiring
// (package.json script, stdin, exit codes) end to end.
//
// Every run gets its own throwaway HOME and PIPELINELY_BOOKMARKS_DIR, set
// explicitly, so nothing here can read the developer's real transcripts or
// write into their real bookmarks, and the session id and task slug are
// overridden so the developer's own tab can't leak into a run. All quotes
// and transcript lines are invented.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(__dirname, '..')
const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'

let homeDir: string
let bookmarksDir: string

test.beforeEach(async () => {
  homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-bookmarks-cli-e2e-'))
  bookmarksDir = path.join(homeDir, 'bookmarks')
})

test.afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true })
})

async function runBookmarks(args: string[], input = '') {
  return execa('npm', ['run', '--silent', 'bookmarks', '--', ...args], {
    cwd: REPO_ROOT,
    reject: false,
    all: true,
    input,
    env: {
      HOME: homeDir,
      PIPELINELY_BOOKMARKS_DIR: bookmarksDir,
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
      COCKPIT_TASK_SLUG: 'invented-task',
    },
  })
}

async function savedBookmarks(): Promise<Record<string, unknown>[]> {
  const names = await fs.readdir(bookmarksDir).catch(() => [] as string[])
  return Promise.all(names.filter((n) => n.endsWith('.json')).map(async (n) => JSON.parse(await fs.readFile(path.join(bookmarksDir, n), 'utf-8'))))
}

async function writeTranscript(lines: unknown[]): Promise<void> {
  const folder = path.join(homeDir, '.claude', 'projects', '-invented-launch-dir')
  await fs.mkdir(folder, { recursive: true })
  await fs.writeFile(path.join(folder, `${SESSION_ID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
}

test.describe('bookmarks CLI', () => {
  test('add-text saves stdin verbatim, shell metacharacters and all', async () => {
    const quote = 'Run `rm -rf $(pwd)` only in a sandbox; "quotes" stay; trailing  \n'
    const result = await runBookmarks(['add-text', '--title', 'Sandbox warning', '--tags', 'shell'], quote)

    expect(result.exitCode, result.all).toBe(0)
    const [saved] = await savedBookmarks()
    expect(saved).toMatchObject({ version: 1, kind: 'text', title: 'Sandbox warning', text: quote, tags: ['shell'] })
    expect(saved.source).toEqual({ taskSlug: 'invented-task', sessionId: SESSION_ID })
  })

  test('add-last saves the previous answer from the session transcript', async () => {
    await writeTranscript([
      { type: 'user', message: { role: 'user', content: 'q' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Keep the store boring.' }] } },
      { type: 'user', message: { role: 'user', content: '<command-name>/pipelinely-bookmark</command-name>' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Saving.' }] } },
    ])

    const result = await runBookmarks(['add-last'])

    expect(result.exitCode, result.all).toBe(0)
    expect((await savedBookmarks()).map((b) => b.text)).toEqual(['Keep the store boring.'])
  })

  test('add-session saves a pointer with no text', async () => {
    const result = await runBookmarks(['add-session', '--title', 'Store decided here'])
    expect(result.exitCode, result.all).toBe(0)
    expect(await savedBookmarks()).toMatchObject([{ kind: 'session', title: 'Store decided here', text: null }])
  })

  test('list then rm round-trips through the files', async () => {
    await runBookmarks(['add-text', '--title', 'Round trip'], 'quote')
    const [saved] = await savedBookmarks()

    const listed = await runBookmarks(['list'])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain(String(saved.id))

    const removed = await runBookmarks(['rm', String(saved.id)])
    expect(removed.exitCode, removed.all).toBe(0)
    expect(await savedBookmarks()).toEqual([])
  })

  test('fails with exit 1 and a message on stderr, writing nothing', async () => {
    const empty = await runBookmarks(['add-text'], '   ')
    expect(empty.exitCode).toBe(1)
    expect(empty.stderr).toMatch(/empty/i)

    const noTranscript = await runBookmarks(['add-last'])
    expect(noTranscript.exitCode).toBe(1)
    expect(noTranscript.stderr).toMatch(/transcript/i)

    const unknown = await runBookmarks(['export'])
    expect(unknown.exitCode).toBe(1)

    expect(await savedBookmarks()).toEqual([])
  })
})
