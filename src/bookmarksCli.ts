import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs/promises'
import {
  addBookmark,
  deleteBookmark,
  isTaskSlug,
  listBookmarks,
  resolveBookmarksDir,
  validateNewBookmark,
  type Bookmark,
  type BookmarkKind,
  type BookmarkOrigin,
  toSingleLineTitle,
} from './bookmarks.js'
import { CANONICAL_REPO_PATH } from './derivePort.js'
import { parseTaskMdContent } from './taskParser.js'
import { findTranscriptPath, lastAssistantAnswer } from './bookmarksTranscript.js'

const USAGE = [
  'Usage: bookmarks <command> [--title T] [--note N] [--tags a,b]',
  '  add-text      save stdin verbatim as a text bookmark',
  '  add-last      save the previous answer of this Claude session',
  '  add-session   save a pointer to this Claude session (needs --title)',
  '  list          list saved bookmarks',
  '  rm <id>       delete a bookmark',
].join('\n')

const FLAG_NAMES = ['title', 'note', 'tags'] as const
type FlagName = (typeof FLAG_NAMES)[number]

export interface BookmarksCliContext {
  bookmarksDir: string
  projectsDir: string
  readStdin: () => Promise<string>
  env: NodeJS.ProcessEnv
  now: () => Date
  // Where task folders live, to snapshot the task's title and repo at save
  // time. Absent: no snapshot is taken.
  tasksDir?: string
}

interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Partial<Record<FlagName, string>>
}

const NO_POSITIONALS: Record<string, number> = { 'add-text': 0, 'add-last': 0, 'add-session': 0, list: 0, rm: 1 }

function usageError(detail: string): Error {
  return new Error(`${detail}\n${USAGE}`)
}

function isFlagName(name: string): name is FlagName {
  return (FLAG_NAMES as readonly string[]).includes(name)
}

function parseArgs(args: string[]): ParsedArgs {
  const [command, ...rest] = args
  if (command === undefined) throw usageError('Missing command.')
  const positionals: string[] = []
  const flags: Partial<Record<FlagName, string>> = {}
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    if (!isFlagName(name)) throw usageError(`Unknown flag '${arg}'.`)
    const value = rest[i + 1]
    if (value === undefined) throw usageError(`Flag '${arg}' needs a value.`)
    // The skill fills flag values with `read` from a heredoc, which keeps its final newline.
    flags[name] = value.replace(/\n+$/, '')
    i += 1
  }
  const allowedPositionals = NO_POSITIONALS[command]
  if (allowedPositionals !== undefined && positionals.length !== allowedPositionals && command !== 'rm') {
    throw usageError(`Unexpected argument '${positionals[0]}' for ${command}.`)
  }
  if (command === 'rm' && positionals.length > allowedPositionals) throw usageError('rm takes exactly one bookmark id.')
  return { command, positionals, flags }
}

