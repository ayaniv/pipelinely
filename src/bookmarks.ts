import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomicSync } from './atomicWrite.js'

// Bookmarks: one pretty-printed JSON file per bookmark under
// ~/.config/pipelinely/bookmarks/, deliberately outside every git checkout.
// Bookmarks are personal data, so nothing here logs content or touches a
// network; logs carry file names and error codes only.

export const BOOKMARKS_DIR_ENV_VAR = 'PIPELINELY_BOOKMARKS_DIR'
const BOOKMARKS_FILE_VERSION = 1
const OWNER_ONLY_DIR_MODE = 0o700
const OWNER_ONLY_FILE_MODE = 0o600
const MAX_TEXT_LENGTH = 100_000
const MAX_TAGS = 10
const MAX_DERIVED_TITLE_LENGTH = 80
const MAX_SNAPSHOT_LENGTH = 300
const BOOKMARK_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/
const BOOKMARK_FILE_PATTERN = /^(\d{8}T\d{6}Z-[0-9a-f]{6})\.json$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const TASK_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export type BookmarkKind = 'session' | 'text'

export interface BookmarkSource {
  taskSlug: string | null
  sessionId: string | null
}

// Whether saved text is a previous Claude answer or a quote pasted in. Files
// written before the Bookmarks page have none; the page shows those as quotes.
export type BookmarkOrigin = 'answer' | 'quote'
const BOOKMARK_ORIGINS: readonly BookmarkOrigin[] = ['answer', 'quote']

export interface NewBookmark {
  kind: BookmarkKind
  origin?: BookmarkOrigin
  // What the task was called and which repo it was in when this was saved, so
  // a card still says where it came from after the task leaves the board.
  // Whether the task is still there is never stored: the server works it out
  // on every list.
  project?: string
  taskTitle?: string
  title: string
  text: string | null
  note: string
  tags: string[]
  source: BookmarkSource
}

export interface Bookmark extends NewBookmark {
  id: string
  createdAt: string
}

export type BookmarkLog = (message: string) => void

export interface BookmarkListing {
  bookmarks: Bookmark[]
  unreadable: string[]
}

export type ValidationResult = { ok: true; value: NewBookmark } | { ok: false; reason: string }

const defaultLog: BookmarkLog = (message) => console.error(message)

export function bookmarksDirPath(homeDir: string): string {
  return path.join(homeDir, '.config', 'pipelinely', 'bookmarks')
}

export function resolveBookmarksDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = env[BOOKMARKS_DIR_ENV_VAR]?.trim()
  return override || bookmarksDirPath(homeDir)
}

// The only gate in front of any path built from an id.
export function isBookmarkId(value: string): boolean {
  return BOOKMARK_ID_PATTERN.test(value)
}

export function isTaskSlug(value: string): boolean {
  return TASK_SLUG_PATTERN.test(value)
}

export function isSessionId(value: string): boolean {
  return SESSION_ID_PATTERN.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A title is one line of plain text: `list` prints one bookmark per line and
// the confirmation prints the title to a terminal, so a line break could forge
// a second row and a control character (CR, ESC sequences) could overwrite
// the real id on screen. Each run of control characters or line separators,
// with the spaces around it, becomes one space, so a title written across two
// lines still saves. The same goes for the invisible characters that reorder
// or hide text (bidi embeddings, overrides and isolates, zero-width space,
// BOM): an unmatched override reverses the rest of a `list` line. LRM, RLM,
// ZWJ and ZWNJ stay because Hebrew and emoji titles really use them.
const CONTROL_RUN = /\s*[\p{Cc}\u2028\u2029\u061c\u200b\u202a-\u202e\u2066-\u2069\ufeff]+\s*/gu

// A title of only joiners, direction marks or fillers (ZWJ, LRM, U+3164...)
// would print as nothing, so it counts as blank. They stay inside a title that
// also has visible text.
const INVISIBLE_ONLY = /^[\s\p{Default_Ignorable_Code_Point}]*$/u

// Exported so the CLI's blank check judges a title the way the store will.
export function toSingleLineTitle(title: string): string {
  const oneLine = title.replace(CONTROL_RUN, ' ').trim()
  return INVISIBLE_ONLY.test(oneLine) ? '' : oneLine
}

function deriveTitle(text: string): string {
  const line = text.split('\n').map(toSingleLineTitle).find((candidate) => candidate !== '') ?? ''
  // Cut by code point: a UTF-16 cut can split an emoji into a lone surrogate.
  const codePoints = Array.from(line)
  return codePoints.length > MAX_DERIVED_TITLE_LENGTH ? `${codePoints.slice(0, MAX_DERIVED_TITLE_LENGTH - 1).join('')}…` : line
}

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }

