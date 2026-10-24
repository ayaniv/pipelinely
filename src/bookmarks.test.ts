import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  BOOKMARKS_DIR_ENV_VAR,
  addBookmark,
  deleteBookmark,
  isBookmarkId,
  listBookmarks,
  resolveBookmarksDir,
  validateNewBookmark,
  bookmarksDirPath,
  type Bookmark,
} from './bookmarks.js'

// Bookmarks M0 — the bookmarks' one store. One pretty-printed JSON
// file per bookmark under ~/.config/pipelinely/bookmarks/, never under a repo
// checkout. Every quote below is invented; none comes from a real session.
// Written red during planning.

const FIXED_NOW = new Date('2026-10-08T20:14:27Z')
const SESSION_ID = '0b5e2c1a-7d3f-4e8a-9c21-5f6a7b8c9d0e'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-bookmarks-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function textInput(overrides: Record<string, unknown> = {}): unknown {
  return {
    kind: 'text',
    text: 'Prefer one shared parser over two copies that drift.\n\nIt keeps the record honest.',
    note: 'for the style guide',
    tags: ['Style', 'parsing'],
    source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    ...overrides,
  }
}

function validated(input: unknown) {
  const result = validateNewBookmark(input)
  if (!result.ok) throw new Error(`fixture should be valid: ${result.reason}`)
  return result.value
}

describe('where bookmarks live', () => {
  it('defaults to the user config dir, never the tasks dir', () => {
    expect(bookmarksDirPath('/home/someone')).toBe(path.join('/home/someone', '.config', 'pipelinely', 'bookmarks'))
    expect(resolveBookmarksDir({}, '/home/someone')).toBe(bookmarksDirPath('/home/someone'))
  })

  it('honours the env override (the e2e fixture server and the tests use it)', () => {
    expect(resolveBookmarksDir({ [BOOKMARKS_DIR_ENV_VAR]: ' /tmp/bookmarks-fixture ' }, '/home/someone')).toBe('/tmp/bookmarks-fixture')
  })

  it('ignores a blank override', () => {
    expect(resolveBookmarksDir({ [BOOKMARKS_DIR_ENV_VAR]: '  ' }, '/home/someone')).toBe(bookmarksDirPath('/home/someone'))
  })
})

