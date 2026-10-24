import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runBookmarksCommand, type BookmarksCliContext } from './bookmarksCli.js'
import { listBookmarks } from './bookmarks.js'

// Bookmarks M0 — `npm run bookmarks -- <command>`, the one write path
// the /pipelinely-bookmark skill uses. The commands go through the exported function, not a
// spawned process (remoteTokenCli.test.ts's shape), so the bookmarks folder and the
// transcripts can live in a throwaway home. e2e/bookmarks-cli.spec.ts covers the
// real process: argv, stdin, exit codes. Every quote and transcript line is
// invented. Written red during planning.

const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'
const FIXED_NOW = new Date('2026-10-08T20:14:27Z')

let homeDir: string
let ctx: BookmarksCliContext
let stdinText: string

function writeTranscript(entries: unknown[]): void {
  const folder = path.join(ctx.projectsDir, '-invented-launch-dir')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, `${SESSION_ID}.jsonl`), entries.map((e) => JSON.stringify(e)).join('\n') + '\n')
}

const prompt = (content: string) => ({ type: 'user', message: { role: 'user', content } })
const answer = (value: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: value }] } })

beforeEach(() => {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-bookmarks-cli-'))
  stdinText = ''
  ctx = {
    bookmarksDir: path.join(homeDir, '.config', 'pipelinely', 'bookmarks'),
    projectsDir: path.join(homeDir, '.claude', 'projects'),
    readStdin: async () => stdinText,
    env: { COCKPIT_TASK_SLUG: 'invented-task', CLAUDE_CODE_SESSION_ID: SESSION_ID },
    now: () => FIXED_NOW,
    tasksDir: path.join(homeDir, 'tasks'),
  }
})

afterEach(() => {
  fs.rmSync(homeDir, { recursive: true, force: true })
})

async function onlyBookmark() {
  const { bookmarks } = await listBookmarks(ctx.bookmarksDir)
  expect(bookmarks).toHaveLength(1)
  return bookmarks[0]
}

describe('add-text', () => {
  it('saves stdin verbatim with title, note, tags and where it came from', async () => {
    stdinText = 'A quote with "quotes", $dollars and `backticks`.\n'
    const output = await runBookmarksCommand(['add-text', '--title', 'Shell-safe quote', '--note', 'why I kept it', '--tags', 'shell, quoting'], ctx)

    const saved = await onlyBookmark()
    expect(saved).toMatchObject({
      kind: 'text',
      title: 'Shell-safe quote',
      text: 'A quote with "quotes", $dollars and `backticks`.\n',
      note: 'why I kept it',
      tags: ['shell', 'quoting'],
      source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    })
    expect(output).toContain(saved.id)
  })

  // The skill reads --note/--tags with `read` from a heredoc, which keeps the
  // heredoc's final newline.
  it('drops the trailing newline a heredoc-fed note and tags arrive with', async () => {
    stdinText = 'quote'
    await runBookmarksCommand(['add-text', '--note', 'why I kept it\n', '--tags', 'shell,quoting\n'], ctx)
    expect(await onlyBookmark()).toMatchObject({ note: 'why I kept it', tags: ['shell', 'quoting'] })
  })

  it('records no task when run outside a cockpit task tab', async () => {
    stdinText = 'quote'
    ctx.env = { CLAUDE_CODE_SESSION_ID: SESSION_ID }
    await runBookmarksCommand(['add-text'], ctx)
    expect((await onlyBookmark()).source.taskSlug).toBeNull()
  })

  it('refuses empty stdin and writes nothing', async () => {
    stdinText = '  \n'
    await expect(runBookmarksCommand(['add-text'], ctx)).rejects.toThrow(/empty/i)
    expect(fs.existsSync(ctx.bookmarksDir)).toBe(false)
  })
})