function checkTags(raw: unknown): Checked<string[]> {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw) || raw.some((tag) => typeof tag !== 'string')) return { ok: false, reason: 'tags must be a list of strings' }
  const tags = [...new Set(raw.map((tag: string) => tag.trim().toLowerCase()))]
  const badTag = tags.find((tag) => !TAG_PATTERN.test(tag))
  if (badTag !== undefined) return { ok: false, reason: `tag '${badTag}' must be a lower-case slug (letters, digits, '.', '_', '-')` }
  if (tags.length > MAX_TAGS) return { ok: false, reason: `at most ${MAX_TAGS} tags` }
  return { ok: true, value: tags }
}

function checkSourceField(raw: unknown, field: keyof BookmarkSource, pattern: RegExp): Checked<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null }
  if (typeof raw !== 'string' || !pattern.test(raw)) return { ok: false, reason: `source.${field} is not a valid ${field}` }
  return { ok: true, value: raw }
}

function checkSource(raw: unknown): Checked<BookmarkSource> {
  if (raw === undefined) return { ok: true, value: { taskSlug: null, sessionId: null } }
  if (!isRecord(raw)) return { ok: false, reason: 'source must be an object' }
  const taskSlug = checkSourceField(raw.taskSlug, 'taskSlug', TASK_SLUG_PATTERN)
  if (!taskSlug.ok) return taskSlug
  const sessionId = checkSourceField(raw.sessionId, 'sessionId', SESSION_ID_PATTERN)
  if (!sessionId.ok) return sessionId
  return { ok: true, value: { taskSlug: taskSlug.value, sessionId: sessionId.value } }
}

function checkTitleAndText(kind: BookmarkKind, input: Record<string, unknown>, source: BookmarkSource): Checked<{ title: string; text: string | null }> {
  const title = typeof input.title === 'string' ? toSingleLineTitle(input.title) : ''
  const hasTitle = title !== ''
  if (input.title !== undefined && typeof input.title !== 'string') return { ok: false, reason: 'title must be a string' }

  if (kind === 'session') {
    if (input.text !== undefined && input.text !== null) return { ok: false, reason: 'a session bookmark carries no text' }
    if (!hasTitle) return { ok: false, reason: 'a session bookmark needs a title' }
    if (source.sessionId === null) return { ok: false, reason: 'a session bookmark needs a session id' }
    return { ok: true, value: { title, text: null } }
  }

  if (typeof input.text !== 'string' || input.text.trim() === '') return { ok: false, reason: 'a text bookmark needs non-blank text' }
  if (input.text.length > MAX_TEXT_LENGTH) return { ok: false, reason: `text is over ${MAX_TEXT_LENGTH} characters` }
  const derivedTitle = deriveTitle(input.text)
  if (derivedTitle === '') return { ok: false, reason: 'a text bookmark needs non-blank text' }
  return { ok: true, value: { title: hasTitle ? title : derivedTitle, text: input.text } }
}

function checkOrigin(kind: BookmarkKind, raw: unknown): Checked<BookmarkOrigin | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (kind === 'session') return { ok: false, reason: 'a session bookmark has no origin' }
  if (!BOOKMARK_ORIGINS.includes(raw as BookmarkOrigin)) return { ok: false, reason: `origin must be one of ${BOOKMARK_ORIGINS.join(', ')}` }
  return { ok: true, value: raw as BookmarkOrigin }
}

// A snapshot is shown on one line, like a title; blank means "not recorded".
function checkSnapshot(raw: unknown, field: 'project' | 'taskTitle'): Checked<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (typeof raw !== 'string') return { ok: false, reason: `${field} must be a string` }
  const value = toSingleLineTitle(raw)
  if (Array.from(value).length > MAX_SNAPSHOT_LENGTH) return { ok: false, reason: `${field} is over ${MAX_SNAPSHOT_LENGTH} characters` }
  return { ok: true, value: value === '' ? undefined : value }
}