function parseTags(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((tag) => tag.trim()).filter((tag) => tag !== '')
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function describeSaved(bookmark: Bookmark): string {
  return `Saved ${bookmark.kind} bookmark ${bookmark.id}: ${bookmark.title}`
}

// A stale or odd COCKPIT_TASK_SLUG must not block a save that doesn't need it.
function resolveTaskSlug(ctx: BookmarksCliContext): { taskSlug: string | null; note: string } {
  const taskSlug = nonBlank(ctx.env.COCKPIT_TASK_SLUG)
  if (taskSlug === null || isTaskSlug(taskSlug)) return { taskSlug, note: '' }
  return { taskSlug: null, note: '\nNote: COCKPIT_TASK_SLUG is not a valid task slug, so this bookmark records no task.' }
}

interface TaskSnapshot {
  taskTitle?: string
  project?: string
}

// The task's title and repo as they are today, kept on the bookmark so its
// card still says where it came from once the task leaves the board. A missing
// TASK.md is normal (the task is gone, or this is another machine) and a
// snapshot is optional, so neither blocks a save; anything else is logged by
// error code only, since the file's content is not the CLI's to echo.
async function readTaskSnapshot(taskSlug: string | null, ctx: BookmarksCliContext): Promise<TaskSnapshot> {
  if (taskSlug === null || ctx.tasksDir === undefined) return {}
  try {
    const { title, repo } = parseTaskMdContent(await fs.readFile(path.join(ctx.tasksDir, taskSlug, 'TASK.md'), 'utf-8'))
    return { taskTitle: title || undefined, project: repo || undefined }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') console.error(`[bookmarks] cannot read the task's TASK.md for its title: ${code ?? 'unknown error'}`)
    return {}
  }
}

async function saveBookmark(kind: BookmarkKind, text: string | null, origin: BookmarkOrigin | undefined, parsed: ParsedArgs, ctx: BookmarksCliContext): Promise<string> {
  const { taskSlug, note } = resolveTaskSlug(ctx)
  const validated = validateNewBookmark({
    kind,
    origin,
    ...(await readTaskSnapshot(taskSlug, ctx)),
    text,
    title: parsed.flags.title,
    note: parsed.flags.note,
    tags: parseTags(parsed.flags.tags),
    source: { taskSlug, sessionId: nonBlank(ctx.env.CLAUDE_CODE_SESSION_ID) },
  })
  if (!validated.ok) throw new Error(`Cannot save bookmark: ${validated.reason}`)
  return describeSaved(await addBookmark(ctx.bookmarksDir, validated.value, ctx.now())) + note
}

// The session id comes from the environment only, so the model can't
// mistype or substitute someone else's.
function requireSessionId(ctx: BookmarksCliContext, command: string): string {
  const sessionId = nonBlank(ctx.env.CLAUDE_CODE_SESSION_ID)
  if (sessionId === null) throw new Error(`${command} needs CLAUDE_CODE_SESSION_ID, which only a Claude Code session sets.`)
  return sessionId
}

async function addText(parsed: ParsedArgs, ctx: BookmarksCliContext): Promise<string> {
  const text = await ctx.readStdin()
  if (text.trim() === '') throw new Error('Nothing to save: stdin is empty.')
  return saveBookmark('text', text, 'quote', parsed, ctx)
}

async function addLast(parsed: ParsedArgs, ctx: BookmarksCliContext): Promise<string> {
  const sessionId = requireSessionId(ctx, 'add-last')
  const transcriptPath = await findTranscriptPath(ctx.projectsDir, sessionId)
  if (transcriptPath === null) throw new Error(`Transcript not found for session ${sessionId} under ${ctx.projectsDir}. Paste the text with add-text instead.`)
  const answer = lastAssistantAnswer(await fs.readFile(transcriptPath, 'utf-8'))
  if (answer === null) throw new Error('No earlier answer to save in this session. Paste the text with add-text instead.')
  return saveBookmark('text', answer, 'answer', parsed, ctx)
}

async function addSession(parsed: ParsedArgs, ctx: BookmarksCliContext): Promise<string> {
  if (parsed.flags.title === undefined || toSingleLineTitle(parsed.flags.title) === '') throw usageError('add-session needs --title.')
  requireSessionId(ctx, 'add-session')
  return saveBookmark('session', null, undefined, parsed, ctx)
}

function formatListLine(bookmark: Bookmark): string {
  const tags = bookmark.tags.map((tag) => `#${tag}`).join(' ')
  return [bookmark.id, bookmark.kind, bookmark.title, tags].filter((part) => part !== '').join('  ')
}

async function list(ctx: BookmarksCliContext): Promise<string> {
  const { bookmarks, unreadable } = await listBookmarks(ctx.bookmarksDir)
  // Always name the folder: a mistyped PIPELINELY_BOOKMARKS_DIR reads as empty.
  const lines = [`Bookmarks in ${ctx.bookmarksDir}:`]
  lines.push(...(bookmarks.length > 0 ? bookmarks.map(formatListLine) : ['(empty: no bookmarks here)']))
  if (unreadable.length > 0) lines.push('', `${unreadable.length} unreadable file(s), left untouched:`, ...unreadable.map((name) => `  ${name}`))
  return lines.join('\n')
}

async function remove(parsed: ParsedArgs, ctx: BookmarksCliContext): Promise<string> {
  const [id] = parsed.positionals
  if (id === undefined) throw usageError('rm needs a bookmark id.')
  if ((await deleteBookmark(ctx.bookmarksDir, id)) === 'not-found') throw new Error(`Bookmark ${id} not found in ${ctx.bookmarksDir}.`)
  return `Deleted bookmark ${id}`
}

// Returns what to print; throws for anything that should exit non-zero.
export async function runBookmarksCommand(args: string[], ctx: BookmarksCliContext): Promise<string> {
  const parsed = parseArgs(args)
  switch (parsed.command) {
    case 'add-text':
      return addText(parsed, ctx)
    case 'add-last':
      return addLast(parsed, ctx)
    case 'add-session':
      return addSession(parsed, ctx)
    case 'list':
      return list(ctx)
    case 'rm':
      return remove(parsed, ctx)
    default:
      throw usageError(`Unknown command '${parsed.command}'.`)
  }
}

async function readProcessStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf-8')
}

async function main(): Promise<void> {
  const home = os.homedir()
  const ctx: BookmarksCliContext = {
    bookmarksDir: resolveBookmarksDir(process.env, home),
    projectsDir: path.join(home, '.claude', 'projects'),
    readStdin: readProcessStdin,
    env: process.env,
    now: () => new Date(),
    // Workers unset TASKS_DIR, and their tasks live in the canonical checkout.
    tasksDir: process.env.TASKS_DIR ? path.resolve(process.env.TASKS_DIR) : path.join(CANONICAL_REPO_PATH, 'tasks'),
  }
  try {
    console.log(await runBookmarksCommand(process.argv.slice(2), ctx))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) void main()