describe('add-last', () => {
  it('saves the previous answer from this session, verbatim', async () => {
    writeTranscript([prompt('q'), answer('The answer worth keeping.\n\n- with a list'), prompt('/pipelinely-bookmark'), answer('Saving.')])

    await runBookmarksCommand(['add-last', '--tags', 'keep'], ctx)

    const saved = await onlyBookmark()
    expect(saved.kind).toBe('text')
    expect(saved.text).toBe('The answer worth keeping.\n\n- with a list')
    expect(saved.title).toBe('The answer worth keeping.')
    expect(saved.tags).toEqual(['keep'])
  })

  it('fails clearly when this tab has no session id', async () => {
    ctx.env = {}
    await expect(runBookmarksCommand(['add-last'], ctx)).rejects.toThrow(/session/i)
  })

  it("fails clearly when the session's transcript cannot be found", async () => {
    await expect(runBookmarksCommand(['add-last'], ctx)).rejects.toThrow(/transcript/i)
    expect(fs.existsSync(ctx.bookmarksDir)).toBe(false)
  })

  it('fails clearly when there is no earlier answer to save', async () => {
    writeTranscript([prompt('/pipelinely-bookmark'), answer('Saving.')])
    await expect(runBookmarksCommand(['add-last'], ctx)).rejects.toThrow(/no earlier answer/i)
    expect(fs.existsSync(ctx.bookmarksDir)).toBe(false)
  })
})

describe('add-session', () => {
  it('saves a pointer to this session and task, with no text', async () => {
    await runBookmarksCommand(['add-session', '--title', 'Where the store was decided', '--note', 'read again before M1'], ctx)

    expect(await onlyBookmark()).toMatchObject({
      kind: 'session',
      title: 'Where the store was decided',
      text: null,
      note: 'read again before M1',
      source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    })
  })

  it('needs a title', async () => {
    await expect(runBookmarksCommand(['add-session'], ctx)).rejects.toThrow(/title/i)
  })

  it('needs a title that has a visible character, not only control characters', async () => {
    await expect(runBookmarksCommand(['add-session', '--title', '\u001b'], ctx)).rejects.toThrow(/title/i)
    expect(fs.existsSync(ctx.bookmarksDir)).toBe(false)
  })

  it('needs a session id', async () => {
    ctx.env = { COCKPIT_TASK_SLUG: 'invented-task' }
    await expect(runBookmarksCommand(['add-session', '--title', 'x'], ctx)).rejects.toThrow(/session/i)
  })
})

describe('a task slug the store would refuse', () => {
  it('saves with no task and says so, instead of failing the whole save', async () => {
    stdinText = 'quote'
    ctx.env = { COCKPIT_TASK_SLUG: '../stale slug', CLAUDE_CODE_SESSION_ID: SESSION_ID }

    const output = await runBookmarksCommand(['add-text'], ctx)

    expect((await onlyBookmark()).source).toEqual({ taskSlug: null, sessionId: SESSION_ID })
    expect(output).toMatch(/COCKPIT_TASK_SLUG/)
  })
})

describe('list and rm', () => {
  it('lists what is saved and says so when there are no bookmarks', async () => {
    const emptyListing = await runBookmarksCommand(['list'], ctx)
    expect(emptyListing).toMatch(/empty/i)
    // A mistyped PIPELINELY_BOOKMARKS_DIR reads as no bookmarks, so the listing
    // always names the directory it read.
    expect(emptyListing).toContain(ctx.bookmarksDir)

    stdinText = 'quote'
    await runBookmarksCommand(['add-text', '--title', 'Listed title'], ctx)
    const saved = await onlyBookmark()

    const output = await runBookmarksCommand(['list'], ctx)
    expect(output).toContain(saved.id)
    expect(output).toContain('Listed title')
  })

  it('lists every bookmark on exactly one line, even with a multi-line title', async () => {
    stdinText = 'quote'
    await runBookmarksCommand(['add-text', '--title', 'first\n20261008T201427Z-aaaaaa  text  FAKE'], ctx)
    const saved = await onlyBookmark()

    const output = await runBookmarksCommand(['list'], ctx)
    expect(output.split('\n').filter((line) => line.includes(saved.id))).toHaveLength(1)
    expect(output.split('\n').filter((line) => line.startsWith('20261008T201427Z-aaaaaa'))).toEqual([])
  })

  it('prints no control character from a derived title in the confirmation or the list', async () => {
    stdinText = 'first\rFAKE-ID  text  forged\u001b[2K\nrest\n'
    const saved = await runBookmarksCommand(['add-text'], ctx)
    const listed = await runBookmarksCommand(['list'], ctx)
    // eslint-disable-next-line no-control-regex -- asserting that no control character reaches the terminal
    for (const output of [saved, listed]) expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u2028\u2029]/)
    expect((await onlyBookmark()).title).toBe('first FAKE-ID  text  forged [2K')
  })

  it('names unreadable files in the list instead of hiding them', async () => {
    fs.mkdirSync(ctx.bookmarksDir, { recursive: true })
    fs.writeFileSync(path.join(ctx.bookmarksDir, '20261008T201500Z-abcdef.json'), '{')
    const output = await runBookmarksCommand(['list'], ctx)
    expect(output).toContain('20261008T201500Z-abcdef.json')
  })

  it('removes a bookmark by id, and fails for an unknown one', async () => {
    stdinText = 'quote'
    await runBookmarksCommand(['add-text'], ctx)
    const saved = await onlyBookmark()

    await runBookmarksCommand(['rm', saved.id], ctx)
    expect((await listBookmarks(ctx.bookmarksDir)).bookmarks).toEqual([])
    await expect(runBookmarksCommand(['rm', saved.id], ctx)).rejects.toThrow(/not found/i)
  })
})