export function validateNewBookmark(input: unknown): ValidationResult {
  if (!isRecord(input)) return { ok: false, reason: 'a bookmark must be an object' }
  if (input.kind !== 'text' && input.kind !== 'session') return { ok: false, reason: "kind must be 'text' or 'session'" }
  if (input.note !== undefined && typeof input.note !== 'string') return { ok: false, reason: 'note must be a string' }

  const source = checkSource(input.source)
  if (!source.ok) return source
  const tags = checkTags(input.tags)
  if (!tags.ok) return tags
  const titleAndText = checkTitleAndText(input.kind, input, source.value)
  if (!titleAndText.ok) return titleAndText
  const origin = checkOrigin(input.kind, input.origin)
  if (!origin.ok) return origin
  const project = checkSnapshot(input.project, 'project')
  if (!project.ok) return project
  const taskTitle = checkSnapshot(input.taskTitle, 'taskTitle')
  if (!taskTitle.ok) return taskTitle

  return {
    ok: true,
    value: {
      kind: input.kind,
      // Absent, never null or undefined-valued, so the file stays as small as
      // an M0 one when nothing was recorded.
      ...(origin.value === undefined ? {} : { origin: origin.value }),
      ...(project.value === undefined ? {} : { project: project.value }),
      ...(taskTitle.value === undefined ? {} : { taskTitle: taskTitle.value }),
      title: titleAndText.value.title,
      text: titleAndText.value.text,
      note: input.note ?? '',
      tags: tags.value,
      source: source.value,
    },
  }
}

function generateBookmarkId(now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`
}

export async function addBookmark(dir: string, value: NewBookmark, now: Date = new Date()): Promise<Bookmark> {
  const bookmark: Bookmark = { id: generateBookmarkId(now), ...value, createdAt: now.toISOString() }
  const content = `${JSON.stringify({ version: BOOKMARKS_FILE_VERSION, ...bookmark }, null, 2)}\n`
  writeFileAtomicSync(path.join(dir, `${bookmark.id}.json`), content, { fileMode: OWNER_ONLY_FILE_MODE, dirMode: OWNER_ONLY_DIR_MODE })
  return bookmark
}

// Returns null for anything that isn't a well-formed bookmark whose id
// matches its file name. Never throws: the caller reports the file name.
function parseStoredBookmark(raw: string, expectedId: string): Bookmark | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed) || parsed.version !== BOOKMARKS_FILE_VERSION || parsed.id !== expectedId) return null
  if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt))) return null
  const validated = validateNewBookmark(parsed)
  if (!validated.ok) return null
  return { id: expectedId, ...validated.value, createdAt: parsed.createdAt }
}

async function readBookmarkFileNames(dir: string, log: BookmarkLog): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // No folder yet just means nothing has been saved.
    if (code === 'ENOENT') return []
    log(`[bookmarks] cannot read bookmarks folder ${dir}: ${code ?? 'unknown error'}`)
    throw new Error(`Cannot read the bookmarks folder ${dir} (${code ?? 'unknown error'})`)
  }
}

async function readBookmarkFile(dir: string, fileName: string, id: string, log: BookmarkLog): Promise<Bookmark | null> {
  let raw: string
  try {
    raw = await fs.readFile(path.join(dir, fileName), 'utf-8')
  } catch (err) {
    log(`[bookmarks] cannot read ${fileName}: ${(err as NodeJS.ErrnoException).code ?? 'unknown error'}`)
    return null
  }
  const bookmark = parseStoredBookmark(raw, id)
  if (bookmark === null) log(`[bookmarks] skipping ${fileName}: not a valid bookmark`)
  return bookmark
}

// Newest first. A corrupt or foreign <id>.json is reported by name in
// `unreadable`, and is never deleted or rewritten. Other file names
// (.DS_Store, *.tmp, hand-written notes) are not bookmarks and are ignored.
export async function listBookmarks(dir: string, log: BookmarkLog = defaultLog): Promise<BookmarkListing> {
  const fileNames = await readBookmarkFileNames(dir, log)
  const bookmarks: Bookmark[] = []
  const unreadable: string[] = []

  for (const fileName of fileNames.sort()) {
    const id = BOOKMARK_FILE_PATTERN.exec(fileName)?.[1]
    if (id === undefined) continue
    const bookmark = await readBookmarkFile(dir, fileName, id, log)
    if (bookmark === null) unreadable.push(fileName)
    else bookmarks.push(bookmark)
  }

  bookmarks.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  return { bookmarks, unreadable }
}

export async function deleteBookmark(dir: string, id: string): Promise<'deleted' | 'not-found'> {
  if (!isBookmarkId(id)) throw new Error(`'${id}' is not a bookmark id`)
  try {
    await fs.unlink(path.join(dir, `${id}.json`))
    return 'deleted'
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'not-found'
    throw err
  }
}