describe('validateNewBookmark', () => {
  it('accepts a text bookmark and keeps the quote verbatim (no trimming)', () => {
    const text = '  indented first line\nsecond line  \n'
    const value = validated(textInput({ text }))
    expect(value.text).toBe(text)
  })

  it('normalises tags: trimmed, lower-cased, de-duplicated, order kept', () => {
    const value = validated(textInput({ tags: [' Style ', 'parsing', 'style'] }))
    expect(value.tags).toEqual(['style', 'parsing'])
  })

  it('defaults a text bookmark title to its first non-blank line, cut to 80 characters', () => {
    const long = 'x'.repeat(120)
    expect(validated(textInput({ text: `\n\n${long}\nrest` })).title).toBe(`${'x'.repeat(79)}…`)
    expect(validated(textInput({ text: 'short line\nrest' })).title).toBe('short line')
  })

  it('defaults note to empty, tags to none and source fields to null', () => {
    const value = validated({ kind: 'text', text: 'quote' })
    expect(value.note).toBe('')
    expect(value.tags).toEqual([])
    expect(value.source).toEqual({ taskSlug: null, sessionId: null })
  })

  it.each([
    ['an LF', 'first\n2026X  text  FAKE'],
    ['CRLF with padding', 'first \r\n  2026X  text  FAKE'],
    ['a Unicode line separator', 'first\u20282026X  text  FAKE'],
  ])('keeps a title on one line: %s becomes a single space', (_label, title) => {
    const text = validated({ kind: 'text', text: 'quote', title }).title
    expect(text).toMatch(/^first 2026X {2}text {2}FAKE$/)
    expect(validated({ kind: 'session', title, source: { sessionId: SESSION_ID } }).title).toBe(text)
  })

  it.each([
    ['a lone CR', 'first\rFAKE-ID  text  forged\nrest', 'first FAKE-ID  text  forged'],
    ['a Unicode line separator', 'a\u2028b\nrest', 'a b'],
    ['VT, FF and an ANSI erase-line', 'ti\vtle\fff\u001b[2K', 'ti tle ff [2K'],
  ])('derives a one-line title from text with %s', (_label, text, expected) => {
    expect(validated({ kind: 'text', text }).title).toBe(expected)
  })

  it('replaces control characters in an explicit title with a space', () => {
    expect(validated({ kind: 'text', text: 'quote', title: 'ti\vtle\fff\u001b[2K\u0007' }).title).toBe('ti tle ff [2K')
  })

  it.each([
    ['an ESC', '\u001b'],
    ['a BEL', '\u0007'],
    ['a C1 control', '\u009b'],
    ['a zero-width space', '\u200b'],
    ['a right-to-left override', '\u202e'],
  ])('refuses a session title made only of %s', (_label, title) => {
    const result = validateNewBookmark({ kind: 'session', title, source: { sessionId: SESSION_ID } })
    expect(result.ok).toBe(false)
  })

  it('falls back to the text when an explicit title is only control characters', () => {
    expect(validated({ kind: 'text', text: 'real first line', title: '\u0007' }).title).toBe('real first line')
  })

  it('derives the title from the first line that has visible text', () => {
    expect(validated({ kind: 'text', text: '\u0001\n\u200b\nsecond line\n' }).title).toBe('second line')
  })

  it.each([
    ['ZWJ, LRM and RLM', '\u200f\u200d\u200e'],
    ['a word joiner', '\u2060'],
    ['a Hangul filler', '\u3164'],
    ['a soft hyphen', '\u00ad'],
  ])('treats a title of only %s as blank', (_label, title) => {
    expect(validateNewBookmark({ kind: 'session', title, source: { sessionId: SESSION_ID } }).ok).toBe(false)
    expect(validated({ kind: 'text', text: `${title}\nsecond line`, title }).title).toBe('second line')
  })

  it('cuts a derived title between code points, never inside an emoji', () => {
    const title = validated({ kind: 'text', text: `${'a'.repeat(78)}😀😀😀` }).title
    expect(title).toBe(`${'a'.repeat(78)}😀…`)
    expect(title).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/)
  })

  it('refuses text that has no visible character at all', () => {
    expect(validateNewBookmark({ kind: 'text', text: '\u0001\u200b\n' }).ok).toBe(false)
  })

  it('removes bidi overrides, isolates and zero-width characters from a title but keeps LRM, RLM, ZWJ and ZWNJ', () => {
    expect(validated({ kind: 'text', text: 'quote', title: 'a\u202eb\u2066c\u200bd\ufeffe' }).title).toBe('a b c d e')
    expect(validated({ kind: 'text', text: 'quote', title: 'שלום\u200f 👨\u200d👩' }).title).toBe('שלום\u200f 👨\u200d👩')
  })

  it('cuts a derived title to 80 characters after normalising it', () => {
    const title = validated({ kind: 'text', text: `${'x'.repeat(100)}\rFAKE` }).title
    expect(title).toBe(`${'x'.repeat(79)}…`)
  })

  it('accepts a task slug with an underscore or dot, as the rest of the repo does', () => {
    expect(validated(textInput({ source: { taskSlug: 'my_task.v2', sessionId: SESSION_ID } })).source.taskSlug).toBe('my_task.v2')
  })

  it('accepts a session bookmark with a title and a session id, and stores no text', () => {
    const value = validated({ kind: 'session', title: 'The night the gate went green', source: { taskSlug: 'invented-task', sessionId: SESSION_ID } })
    expect(value.kind).toBe('session')
    expect(value.text).toBeNull()
  })

  it.each([
    ['an unknown kind', { kind: 'link', text: 'x' }],
    ['a text bookmark with blank text', { kind: 'text', text: '   \n ' }],
    ['a text bookmark with non-string text', { kind: 'text', text: 42 }],
    ['a session bookmark without a session id', { kind: 'session', title: 'x', source: { taskSlug: 'invented-task' } }],
    ['a session bookmark without a title', { kind: 'session', source: { sessionId: SESSION_ID } }],
    ['a session bookmark carrying text', { kind: 'session', title: 'x', text: 'quote', source: { sessionId: SESSION_ID } }],
    ['a session id that could escape a path', { kind: 'session', title: 'x', source: { sessionId: '../../etc/passwd' } }],
    ['a task slug that could escape a path', { kind: 'text', text: 'x', source: { taskSlug: '../other' } }],
    ['a tag with spaces inside', { kind: 'text', text: 'x', tags: ['two words'] }],
    ['more than ten tags', { kind: 'text', text: 'x', tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }],
    ['text over the size cap', { kind: 'text', text: 'x'.repeat(100_001) }],
    ['not an object at all', 'quote'],
  ])('rejects %s with a reason', (_label, input) => {
    const result = validateNewBookmark(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe('addBookmark', () => {
  it('writes one owner-only, pretty-printed JSON file named by the id', async () => {
    const saved = await addBookmark(dir, validated(textInput()), FIXED_NOW)

    expect(isBookmarkId(saved.id)).toBe(true)
    expect(saved.createdAt).toBe('2026-10-08T20:14:27.000Z')
    const filePath = path.join(dir, `${saved.id}.json`)
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)

    const raw = fs.readFileSync(filePath, 'utf-8')
    expect(raw).toContain('\n  "kind": "text"')
    expect(JSON.parse(raw)).toEqual({ version: 1, ...saved })
  })

  it('creates the bookmarks directory on first save', async () => {
    const fresh = path.join(dir, 'not-yet')
    await addBookmark(fresh, validated(textInput()), FIXED_NOW)
    expect(fs.readdirSync(fresh)).toHaveLength(1)
  })

  it('gives two saves in the same second different ids', async () => {
    const first = await addBookmark(dir, validated(textInput()), FIXED_NOW)
    const second = await addBookmark(dir, validated(textInput()), FIXED_NOW)
    expect(first.id).not.toBe(second.id)
    expect(fs.readdirSync(dir)).toHaveLength(2)
  })
})

describe('listBookmarks', () => {
  it('returns no bookmarks when the directory does not exist yet', async () => {
    expect(await listBookmarks(path.join(dir, 'missing'))).toEqual({ bookmarks: [], unreadable: [] })
  })

  it('lists newest first', async () => {
    const older = await addBookmark(dir, validated(textInput({ text: 'older' })), new Date('2026-10-01T00:00:00Z'))
    const newer = await addBookmark(dir, validated(textInput({ text: 'newer' })), new Date('2026-10-02T00:00:00Z'))

    const { bookmarks } = await listBookmarks(dir)
    expect(bookmarks.map((b: Bookmark) => b.id)).toEqual([newer.id, older.id])
  })

  it('skips a corrupted file, names it, and never deletes or rewrites it', async () => {
    const good = await addBookmark(dir, validated(textInput()), FIXED_NOW)
    const corruptPath = path.join(dir, '20261008T201500Z-abcdef.json')
    fs.writeFileSync(corruptPath, '{"kind":"text","text":"half a quo')
    const log = vi.fn()

    const result = await listBookmarks(dir, log)

    expect(result.bookmarks.map((b: Bookmark) => b.id)).toEqual([good.id])
    expect(result.unreadable).toEqual(['20261008T201500Z-abcdef.json'])
    expect(fs.readFileSync(corruptPath, 'utf-8')).toBe('{"kind":"text","text":"half a quo')
    expect(log).toHaveBeenCalled()
  })

  it('skips a well-formed JSON file that is not a valid bookmark', async () => {
    fs.writeFileSync(path.join(dir, '20261008T201500Z-abcdef.json'), JSON.stringify({ version: 1, kind: 'link' }))
    const result = await listBookmarks(dir, vi.fn())
    expect(result.unreadable).toEqual(['20261008T201500Z-abcdef.json'])
  })

  it('logs the file name but never the file content (bookmarks are personal data)', async () => {
    const secret = 'invented-secret-quote-text'
    fs.writeFileSync(path.join(dir, '20261008T201500Z-abcdef.json'), `{"text":"${secret}`)
    const log = vi.fn()

    await listBookmarks(dir, log)

    const logged = JSON.stringify(log.mock.calls, (_key, value) => (value instanceof Error ? value.message : value))
    expect(logged).toContain('20261008T201500Z-abcdef.json')
    expect(logged).not.toContain(secret)
  })

  it('shows a hand-edited multi-line title on one line', async () => {
    const saved = await addBookmark(dir, validated(textInput()), FIXED_NOW)
    const filePath = path.join(dir, `${saved.id}.json`)
    const edited = { version: 1, ...saved, title: 'first\n2026X forged' }
    fs.writeFileSync(filePath, JSON.stringify(edited))
    expect((await listBookmarks(dir)).bookmarks[0].title).toBe('first 2026X forged')
  })

  it('ignores files that are not bookmarks (temp files, notes, dotfiles)', async () => {
    await addBookmark(dir, validated(textInput()), FIXED_NOW)
    fs.writeFileSync(path.join(dir, 'README.txt'), 'hand-written note')
    fs.writeFileSync(path.join(dir, '.DS_Store'), '')
    fs.writeFileSync(path.join(dir, '20261008T201500Z-abcdef.json.123.tmp'), '{')

    const result = await listBookmarks(dir, vi.fn())
    expect(result.bookmarks).toHaveLength(1)
    expect(result.unreadable).toEqual([])
  })
})

describe('a bookmarks folder that exists but cannot be read', () => {
  it('throws and logs the folder and error code, never returning an empty list', async () => {
    const notAFolder = path.join(dir, 'actually-a-file')
    fs.writeFileSync(notAFolder, 'x')
    const log = vi.fn()

    await expect(listBookmarks(notAFolder, log)).rejects.toThrow(/cannot read the bookmarks folder/i)
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[bookmarks\] .*ENOTDIR/))
  })

  it('fails a save cleanly when the folder path is a file', async () => {
    const notAFolder = path.join(dir, 'actually-a-file')
    fs.writeFileSync(notAFolder, 'x')
    await expect(addBookmark(notAFolder, validated(textInput()), FIXED_NOW)).rejects.toThrow()
    expect(fs.readFileSync(notAFolder, 'utf-8')).toBe('x')
  })

  it('tightens an existing folder that is wider than owner-only', async () => {
    fs.chmodSync(dir, 0o755)
    await addBookmark(dir, validated(textInput()), FIXED_NOW)
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
  })
})

describe('deleteBookmark', () => {
  it('removes exactly that bookmark', async () => {
    const keep = await addBookmark(dir, validated(textInput({ text: 'keep' })), FIXED_NOW)
    const drop = await addBookmark(dir, validated(textInput({ text: 'drop' })), FIXED_NOW)

    expect(await deleteBookmark(dir, drop.id)).toBe('deleted')
    expect((await listBookmarks(dir)).bookmarks.map((b: Bookmark) => b.id)).toEqual([keep.id])
  })

  it("reports not-found for an id that isn't there", async () => {
    expect(await deleteBookmark(dir, '20261008T201427Z-000000')).toBe('not-found')
  })

  it('refuses an id that is not a bookmark id, so nothing outside the bookmarks folder can be removed', async () => {
    const outside = path.join(dir, '..', `outside-${path.basename(dir)}.json`)
    fs.writeFileSync(outside, '{}')
    try {
      await expect(deleteBookmark(dir, `../outside-${path.basename(dir)}`)).rejects.toThrow()
      expect(fs.existsSync(outside)).toBe(true)
    } finally {
      fs.rmSync(outside, { force: true })
    }
  })
})

describe('isBookmarkId', () => {
  it.each(['20261008T201427Z-a1b2c3'])('accepts %s', (id) => {
    expect(isBookmarkId(id)).toBe(true)
  })

  it.each(['', '../x', '20261008T201427Z-a1b2c3.json', '20261008T201427Z-A1B2C3', 'x'.repeat(23)])('rejects %s', (id) => {
    expect(isBookmarkId(id)).toBe(false)
  })
})

// M1 adds three optional fields so a card can show what the design shows: where
// the text came from (a saved answer or a pasted quote) and a project and task
// title snapshot taken at save time. Files written before M1 have none of them
// and must keep listing.
describe('origin, project and task title (optional, backward compatible)', () => {
  const sessionInput = (overrides: Record<string, unknown> = {}) => ({
    kind: 'session',
    title: 'Where the gate went green',
    source: { taskSlug: 'invented-task', sessionId: SESSION_ID },
    ...overrides,
  })

  it('keeps an answer origin and the project and task title snapshots', () => {
    const value = validated(textInput({ origin: 'answer', project: 'invented-repo', taskTitle: 'Invented task title' }))
    expect(value).toMatchObject({ origin: 'answer', project: 'invented-repo', taskTitle: 'Invented task title' })
  })

  it('leaves all three absent, not null, when none is given', () => {
    const value = validated(textInput())
    expect(value).not.toHaveProperty('origin')
    expect(value).not.toHaveProperty('project')
    expect(value).not.toHaveProperty('taskTitle')
  })

  it('accepts a project and task title on a session bookmark', () => {
    expect(validated(sessionInput({ project: 'invented-repo', taskTitle: 'Invented task title' }))).toMatchObject({ project: 'invented-repo', taskTitle: 'Invented task title' })
  })

  it('shows a snapshot on one line, like a title', () => {
    expect(validated(textInput({ taskTitle: 'Two\nlines\u001b[31m' })).taskTitle).toBe('Two lines [31m')
  })

  it.each([
    ['an unknown origin', textInput({ origin: 'link' })],
    ['an origin on a session bookmark', sessionInput({ origin: 'quote' })],
    ['a non-string project', textInput({ project: 7 })],
    ['a non-string task title', textInput({ taskTitle: ['x'] })],
    ['a task title over the cap', textInput({ taskTitle: 'x'.repeat(301) })],
  ])('rejects %s with a reason', (_label, input) => {
    const result = validateNewBookmark(input)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
  })

  it('writes the new fields to the file and reads them back', async () => {
    const saved = await addBookmark(dir, validated(textInput({ origin: 'quote', project: 'invented-repo', taskTitle: 'Invented task title' })), FIXED_NOW)
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${saved.id}.json`), 'utf-8'))).toMatchObject({ version: 1, origin: 'quote', project: 'invented-repo', taskTitle: 'Invented task title' })

    const { bookmarks } = await listBookmarks(dir)
    expect(bookmarks[0]).toMatchObject({ origin: 'quote', project: 'invented-repo', taskTitle: 'Invented task title' })
  })

  it('still lists a version 1 file written before M1, with none of the fields', async () => {
    const id = '20261001T000000Z-aaaaaa'
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'text', title: 'Old', text: 'Old quote.', note: '', tags: [], source: { taskSlug: null, sessionId: null }, createdAt: '2026-10-01T00:00:00.000Z' }))

    const result = await listBookmarks(dir, vi.fn())

    expect(result.unreadable).toEqual([])
    expect(result.bookmarks).toHaveLength(1)
    expect(result.bookmarks[0].origin).toBeUndefined()
  })

  it('reports a stored file with an unknown origin as unreadable, never deleted', async () => {
    const id = '20261001T000000Z-aaaaaa'
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ version: 1, id, kind: 'text', origin: 'link', title: 'x', text: 'x', note: '', tags: [], source: { taskSlug: null, sessionId: null }, createdAt: '2026-10-01T00:00:00.000Z' }))

    const result = await listBookmarks(dir, vi.fn())

    expect(result.unreadable).toEqual([`${id}.json`])
    expect(fs.existsSync(path.join(dir, `${id}.json`))).toBe(true)
  })
})