describe('usage errors', () => {
  it.each([
    ['no command', []],
    ['an unknown command', ['export']],
    ['an unknown flag', ['add-text', '--colour', 'red']],
    ['a flag missing its value', ['add-text', '--title']],
    ['rm without an id', ['rm']],
    ['a stray word after add-text', ['add-text', 'some', 'words']],
    ['a stray word after add-last', ['add-last', 'extra']],
    ['a stray word after list', ['list', 'extra']],
    ['two ids after rm', ['rm', '20261008T201427Z-a1b2c3', '20261008T201427Z-a1b2c4']],
  ])('rejects %s and writes nothing', async (_label, args) => {
    stdinText = 'quote'
    await expect(runBookmarksCommand(args, ctx)).rejects.toThrow()
    expect(fs.existsSync(ctx.bookmarksDir)).toBe(false)
  })
})

// M1: what the Bookmarks page shows of a card that is not in the quote itself.
describe('origin and the task snapshot', () => {
  function writeTaskMd(slug: string, content: string): void {
    fs.mkdirSync(path.join(ctx.tasksDir!, slug), { recursive: true })
    fs.writeFileSync(path.join(ctx.tasksDir!, slug, 'TASK.md'), content)
  }

  it('marks add-last as an answer and add-text as a quote', async () => {
    writeTranscript([prompt('q'), answer('An answer.'), prompt('/pipelinely-bookmark'), answer('Saving.')])
    await runBookmarksCommand(['add-last'], ctx)
    stdinText = 'A pasted quote.'
    await runBookmarksCommand(['add-text'], ctx)

    const { bookmarks } = await listBookmarks(ctx.bookmarksDir)
    expect(bookmarks.map((b) => [b.text, b.origin])).toEqual(expect.arrayContaining([['An answer.', 'answer'], ['A pasted quote.', 'quote']]))
  })

  it('snapshots the task title and project from the task\'s TASK.md', async () => {
    writeTaskMd('invented-task', '# Invented task title\n\n## Workspace\n- Repo: invented-repo\n- Branch: claude/invented-task\n')
    await runBookmarksCommand(['add-session', '--title', 'A session'], ctx)

    expect(await onlyBookmark()).toMatchObject({ taskTitle: 'Invented task title', project: 'invented-repo' })
  })

  it('saves without a snapshot when the task is not on this machine', async () => {
    await runBookmarksCommand(['add-session', '--title', 'A session'], ctx)

    const saved = await onlyBookmark()
    expect(saved.taskTitle).toBeUndefined()
    expect(saved.project).toBeUndefined()
  })

  it('saves without a snapshot when the TASK.md cannot be read, and logs why without its content', async () => {
    writeTaskMd('invented-task', 'invented-private-title\n')
    fs.chmodSync(path.join(ctx.tasksDir!, 'invented-task', 'TASK.md'), 0o000)
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await runBookmarksCommand(['add-session', '--title', 'A session'], ctx)

    expect((await onlyBookmark()).taskTitle).toBeUndefined()
    expect(log.mock.calls.flat().join(' ')).not.toContain('invented-private-title')
    log.mockRestore()
  })

  it('does not look for a task when run outside a cockpit task tab', async () => {
    ctx.env = { CLAUDE_CODE_SESSION_ID: SESSION_ID }
    await runBookmarksCommand(['add-session', '--title', 'A session'], ctx)
    expect((await onlyBookmark()).project).toBeUndefined()
  })
})
