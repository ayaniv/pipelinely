import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execa } from 'execa'
import type { ActiveProjectProgress, AttentionStatus, AutoModeOverride, BacklogItem, DoneDateGroup, Finding, MilestoneDecl, MilestoneStatus, Plan, QaCase, QaFailure, Settings, SessionMetric, Stage, StageEvent, Task } from './types.js'
import { getLiveSessionIds, getLiveTmuxSessions } from './focusTab.js'
import { SAFE_TOKEN } from './batchDispatch.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1))
  }
  return p
}

// Suppress only ENOENT — other errors (EACCES, EISDIR, etc.) propagate.
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function statSafe(filePath: string) {
  try {
    return await fs.stat(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// The orchestrator's own context meter (M1 of align-cockpit-ui-to-claude-design-v2):
// <TASKS_DIR>/ORCHESTRATOR_METRICS, same JSON shape as a task's own METRICS
// file. This is its own function rather than a reuse of parseTask's inline
// METRICS try/catch — that one deliberately swallows a malformed-JSON error
// (a task with no session running is normal there), which is the opposite of
// what a fallible parse feeding the header needs: a missing file is normal
// and stays silent, but malformed JSON or a percentage outside 0-100 is a
// real failure and must be observable, not swallowed.
export async function parseOrchestratorMetrics(tasksDir: string): Promise<number | null> {
  const raw = await readFileSafe(path.join(tasksDir, 'ORCHESTRATOR_METRICS'))
  if (raw === null) return null

  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    console.error('parseOrchestratorMetrics: malformed ORCHESTRATOR_METRICS JSON', err)
    return null
  }

  // JSON.parse succeeds on any valid JSON document, not just an object — a
  // bare `null`, a number, or an array all parse cleanly, and reading
  // .contextPct off a null value throws rather than returning undefined.
  if (data === null || typeof data !== 'object') {
    console.error('parseOrchestratorMetrics: ORCHESTRATOR_METRICS did not parse to an object', data)
    return null
  }

  const contextPct = (data as MetricsSnapshot).contextPct
  if (typeof contextPct !== 'number' || contextPct < 0 || contextPct > 100) {
    console.error('parseOrchestratorMetrics: contextPct out of range', contextPct)
    return null
  }
  return contextPct
}

// ---------------------------------------------------------------------------
// STATUS parsing
// ---------------------------------------------------------------------------

type StatusFields = Pick<Task, 'status' | 'waitingReason' | 'pausedReason' | 'reviewRef' | 'handoverSession' | 'doneNote'>

export function parseStatusContent(raw: string): StatusFields {
  const s = raw.trim()

  if (s === 'done') return { status: 'done' }

  // "done: <note>" — mirrors the "waiting: <reason>"/"paused: <reason>"
  // shape below. Without this branch a done note falls through to the
  // "working" catch-all, which is how an already-finished, already-merged
  // task kept showing as an active card on the dashboard.
  if (s.startsWith('done: ')) {
    return { status: 'done', doneNote: s.slice('done: '.length).trim() }
  }

  if (s === 'review') return { status: 'review' }

  // "shelved" — the task was taken off the board and recorded as a
  // BACKLOG.md entry. Deliberately an exact-match bare word like
  // 'done'/'review' above rather than a "shelved: <reason>" template:
  // shelving is one confirm click, with no reason to type and nowhere a
  // reason would be shown. "shelved: anything" therefore falls through to
  // the unrecognised-value catch-all, same as any other unknown STATUS.
  if (s === 'shelved') return { status: 'shelved' }

  // "review: <PR url or number>" — mirrors the existing "waiting: <reason>"
  // shape. The dev worker writes this immediately before `gh pr create`.
  if (s.startsWith('review: ')) {
    return { status: 'review', reviewRef: s.slice('review: '.length).trim() }
  }

  if (s.startsWith('waiting: ')) {
    return { status: 'waiting', waitingReason: s.slice('waiting: '.length).trim() }
  }

  // "paused: <reason>" — the user deliberately set this task aside to go do
  // something else, as opposed to "waiting: <reason>" which means the task
  // is blocked on a decision only the user can make. Kept as a distinct
  // status (rather than a waiting: text-prefix convention) so the dashboard
  // can render a "Resume" CTA without string-matching waitingReason.
  if (s.startsWith('paused: ')) {
    return { status: 'paused', pausedReason: s.slice('paused: '.length).trim() }
  }

  if (s.startsWith('handover: session #')) {
    const n = parseInt(s.slice('handover: session #'.length), 10)
    return { status: 'handover', handoverSession: isNaN(n) ? undefined : n }
  }

  // "working" or anything unrecognised → working
  return { status: 'working' }
}

// ---------------------------------------------------------------------------
// TASK.md parsing
// ---------------------------------------------------------------------------

interface TaskMdFields {
  title: string
  mode: 'investigate' | 'verify' | 'implement' | ''
  repo: string
  branch: string
}

export function parseTaskMdContent(content: string): TaskMdFields {
  const lines = content.split('\n')

  // Title: first non-empty line, strip leading # characters and whitespace
  let title = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed) {
      title = trimmed.replace(/^#+\s*/, '')
      break
    }
  }

  // Mode: LAST line matching "Mode: investigate|verify|implement". Last, not
  // first: the Reuse rule appends a "## ⚠️ NEW REQUEST" section to an existing
  // TASK.md, and the newest section is the one that describes what the worker
  // is doing now.
  let mode: 'investigate' | 'verify' | 'implement' | '' = ''
  for (const line of lines) {
    const match = line.match(/Mode:\s*(investigate|verify|implement)/i)
    if (match) {
      // Regex constrains match[1] to one of the three legal values
      mode = match[1].toLowerCase() as 'investigate' | 'verify' | 'implement'
    }
  }

  // Repo: LAST line matching "Repo:". Last, not first: the Reuse rule appends
  // a "## ⚠️ NEW REQUEST" section to an existing TASK.md, and the newest
  // section is the one that describes what the worker is doing now.
  // Capture just the repo token, stopping at whitespace / backtick / paren so
  // an inline path annotation like "- Repo: my-app (`~/Dev/my-app`)" yields
  // "my-app". Generic — no hardcoded repo list. Empty when the task declares no
  // repo.
  let repo = ''
  for (const line of lines) {
    const match = line.match(/^\s*-?\s*Repo:\s*`?([^\s`()]+)/i)
    if (match) {
      repo = match[1]
    }
  }

  // Branch: LAST line with a known branch prefix — extract the full branch
  // token. Last, not first: the Reuse rule appends a "## ⚠️ NEW REQUEST"
  // section to an existing TASK.md, and the newest section is the one that
  // describes what the worker is doing now.
  // Stop at whitespace or punctuation that can't be part of a branch name.
  let branch = ''
  for (const line of lines) {
    const match = line.match(/(?:t2a|claude|feat|fix|chore|hotfix)\/[a-zA-Z0-9._/-]+/)
    if (match) {
      branch = match[0].replace(/[.\-_]+$/, '') // strip trailing punctuation
    }
  }

  return { title, mode, repo, branch }
}

// ---------------------------------------------------------------------------
// PLAN.md parsing
// ---------------------------------------------------------------------------

const PLAN_ITEM_RE = /^- \[( |x)\] (.+)/i

function parsePlanContent(raw: string): Plan {
  const milestones = raw
    .split('\n')
    .map((line) => line.match(PLAN_ITEM_RE))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => ({ label: match[2].trim(), done: match[1].toLowerCase() === 'x' }))

  return {
    total: milestones.length,
    done: milestones.filter((m) => m.done).length,
    milestones,
  }
}

export async function parsePlan(taskDir: string): Promise<Plan | null> {
  const content = await readFileSafe(path.join(expandHome(taskDir), 'PLAN.md'))
  return content === null ? null : parsePlanContent(content)
}

// ---------------------------------------------------------------------------
// BACKLOG.md parsing — a sibling file at the top of TASKS_DIR (not a task
// subdirectory), so it gets its own parsing path rather than parseTask's.
// Format: "- [ ] <description> (<date>)" with an optional indented context
// line directly below. See the "Backlog" section of orchestrator-prompt.md.
// ---------------------------------------------------------------------------

const BACKLOG_ITEM_RE = /^- \[( |x)\] (.+)/i
const BACKLOG_DATE_RE = /\s*\(([^()]+)\)\s*$/

// A bracketed token immediately after the checkbox is the item's project —
// but only when it is a single bare token (SAFE_TOKEN, the one charset
// definition). "[needs design input] …" or "[org/repo] …" stays prose.
const BACKLOG_PROJECT_PREFIX_RE = /^\[([^\]\s]+)\]\s+(.*)$/

export function isBacklogProject(value: string): boolean {
  return SAFE_TOKEN.test(value)
}

function splitProjectAndRest(text: string): { project: string | null; rest: string } {
  const match = text.match(BACKLOG_PROJECT_PREFIX_RE)
  if (!match || !isBacklogProject(match[1])) return { project: null, rest: text }
  return { project: match[1], rest: match[2] }
}

// Splits "<description> (<date>)" into its parts; date is null when absent.
function splitDescriptionAndDate(text: string): { description: string; date: string | null } {
  const dateMatch = text.match(BACKLOG_DATE_RE)
  if (!dateMatch) return { description: text.trim(), date: null }
  return { description: text.slice(0, dateMatch.index).trim(), date: dateMatch[1].trim() }
}

// An indented `shelved: <slug>` line directly under a checklist item — the
// pointer POST /shelve/:slug writes, naming the task dir the entry came
// from. The slug charset matches batchDispatch.ts's own SAFE_TOKEN, and the
// anchored single-token shape is what keeps ordinary multi-word context
// like "shelved: because I got bored" from reading back as a pointer. A
// single-token note ("shelved: later") *would* match, which is why
// applyBacklogEdit refuses to write one rather than trusting the shape.
const BACKLOG_SHELVED_RE = /^\s+shelved:\s*([A-Za-z0-9_.-]+)\s*$/

// Optional indented detail line(s) immediately below a checklist item: the
// `shelved:` marker is lifted out as a structured field, and every other
// line joins into one context string exactly as before. Returns both plus
// the index just past them.
function readItemDetailLines(
  lines: string[],
  start: number,
): { context: string | null; shelvedSlug: string | null; next: number } {
  const context: string[] = []
  let shelvedSlug: string | null = null
  let next = start
  while (next < lines.length && /^\s+\S/.test(lines[next])) {
    const marker = lines[next].match(BACKLOG_SHELVED_RE)
    // Last one wins, matching how a duplicate key resolves anywhere else in
    // this parser — a hand-edited file with two markers is malformed either
    // way, and picking one deterministically beats refusing to parse.
    if (marker) shelvedSlug = marker[1]
    else context.push(lines[next].trim())
    next++
  }
  return { context: context.length ? context.join(' ') : null, shelvedSlug, next }
}

// Builds one BacklogItem from a BACKLOG_ITEM_RE match plus its detail lines —
// shared by parseBacklogContent and findBacklogItemAtIndex so the item shape
// (project split off before date parsing, so date parsing is untouched) is
// defined exactly once.
function buildBacklogItem(match: RegExpMatchArray, lines: string[], i: number): { item: BacklogItem; next: number } {
  const { project, rest } = splitProjectAndRest(match[2])
  const { description, date } = splitDescriptionAndDate(rest)
  const { context, shelvedSlug, next } = readItemDetailLines(lines, i + 1)
  return { item: { description, date, context, shelvedSlug, project, done: match[1].toLowerCase() === 'x' }, next }
}

// Pure/sync so parsing correctness is directly testable without touching the
// filesystem. Never throws — a garbled file just yields fewer/no items.
export function parseBacklogContent(raw: string): BacklogItem[] {
  const lines = raw.split('\n')
  const items: BacklogItem[] = []

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BACKLOG_ITEM_RE)
    if (!match) continue

    const { item, next } = buildBacklogItem(match, lines, i)
    i = next - 1
    items.push(item)
  }

  return items
}

// Scans exactly the way parseBacklogContent does, so file-order addressing
// matches it precisely, but also tracks each item's line range (matchStart
// inclusive, matchEnd exclusive of the checkbox line + its context lines) so
// a caller can splice the range back out or replace it in place. Shared by
// applyBacklogEdit and applyBacklogRemoval so both address "item N" the same
// way parseBacklogContent produces item N.
function findBacklogItemAtIndex(
  lines: string[],
  index: number,
): { start: number; end: number; item: BacklogItem } | null {
  let itemCount = 0

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BACKLOG_ITEM_RE)
    if (!match) continue

    const { item, next } = buildBacklogItem(match, lines, i)

    if (itemCount === index) return { start: i, end: next, item }
    itemCount++
    i = next - 1
  }

  return null
}

// `original` must deep-equal the item currently at `index` — a mismatch
// means BACKLOG.md changed underneath the edit (backlogWatcher fired from a
// dispatch, or another edit/removal landed first) since the client last saw
// it, so the caller should refuse rather than silently acting on the wrong
// line.
function matchesOriginal(item: BacklogItem, original: BacklogItem): boolean {
  return (
    item.description === original.description &&
    item.date === original.date &&
    item.context === original.context &&
    // The pointer is part of the item's identity: an edit racing a shelve
    // must conflict rather than rewrite the wrong line.
    item.shelvedSlug === original.shelvedSlug &&
    item.done === original.done &&
    // The project is part of the item's identity too: an edit racing a
    // retag must conflict rather than rewrite the wrong line.
    item.project === original.project
  )
}

export type BacklogLineResult =
  | { ok: true; line: string }
  | { ok: false; error: 'invalid-project' | 'project-collision' }

// The one place a backlog checklist line is built from its fields — shared
// by applyBacklogEdit, applyBacklogShelveEntry and the backfill applier, so
// they can't drift into writing the tag differently. Refuses any line that
// wouldn't parse back to the project it was given.
export function formatBacklogItemLine(
  done: boolean, project: string | null, description: string, date: string | null,
): BacklogLineResult {
  if (project !== null && !isBacklogProject(project)) return { ok: false, error: 'invalid-project' }
  const rest = `${project ? `[${project}] ` : ''}${description}`
  // Only an UNTAGGED line whose description starts with a bare bracket token
  // can fail this: "[WIP] foo" would read back as project WIP. A tagged line
  // "[p] [WIP] foo" round-trips (the parser only lifts the first token).
  if (splitProjectAndRest(rest).project !== project) return { ok: false, error: 'project-collision' }
  return { ok: true, line: `- [${done ? 'x' : ' '}] ${rest}${date ? ` (${date})` : ''}` }
}

export interface BacklogEditRequest {
  description: string
  date: string | null
  context: string | null
  project: string | null
}

// 'marker-collision' means the submitted context would itself parse back as
// a `shelved:` pointer — see the guard in applyBacklogEdit below.
export type BacklogEditResult =
  | { ok: true; content: string }
  | { ok: false; error: 'out-of-range' | 'conflict' | 'marker-collision' | 'invalid-project' | 'project-collision' }

// Rewrites a single backlog line in place, preserving the "- [ ] <description>
// (<date>)" + indented-context-line format parseBacklogContent expects.
export function applyBacklogEdit(
  raw: string,
  index: number,
  original: BacklogItem,
  updates: BacklogEditRequest,
): BacklogEditResult {
  const lines = raw.split('\n')
  const found = findBacklogItemAtIndex(lines, index)
  if (!found) return { ok: false, error: 'out-of-range' }
  const { start: matchStart, end: matchEnd, item: matchedItem } = found

  if (!matchesOriginal(matchedItem, original)) return { ok: false, error: 'conflict' }

  // BACKLOG.md is a single-line-per-field format (see readContextLines /
  // parseBacklogContent above), but the edit form's context field is a
  // <textarea> that lets the user paste or type embedded newlines. Collapse
  // any embedded newlines (and surrounding whitespace) to a single space
  // before writing so a multi-line paste can't (a) leave an orphan line that
  // readContextLines won't recognize as context, silently dropped from all
  // future parses, or (b) inject a line starting with "- [ ] " that gets
  // parsed back as a brand-new phantom backlog item.
  const oneLine = (s: string) => s.trim().replace(/\s*\n+\s*/g, ' ')

  const description = oneLine(updates.description)
  const date = updates.date ? oneLine(updates.date) : updates.date
  const context = updates.context ? oneLine(updates.context) : updates.context

  // A single-token context note like "shelved: later" would be written as an
  // indented line that readItemDetailLines reads back as a *pointer*,
  // silently turning an ordinary idea into a Resume row aimed at a task dir
  // that never existed. Refuse it rather than trusting the marker's shape to
  // be un-typeable — multi-word prose after "shelved:" can't match, so this
  // only ever rejects the genuinely ambiguous single-token form.
  if (context && BACKLOG_SHELVED_RE.test(`  ${context}`)) {
    return { ok: false, error: 'marker-collision' }
  }

  const lineResult = formatBacklogItemLine(matchedItem.done, updates.project, description, date)
  if (!lineResult.ok) return lineResult

  const newLines = [lineResult.line]
  if (context) newLines.push(`  ${context}`)
  // Re-emitted from the matched on-disk item, never from `updates` — so
  // editing a shelved entry's wording can't orphan the task dir it points
  // at, and BacklogEditRequest carrying no shelvedSlug of its own means the
  // edit form can neither forge a pointer onto an ordinary item nor erase
  // one off a shelved item.
  if (matchedItem.shelvedSlug) newLines.push(`  shelved: ${matchedItem.shelvedSlug}`)

  const rebuilt = [...lines.slice(0, matchStart), ...newLines, ...lines.slice(matchEnd)]
  return { ok: true, content: rebuilt.join('\n') }
}

export interface BacklogShelveEntry {
  description: string
  date: string
  slug: string
  project: string | null
}

export type BacklogShelveResult =
  | { ok: true; content: string }
  | { ok: false; error: 'already-shelved' | 'project-collision' }

// Appends the BACKLOG.md entry POST /shelve/:slug writes when a task leaves
// the board: the ordinary checklist line plus one indented `shelved: <slug>`
// marker, and nothing else — no reason, because shelving captures none.
// Pure and sync like the two appliers above, and never throws: a refusal is
// returned so the route decides the status code. `raw` of null (no
// BACKLOG.md yet) is the caller's job to turn into a header first.
export function applyBacklogShelveEntry(raw: string, entry: BacklogShelveEntry): BacklogShelveResult {
  // One pointer per task dir, always — a second entry for the same slug
  // would give a single task two Resume buttons, only one of which could win.
  if (parseBacklogContent(raw).some((item) => item.shelvedSlug === entry.slug)) {
    return { ok: false, error: 'already-shelved' }
  }

  // `invalid-project` can't occur here — the route only ever passes a
  // validated token or null (see isBacklogProject(task.repo) at the call
  // site) — but project-collision can, for an untagged title like "[WIP] …".
  const lineResult = formatBacklogItemLine(false, entry.project, entry.description, entry.date)
  if (!lineResult.ok) return { ok: false, error: 'project-collision' }

  const withNewline = raw.endsWith('\n') ? raw : `${raw}\n`
  return {
    ok: true,
    content: `${withNewline}${lineResult.line}\n  shelved: ${entry.slug}\n`,
  }
}

export type BacklogResumeLookup =
  | { ok: true; slug: string }
  | { ok: false; error: 'out-of-range' | 'conflict' | 'not-shelved' }

// Resolves the task dir a shelved backlog entry points at, applying exactly
// the same index-addressing and `original` concurrency guard the two
// appliers below do — POST /backlog/resume/:index has to validate the entry
// before it writes the task's STATUS and only removes the line afterwards,
// so it can't get both from applyBacklogRemoval alone. Sharing this rather
// than re-deriving it in the route is what keeps "item N" meaning the same
// thing to the parser, the appliers and the resume route.
export function findResumableBacklogSlug(
  raw: string,
  index: number,
  original: BacklogItem,
): BacklogResumeLookup {
  const found = findBacklogItemAtIndex(raw.split('\n'), index)
  if (!found) return { ok: false, error: 'out-of-range' }
  if (!matchesOriginal(found.item, original)) return { ok: false, error: 'conflict' }
  // An ordinary, never-dispatched item has nothing to resume — Run is its
  // path, and it dispatches fresh.
  if (!found.item.shelvedSlug) return { ok: false, error: 'not-shelved' }
  return { ok: true, slug: found.item.shelvedSlug }
}

export type BacklogRemoveResult =
  | { ok: true; content: string }
  | { ok: false; error: 'out-of-range' | 'conflict' }

// Deletes a single backlog item's lines (its checkbox line + indented
// context line, if any) entirely, same index-addressing and concurrency
// guard as applyBacklogEdit.
export function applyBacklogRemoval(raw: string, index: number, original: BacklogItem): BacklogRemoveResult {
  const lines = raw.split('\n')
  const found = findBacklogItemAtIndex(lines, index)
  if (!found) return { ok: false, error: 'out-of-range' }
  const { start: matchStart, end: matchEnd, item: matchedItem } = found

  if (!matchesOriginal(matchedItem, original)) return { ok: false, error: 'conflict' }

  const rebuilt = [...lines.slice(0, matchStart), ...lines.slice(matchEnd)]
  return { ok: true, content: rebuilt.join('\n') }
}

// Never throws — a missing or malformed BACKLOG.md just means an empty
// backlog, not a broken dashboard.
export async function parseBacklog(tasksDir: string): Promise<BacklogItem[]> {
  const content = await readFileSafe(path.join(expandHome(tasksDir), 'BACKLOG.md'))
  if (content === null) return []
  try {
    return parseBacklogContent(content)
  } catch (err) {
    console.error('[taskParser] failed to parse BACKLOG.md:', err)
    return []
  }
}

export type BacklogBackfillResult =
  | { ok: true; content: string; tagged: string[]; unmatched: string[]; unusedKeys: string[] }
  | { ok: false; error: 'invalid-project'; key: string }

// A pure, unit-tested applier that tags pre-existing, untagged BACKLOG.md
// entries with a project — see scripts/backfill-backlog-projects.ts for the
// CLI that drives this against the real file. mapping: exact parsed
// description → project. Tagged items are skipped (idempotent; never
// overwrites a tag). Each rewrite goes through formatBacklogItemLine,
// preserving checkbox, date, context and shelved lines.
export function applyBacklogProjectBackfill(
  raw: string, mapping: ReadonlyMap<string, string>,
): BacklogBackfillResult {
  // Refuses the whole run before anything is rewritten.
  for (const [key, project] of mapping) {
    if (!isBacklogProject(project)) return { ok: false, error: 'invalid-project', key }
  }

  const lines = raw.split('\n')
  const outputLines: string[] = []
  const tagged: string[] = []
  const unmatched: string[] = []
  const usedKeys = new Set<string>()

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(BACKLOG_ITEM_RE)
    if (!match) {
      outputLines.push(lines[i])
      continue
    }

    const { item, next } = buildBacklogItem(match, lines, i)
    const itemLines = lines.slice(i, next)
    const mappedProject = item.project === null ? mapping.get(item.description) : undefined

    if (mappedProject === undefined) {
      if (item.project === null) unmatched.push(item.description)
      outputLines.push(...itemLines)
    } else {
      usedKeys.add(item.description)
      const lineResult = formatBacklogItemLine(item.done, mappedProject, item.description, item.date)
      if (lineResult.ok) {
        tagged.push(item.description)
        outputLines.push(lineResult.line, ...itemLines.slice(1))
      } else {
        // A project-collision (the description itself starts with a bracket
        // token) means tagging would corrupt the line — leave it untagged
        // rather than write something unparseable.
        console.error(`[applyBacklogProjectBackfill] refused to tag "${item.description}": ${lineResult.error}`)
        outputLines.push(...itemLines)
      }
    }

    i = next - 1
  }

  const unusedKeys = [...mapping.keys()].filter((key) => !usedKeys.has(key))

  return { ok: true, content: outputLines.join('\n'), tagged, unmatched, unusedKeys }
}

// ---------------------------------------------------------------------------
// SETTINGS.json / AUTO_MODE parsing
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: Settings = { autoMode: false }

// A hand-editable file that a human can and will break. Anything
// unparseable falls back to DEFAULT_SETTINGS (auto OFF) and logs — the
// dashboard's whole refresh loop runs through parseAllTasks, so a thrown
// parse here would take every card on the board down with it.
export function parseSettingsContent(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS
  try {
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return DEFAULT_SETTINGS
    const autoMode = (parsed as { autoMode?: unknown }).autoMode
    if (typeof autoMode !== 'boolean') return DEFAULT_SETTINGS
    return { autoMode }
  } catch (err) {
    console.error('[taskParser] failed to parse SETTINGS.json:', err)
    return DEFAULT_SETTINGS
  }
}

export async function readSettings(tasksDir: string): Promise<Settings> {
  const content = await readFileSafe(path.join(expandHome(tasksDir), 'SETTINGS.json'))
  return parseSettingsContent(content)
}

// 'auto' / 'manual' (case- and whitespace-insensitive); anything else,
// including an absent file, is 'inherit'. Same fail-soft direction: a
// typo'd override reverts to the global default rather than silently
// meaning its opposite.
export function parseAutoModeOverride(raw: string | null): AutoModeOverride {
  const normalized = raw?.trim().toLowerCase()
  if (normalized === 'auto') return 'auto'
  if (normalized === 'manual') return 'manual'
  return 'inherit'
}

// The global switch is a plain boolean; only the per-task override is
// tri-state, because "follow the global default" is a genuine third choice
// rather than an absent answer.
export function computeEffectiveAutoMode(
  override: AutoModeOverride,
  globalDefault: boolean,
): boolean {
  if (override === 'auto') return true
  if (override === 'manual') return false
  return globalDefault
}

// ---------------------------------------------------------------------------
// TIMELINE parsing — append-only stage transitions
// ---------------------------------------------------------------------------

export const STAGES: Stage[] = [
  'planning', 'plan-review', 'dev', 'code-review', 'comment-fix', 'qa', 'qa-fixes', 'merge',
]

const STAGE_SET = new Set<string>(STAGES)

// TIMELINE is append-only: "<ISO timestamp> <stage-slug> [note]", one entry per
// line. Anything unparseable is skipped rather than thrown on — a worker
// appending a stray line must never take the whole dashboard down.
export function parseTimelineContent(raw: string): StageEvent[] {
  const events: StageEvent[] = []

  for (const line of raw.split('\n')) {
    const match = line.trim().match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/)
    if (!match) continue

    const [, at, stage, note] = match
    if (!STAGE_SET.has(stage)) continue
    if (isNaN(Date.parse(at))) continue

    events.push({ stage: stage as Stage, at, note: note?.trim() || null })
  }

  return events
}

// ---------------------------------------------------------------------------
// Stage inference — computeStage and its inputs
// ---------------------------------------------------------------------------

// The code review's verdict, read out of the report file the review wrapper writes.
// Checked in this order because a report can discuss an approved approach while
// still demanding changes — the stricter verdict has to win.
export function parseVerdict(raw: string): 'approved' | 'changes-required' | null {
  if (/CHANGES\s+REQUIRED/i.test(raw)) return 'changes-required'
  if (/\bAPPROVED\b/i.test(raw)) return 'approved'
  return null
}

// Task.reviewRef is a PR URL when the worker recorded one via `gh pr
// create`, but can also be a bare number — mirrors public/index.html's own
// prNumberFromReviewRef (a plain script with no bundler can't import this
// module — see computeNextStageCta's client-side counterpart for the same
// constraint), used there only for the Open-PR link's href. The server-side
// merge route below needs its own copy since it's the one deciding which PR
// number actually gets merged.
export function parsePrNumberFromReviewRef(ref: string | undefined): string | null {
  if (!ref) return null
  const urlMatch = ref.match(/\/pull\/(\d+)/)
  if (urlMatch) return urlMatch[1]
  return /^\d+$/.test(ref.trim()) ? ref.trim() : null
}

// reviewRef only ever gets set by STATUS's legacy "review: <ref>" line
// (see parseStatusContent above) — no current skill writes that; cockpit-
// dev's SKILL.md instead documents the 'dev' stage's TIMELINE note as
// "<PR note>" (e.g. "PR #42 open", or a full .../pull/42 URL) and moves
// STATUS straight to "waiting: PR open, ready for CR". That note is the
// PR number's actual, currently-used source for any task using the modern
// TIMELINE-driven pipeline — reviewRef is checked first only so a task dir
// still on the old convention keeps working. Scans 'dev' entries newest to
// oldest and returns the first PR reference found, rather than only ever
// checking the single latest note. This still mirrors computeStage/
// computeNextStageCta's "latest round wins" precedent for the case that
// matters — a genuinely new dev round that opens its own different PR has
// its own note with its own PR reference, found first — but a follow-up
// dev note that's just more work on the same PR (a rebase, a conflict fix)
// and mentions no PR of its own no longer nulls out the reference an
// earlier note in the same run already established.
export function findPrNumber(task: Pick<Task, 'reviewRef' | 'stageHistory'>): string | null {
  const fromReviewRef = parsePrNumberFromReviewRef(task.reviewRef)
  if (fromReviewRef) return fromReviewRef

  const devEvents = task.stageHistory.filter((e) => e.stage === 'dev' && e.note)
  for (let i = devEvents.length - 1; i >= 0; i--) {
    const note = devEvents[i].note!
    const urlMatch = note.match(/\/pull\/(\d+)/)
    if (urlMatch) return urlMatch[1]
    const hashMatch = note.match(/#(\d+)/)
    if (hashMatch) return hashMatch[1]
  }
  return null
}

// QA_REPORT.md's headline result. Recognises "<n> of <m> cases failed" and the
// all-passed phrasing; anything else reads as "no result", which keeps a
// half-written report from moving the card.
export function parseQaResult(raw: string): { failed: number } | null {
  const failed = raw.match(/(\d+)\s+of\s+\d+\s+cases?\s+failed/i)
  if (failed) return { failed: parseInt(failed[1], 10) }

  if (/all\s+\d+\s+cases?\s+passed/i.test(raw)) return { failed: 0 }

  return null
}

// Re-exported so callers can import Finding from either module — see the
// Stage/StageEvent/SessionMetric convention above (defined in types.ts,
// re-used here).
export type { Finding }

// A bullet line inside "### Must Fix" / "### Should Fix" / "### Suggestions"
// (or QA_REPORT.md's "### Failing Cases" / "### Passing Cases" — parseQaCases
// below reuses this same shape):
//   - [Category] Description text — `path/to/file.ts:42`
// Note the separator before the location is an em dash (" — "), not a
// hyphen. The documented format backtick-quotes the trailing location, but a
// bullet that omits the backticks — e.g. "— path/to/file.ts:42" — is
// tolerated too: group 3 just captures whatever follows the em dash, and
// parseLocationTail below decides whether it actually looks like a location
// (backtick-quoted or bare) rather than requiring backticks up front. A
// bullet can cite more than one location (e.g. the same bug duplicated in
// two places) — the tail then holds multiple comma/"and"-separated
// locations, e.g. `` `a.ts:1` and `b.ts:2` `` or `a.ts:1` and `b.ts:2`
// (bare). Skills should still write the backtick-quoted form — see
// pipelinely-qa/pipelinely-cr's own instructions — this leniency only keeps a
// format slip from silently dropping the bullet.
//
// Group 2 (description) is greedy, not lazy: a description can legitimately
// contain its own em dash (e.g. "The state filter is gone — project is the
// only filter dimension"), and greedy backtracking finds the LAST " — " in
// the line as the location separator rather than the first — confirmed
// against pipelinely-dashboard-redesign-m0's real QA_REPORT.md, which has
// exactly this shape twice.
const FINDING_BULLET_RE = /^- \[([^\]]+)\]\s+(.+)\s+—\s+(.+?)\s*$/

// One location segment, backtick-quoted (the documented form) or bare — a
// relative path ending in a file extension, with an optional trailing
// :line or :line-line range. Deliberately narrow for the bare form: without
// requiring a dotted extension, ordinary prose that happens to follow an em
// dash (not a location at all) would false-positive as one.
const LOCATION_SEGMENT_RE = /^(?:`[^`]+`|[\w./-]+\.\w+(?::\d+(?:-\d+)?)?)$/

// Splits a FINDING_BULLET_RE tail (group 3) into individual location
// segments on ","/" and ", and confirms every segment actually looks like a
// location (LOCATION_SEGMENT_RE) rather than trailing prose that happens to
// follow an em dash. Returns null — not a partial result — when any segment
// fails, so a genuinely non-matching bullet is skipped entirely, the same
// as before this leniency was added (see the parse-mismatch counting in
// parseFindings/parseQaCases, which is what catches that case now).
function parseLocationTail(tail: string): string | null {
  // ", and " must split as one separator, not a bare "," leaving a stray
  // "and " prefix on the next segment — the optional "(?:and\s+)?" after
  // the comma covers that combined form; "\s+and\s+" alone still covers a
  // plain two-item "a and b" with no comma.
  const segments = tail.split(/\s*,\s*(?:and\s+)?|\s+and\s+/).filter(Boolean)
  if (segments.length === 0) return null
  if (!segments.every((s) => LOCATION_SEGMENT_RE.test(s))) return null
  return segments.map((s) => (s.startsWith('`') ? s.slice(1, -1) : s)).join(', ')
}

// "### Must Fix (3)" -> ["Must Fix", 3] for every "(N)"-suffixed heading in
// the doc — shared by findFindingsParseMismatch/findQaCasesParseMismatch
// below, since task-pr-review.md and QA_REPORT.md both declare a bullet
// count on the section heading.
function declaredSectionCounts(raw: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const match of raw.matchAll(/^#{1,6}\s+(.+?)\s*\((\d+)\)\s*$/gim)) {
    counts.set(match[1].trim(), parseInt(match[2], 10))
  }
  return counts
}

// Compares each severity section's declared "(N)" heading count against how
// many findings parseFindings actually extracted for it. A bullet whose
// tail still doesn't match FINDING_BULLET_RE/parseLocationTail after the
// leniency above — or any other format drift — shows up here as a mismatch
// instead of silently vanishing; see parseTask's console.error and the CR
// tab's warning banner, both driven by this.
export function findFindingsParseMismatch(raw: string, findings: Finding[]): string[] {
  const declared = declaredSectionCounts(raw)
  const labels: [Finding['severity'], string][] = [
    ['must', 'Must Fix'],
    ['should', 'Should Fix'],
    ['suggestion', 'Suggestions'],
  ]
  const mismatches: string[] = []
  for (const [severity, label] of labels) {
    const declaredCount = declared.get(label)
    if (declaredCount === undefined) continue
    const parsedCount = findings.filter((f) => f.severity === severity).length
    if (declaredCount !== parsedCount) {
      mismatches.push(`${label}: header says ${declaredCount}, parsed ${parsedCount}`)
    }
  }
  return mismatches
}

// Parses task-pr-review.md's "### Must Fix (N)" / "### Should Fix (N)" /
// "### Suggestions (N)" bullet lists into individual findings. Missing
// sections (the skill omits empty ones) produce no findings for that
// severity, never an error. A bullet line that doesn't match the expected
// shape is skipped, not thrown on — same philosophy as this file's other
// parsers (parseTimelineContent, parseQaResult).
export function parseFindings(raw: string): Finding[] {
  const findings: Finding[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const heading = lines[i].match(/^### (.+)/)
    if (!heading) {
      i++
      continue
    }

    let severity: Finding['severity'] | null = null
    if (heading[1].startsWith('Must Fix')) severity = 'must'
    else if (heading[1].startsWith('Should Fix')) severity = 'should'
    else if (heading[1].startsWith('Suggestions')) severity = 'suggestion'
    i++

    if (!severity) continue

    // Scan this section's body until the next heading or a "---" divider.
    while (i < lines.length && !lines[i].startsWith('#') && lines[i].trim() !== '---') {
      const bullet = lines[i].match(FINDING_BULLET_RE)
      const location = bullet ? parseLocationTail(bullet[3]) : null
      if (bullet && location !== null) {
        findings.push({
          severity,
          category: bullet[1].trim(),
          description: bullet[2].trim(),
          location,
        })
      }
      i++
    }
  }

  return findings
}

// Merges parsed findings with persisted selection state from TRIAGE.json.
// `selectedIndices` is null when no TRIAGE.json exists yet — in that case,
// default to selecting every 'must' finding and none of the 'should'/
// 'suggestion' ones (the sensible starting point: block-worthy issues
// pre-checked, optional ones opt-in). When TRIAGE.json exists, its explicit
// array governs even if empty (the human deliberately unchecked everything).
export function applyTriageSelection(
  findings: Finding[],
  selectedIndices: number[] | null,
): (Finding & { selected: boolean })[] {
  if (selectedIndices === null) {
    return findings.map((f) => ({ ...f, selected: f.severity === 'must' }))
  }
  const selected = new Set(selectedIndices)
  return findings.map((f, i) => ({ ...f, selected: selected.has(i) }))
}

// Re-exported for the same reason as Finding above.
export type { QaFailure, QaCase }

// Parses QA_REPORT.md's "### Failing Cases (N)" bullet list into individual
// failures. Same bullet shape as parseFindings — [Label] Description —
// `location` — but no severity tiering: a QA case either failed or it
// didn't, there's no must/should split for a bug reproduction. Built on top
// of parseQaCases (below), which scans the same "Failing Cases"/"Passing
// Cases" sections; this just keeps the failing ones and drops the `passed`
// flag no caller of this function needs.
export function parseQaFailures(raw: string): QaFailure[] {
  return parseQaCases(raw)
    .filter((c) => !c.passed)
    .map(({ label, description, location }) => ({ label, description, location }))
}

// Parses QA_REPORT.md's "### Failing Cases (N)" and "### Passing Cases (N)"
// bullet lists together into the full case list — every case QA ran, not
// just the failures parseQaFailures above surfaces. Same bullet shape and
// same skip-what-doesn't-match philosophy; sections are emitted in file
// order, which is Failing before Passing per the format pipelinely-qa writes.
export function parseQaCases(raw: string): QaCase[] {
  const cases: QaCase[] = []
  const lines = raw.split('\n')
  let i = 0

  while (i < lines.length) {
    const heading = lines[i].match(/^### (.+)/)
    if (!heading) {
      i++
      continue
    }

    let passed: boolean | null = null
    if (heading[1].startsWith('Failing Cases')) passed = false
    else if (heading[1].startsWith('Passing Cases')) passed = true
    i++
    if (passed === null) continue

    while (i < lines.length && !lines[i].startsWith('#') && lines[i].trim() !== '---') {
      const bullet = lines[i].match(FINDING_BULLET_RE)
      const location = bullet ? parseLocationTail(bullet[3]) : null
      if (bullet && location !== null) {
        cases.push({
          label: bullet[1].trim(),
          description: bullet[2].trim(),
          location,
          passed,
        })
      }
      i++
    }
  }

  return cases
}

// Compares "### Failing Cases (N)" / "### Passing Cases (N)"'s declared
// count against how many cases parseQaCases actually extracted for that
// section — same idea and same shared declaredSectionCounts as
// findFindingsParseMismatch above, just keyed by passed/failed instead of
// severity.
export function findQaCasesParseMismatch(raw: string, cases: QaCase[]): string[] {
  const declared = declaredSectionCounts(raw)
  const labels: [boolean, string][] = [
    [false, 'Failing Cases'],
    [true, 'Passing Cases'],
  ]
  const mismatches: string[] = []
  for (const [passed, label] of labels) {
    const declaredCount = declared.get(label)
    if (declaredCount === undefined) continue
    const parsedCount = cases.filter((c) => c.passed === passed).length
    if (declaredCount !== parsedCount) {
      mismatches.push(`${label}: header says ${declaredCount}, parsed ${parsedCount}`)
    }
  }
  return mismatches
}

// Merges parsed QA failures with persisted selection state from
// QA_TRIAGE.json. Unlike applyTriageSelection, there's no severity to key a
// default off of — when QA_TRIAGE.json doesn't exist yet, every failing case
// starts selected (all of them are real failures worth a look, not a mix of
// blocking/optional). An explicit array governs even if empty.
export function applyQaTriageSelection(
  failures: QaFailure[],
  selectedIndices: number[] | null,
): (QaFailure & { selected: boolean })[] {
  if (selectedIndices === null) {
    return failures.map((f) => ({ ...f, selected: true }))
  }
  const selected = new Set(selectedIndices)
  return failures.map((f, i) => ({ ...f, selected: selected.has(i) }))
}

export interface StageInput {
  status: Task['status']
  mode: Task['mode']
  stageHistory: StageEvent[]
  hasTechDesign: boolean
  reviewVerdict: 'approved' | 'changes-required' | null
  qaResult: { failed: number } | null
}

// Which of the eight stages a task is in, or null for tasks that have finished
// and moved to the Done tab.
//
// Order of checks: done status wins first and unconditionally — a finished
// task gets stage: null no matter what TIMELINE's last line says. A handover
// status does NOT win here — "handover" means a new session is continuing the
// same task, not that it finished, so it falls through to the normal
// TIMELINE-based computation below like any other active status. Only past
// the done gate does TIMELINE win when it exists: a worker that recorded its
// stage knows better than anything inferred from file presence. Everything
// below TIMELINE is the fallback for the task dirs that predate the
// pipeline — deliberately ending at 'dev', so an old task dir with none of
// these files looks exactly like what it is rather than like a half-finished
// pipeline.
//
// The pipeline runs CR before QA (Dev → CR → CR fixes → QA → QA fixes →
// Merge), so a CR approval hands off to QA rather than being terminal, and a
// clean QA result is what's terminal (→ merge) rather than handing to CR.
export function computeStage(input: StageInput): Stage | null {
  if (input.status === 'done') return null

  const last = input.stageHistory[input.stageHistory.length - 1]
  if (last) return last.stage

  if (input.reviewVerdict === 'changes-required') return 'comment-fix'
  if (input.reviewVerdict === 'approved') return 'qa'

  if (input.qaResult) return input.qaResult.failed > 0 ? 'qa-fixes' : 'merge'

  if (input.status === 'review') return 'code-review'

  if (input.hasTechDesign) return 'plan-review'
  if (input.mode === 'investigate') return 'planning'

  return 'dev'
}

// ---------------------------------------------------------------------------
// Next-step pipeline CTA — which /cockpit-<stage> skill to stage next
// ---------------------------------------------------------------------------

// Deliberately keyed off waitingReason, not task.stage — see tech-design.md's
// "Why waitingReason, not task.stage". task.stage (computeStage above) reads
// TIMELINE's last entry, which a stage only appends once it hands back to the
// human — so a task mid-stage, waiting on an unrelated clarifying question,
// would misreport its stage as "just finished the previous one" and offer a
// CTA that double-dispatches an already-running session. Each STATUS phrase
// below is unique and written in the same breath as the handoff itself, so
// matching on it side-steps that staleness entirely.
//
// Exported (rather than module-private) solely so taskParser.test.ts can
// assert it stays in lockstep with its byte-for-byte hand-maintained mirror
// in public/index.html — the plain-script frontend has no bundler to import
// this module directly, so the two copies must be kept in sync by hand, and
// a diverging edit to only one side otherwise fails silently (see the
// "client/server stage tables stay in lockstep" test).
export const NEXT_STAGE_BY_WAITING_REASON: { marker: string; stage: Stage }[] = [
  { marker: 'plan ready for review', stage: 'plan-review' },
  { marker: 'plan reviewed, ready for dev', stage: 'dev' },
  { marker: 'PR open, ready for CR', stage: 'code-review' },
  { marker: 'triage and dispatch cr-fixes', stage: 'comment-fix' },
  { marker: 'CR approved, ready for QA', stage: 'qa' },
  { marker: 'comments addressed, ready for QA', stage: 'qa' },
  { marker: 'triage and dispatch qa-fixes', stage: 'qa-fixes' },
  { marker: 'fixes pushed, ready to re-run QA', stage: 'qa' },
  // "QA passed, ready to merge" deliberately has no entry — merge has a
  // skill (pipelinely-merge) but no staged CTA and no waiting-reason marker:
  // it stays a decision-waiting state, not a pipeline handoff, on purpose
  // (see STAGE_SKILL below and pipelinely-merge-skill's tech-design.md,
  // decision 2 and "The human gate is preserved").
]

export interface NextStageCta {
  stage: Stage
}

// The table entry a task's waitingReason matches, or null. Extracted from
// computeNextStageCta's body so computeAutoDispatch can see WHICH marker
// matched without running the search a second time — one search, one meaning.
function matchWaitingReason(
  task: Pick<Task, 'status' | 'waitingReason'>,
): { marker: string; stage: Stage } | null {
  if (task.status !== 'waiting' || !task.waitingReason) return null
  return NEXT_STAGE_BY_WAITING_REASON.find((m) => task.waitingReason!.includes(m.marker)) ?? null
}

// Unchanged behavior and unchanged return SHAPE. The shape matters: existing
// assertions in taskParser.test.ts are toEqual({ stage: … }) deep equality
// checks that a new field would fail, and the client's hand-mirrored copy in
// public/index.html returns { stage } too — adding a `marker` field here
// would break both for no gain, since only the auto-mode key ever needs it.
export function computeNextStageCta(task: Pick<Task, 'status' | 'waitingReason'>): NextStageCta | null {
  const match = matchWaitingReason(task)
  return match ? { stage: match.stage } : null
}

// The stages auto mode must never dispatch into, whatever the setting says.
// Both are triage: a checklist of findings where deciding what is worth
// fixing IS the work, and applyTriageSelection/applyQaTriageSelection exist
// precisely so a human ticks the boxes first. Merge needs no entry here —
// it has no NEXT_STAGE_BY_WAITING_REASON marker and no STAGE_SKILL entry
// ("the one stage with no skill, deliberately"), so computeNextStageCta
// already returns null for it and it can never reach this list.
//
// A deny-list, not an allow-list of auto-eligible stages: a stage added to
// the pipeline later is then manual until someone deliberately says
// otherwise, which is the safe direction for a mechanism that spends money
// and opens PRs unattended.
export const MANUAL_ONLY_STAGES: Stage[] = ['comment-fix', 'qa-fixes']

// What auto mode may do for this task right now, or null. ONE function
// returning both halves rather than a stage-getter plus a key-getter: the pass
// needs the stage (to dispatch) and the key (to edge-trigger) for the same
// task at the same moment, and two entry points would run the table lookup
// twice and could disagree about whether this task is eligible at all.
export interface AutoDispatch {
  stage: Stage
  key: string
}

export function computeAutoDispatch(
  task: Pick<Task, 'status' | 'waitingReason'>,
): AutoDispatch | null {
  const match = matchWaitingReason(task)
  if (!match || MANUAL_ONLY_STAGES.includes(match.stage)) return null
  return { stage: match.stage, key: `${match.stage}:${match.marker}` }
}

// A queued milestone has no dispatched Task of its own yet, so
// computeNextStageCta (which reads a Task's own waitingReason) can't answer
// "is this one ready to start". Plan review is a required gate before ANY
// milestone starts, including a root one with no needs: — a project can't
// reach Dev without it once. Mirrors the "ready" branch already inline in
// computeAttentionStatus (same file) — reuse the same reasoning rather than
// duplicating a second copy of it in public/index.html.
export function isMilestoneReadyForDev(
  m: Pick<MilestoneStatus, 'needs' | 'state'>,
  byId: Map<string, MilestoneStatus>,
  parentStageHistory: StageEvent[],
): boolean {
  if (m.state !== 'queued') return false
  if (!parentStageHistory.some((e) => e.stage === 'plan-review')) return false
  return m.needs.every((id) => byId.get(id)?.state === 'done')
}

// Which session a stage's skill invocation targets — shared by
// computeNextStageCta's client-side counterpart and the server's
// POST /stage-skill/:slug route, so client and server can never disagree
// about which session a stage targets. 'planning' and 'merge' are
// deliberately absent: a card only exists once planning has already been
// dispatched (nothing to "start planning" from a task's own detail view),
// and merge — despite now having a real skill, /pipelinely-merge — has no
// staged CTA here on purpose: the Merge button already does the merge
// in-process, one click, and a staged `/pipelinely-merge <slug>` CTA would be
// a third path to the same action (pipelinely-merge-skill's tech-design.md,
// decision 2).
export const STAGE_SKILL: Partial<Record<Stage, { skillName: string; target: 'orchestrator' | 'own-session' }>> = {
  'plan-review': { skillName: 'plan-review', target: 'orchestrator' },
  dev: { skillName: 'dev', target: 'orchestrator' },
  'code-review': { skillName: 'cr', target: 'orchestrator' },
  'comment-fix': { skillName: 'cr-fixes', target: 'own-session' },
  qa: { skillName: 'qa', target: 'orchestrator' },
  'qa-fixes': { skillName: 'qa-fixes', target: 'own-session' },
}

// The exact text staged into a session. No slug at all for qa-fixes/cr-fixes
// — matches each skill's own documented form ("invoke directly inside the
// task's own tab as /pipelinely-qa-fixes", no argument).
export function composeStageCommand(skillName: string, slugArg: string | null): string {
  return slugArg ? `/pipelinely-${skillName} ${slugArg}` : `/pipelinely-${skillName}`
}

// POST /skip-stage/:slug's table — the escape hatch for a QA-fixes/CR-fixes
// checklist with nothing worth fixing (applyTriageSelection/
// applyQaTriageSelection default nothing selected once every item is
// deliberately unchecked, and the Fix CTA requires selected > 0, so without
// this a task with no findings worth acting on has no way to move forward).
// `nextWaitingReason` matches, verbatim, the exact STATUS phrase that
// stage's own real worker would have written on completion (see
// NEXT_STAGE_BY_WAITING_REASON above) — so skipping needs no changes to
// computeStage/computeNextStageCta at all; it just writes the same two
// files a worker would, by hand.
export const SKIP_STAGE: Partial<Record<Stage, { timelineNote: string; nextWaitingReason: string }>> = {
  'comment-fix': {
    timelineNote: 'skipped — no comments selected for fixing',
    nextWaitingReason: 'comments addressed, ready for QA',
  },
  'qa-fixes': {
    timelineNote: 'skipped — no findings selected for fixing',
    nextWaitingReason: 'QA passed, ready to merge',
  },
}

// ---------------------------------------------------------------------------
// Multi-milestone project progress (global board-wide bar)
// ---------------------------------------------------------------------------

const MILESTONE_SLUG_RE = /^(.+)-m(\d+)$/

export interface MilestoneSlugInfo {
  projectBase: string
  milestoneNumber: number
}

// Slugs like "overlap-m2" belong to project "overlap", milestone 2. Slugs
// without a trailing "-m<N>" (e.g. "cockpit-branch-icon") are not milestone
// tasks and contribute no progress bar.
export function parseMilestoneSlug(slug: string): MilestoneSlugInfo | null {
  const match = slug.match(MILESTONE_SLUG_RE)
  if (!match) return null
  const milestoneNumber = parseInt(match[2], 10)
  if (isNaN(milestoneNumber)) return null
  return { projectBase: match[1], milestoneNumber }
}

// Matches a milestone heading regardless of exact markup a plan.md happens to
// use — "## M0", "### M1:", "- **M2**" all count — capturing the number.
const MILESTONE_HEADING_RE = /^(?:#{1,6}\s*|[-*]\s*\**)M(\d+)\b/

// Counts distinct milestone numbers (M0, M1, ...) referenced in plan.md.
// Pure/sync so parsing correctness is directly testable without touching
// the filesystem. Never throws — a line that fails to match is just skipped.
export function countPlanMilestones(raw: string): number {
  const numbers = new Set<number>()
  for (const line of raw.split('\n')) {
    try {
      const match = line.trim().match(MILESTONE_HEADING_RE)
      if (match) {
        const n = parseInt(match[1], 10)
        if (!isNaN(n)) numbers.add(n)
      }
    } catch (err) {
      // A single malformed line should never abort the whole count.
      console.error('[taskParser] failed to match milestone heading:', err)
    }
  }
  return numbers.size
}

// Exported for server.ts's own merge/cleanup routes (gitOps.ts) — the repo
// checkout a task's git operations run against is "<REPOS_DIR>/<repo>", the
// same root this file already resolves plan.md against.
export function reposDir(): string {
  return process.env.REPOS_DIR ? path.resolve(process.env.REPOS_DIR) : path.join(os.homedir(), 'Dev')
}

// Where a task's worktree lives — "<WORKTREES_DIR>/<slug>", the root the
// orchestrator creates them under. Mirrors reposDir() above, and is the one
// source of truth for two callers that must agree: parseTask, which checks
// whether that directory exists, and /focus/:slug's dead-session fallback,
// which names the path it asks the orchestrator to recreate. The path is
// deterministic from the slug even while the directory doesn't exist, which
// is exactly the state a shelved task is in.
export function worktreesDir(): string {
  return process.env.WORKTREES_DIR
    ? path.resolve(process.env.WORKTREES_DIR)
    : path.join(os.homedir(), 'Dev', 'worktrees')
}

// What POST /focus/:slug pastes at the orchestrator when neither the
// recorded iTerm session nor its tmux session is alive — "mirror what a
// developer would do by hand". Pure and here rather than inline in the
// route so the exact wording is directly testable: the end-to-end check
// drives a real iTerm2 window through osascript, where what lands on screen
// is whatever a live shell made of it.
//
// A task resumed from the backlog has had its worktree removed along with
// its session (see POST /shelve/:slug), so the standing "attached to its
// existing worktree" instruction has nothing to attach to. The recreate
// clause is spliced in only when the worktree is genuinely missing AND the
// task dir said enough to name the command — a dir with no parseable
// TASK.md leaves repo and branch as '' (parseTaskMdContent's fallback), and
// pasting a half-written `git -C <repos>/ worktree add <path> ` into a real
// terminal is worse than pasting nothing. With the clause empty this is
// byte-for-byte the message every ordinary dead session has always got.
export function buildDeadSessionMessage(slug: string, task: Pick<Task, 'worktree' | 'repo' | 'branch'>): string {
  const canNameRecreate = !task.worktree && !!task.repo && !!task.branch
  const recreateClause = canNameRecreate
    ? ` Its worktree is gone too — first run \`git -C ${path.join(reposDir(), task.repo)} worktree add ${path.join(worktreesDir(), slug)} ${task.branch}\` to recreate it from the branch, which still has everything committed.`
    : ''
  return `The tmux session for \`${slug}\` is gone — its iTerm tab and tmux session are both dead (likely after a restart).${recreateClause} Recreate a tmux session attached to its existing worktree, launch \`claude\` in it, and prompt it to read TASK.md and resume from wherever its STATUS paused note says to pick up.`
}

// Reads "<REPOS_DIR>/<repo>/plan.md" and counts its milestones. Never throws —
// returns null when the file is missing, unreadable, or fails to parse, so
// callers can treat null as simply "no progress bar for this task".
export async function countMilestonesInPlan(repo: string): Promise<number | null> {
  const planPath = path.join(reposDir(), repo, 'plan.md')
  let content: string
  try {
    content = await fs.readFile(planPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`[taskParser] failed to read plan.md at ${planPath}:`, err)
    }
    return null
  }
  try {
    return countPlanMilestones(content)
  } catch (err) {
    console.error(`[taskParser] failed to parse milestones in ${planPath}:`, err)
    return null
  }
}

// The board shows one global progress bar for whichever multi-milestone
// project is currently active: the most recently updated milestone card
// that isn't done or handed over. If several projects qualify, the most
// recently updated one wins.
export function computeActiveProject(tasks: Task[]): ActiveProjectProgress | null {
  const active = tasks.filter(
    (
      t
    ): t is Task & { projectBase: string; milestoneCurrent: number; milestoneTotal: number } =>
      t.projectBase !== undefined &&
      t.milestoneCurrent !== undefined &&
      t.milestoneTotal !== undefined &&
      (t.status === 'working' || t.status === 'waiting' || t.status === 'paused')
  )
  if (active.length === 0) return null

  const chosen = active.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
  return { projectBase: chosen.projectBase, current: chosen.milestoneCurrent, total: chosen.milestoneTotal }
}

// ---------------------------------------------------------------------------
// tech-design.md milestone declarations
// ---------------------------------------------------------------------------

// Re-exported so callers can import MilestoneDecl from either module — same
// convention as Finding and QaFailure above.
export type { MilestoneDecl }

// Fence-aware "walk lines, find the section whose heading matches headingRe"
// scan shared by parseMilestonesContent and parseSummarySection/
// stripSummarySection below — both need the same rule: a fenced code block
// is opaque to heading detection (so a plan doc that documents this very
// format inside a ```markdown fence doesn't get read as a real section), and
// a section runs until the next heading of ANY level. Returns null when no
// heading matches; `body` is the line range strictly between the heading and
// whatever ends the section (the next heading, or EOF). Pure/sync, never
// throws, matching this file's tolerance rule for plan-doc parsing.
function sectionLines(lines: string[], headingRe: RegExp): { start: number; end: number; body: string[] } | null {
  let start = -1
  let end = lines.length
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (/^#{1,6}\s/.test(trimmed)) {
      if (start === -1) {
        if (headingRe.test(trimmed)) start = i
      } else {
        end = i
        break
      }
    }
  }

  if (start === -1) return null
  return { start, end, body: lines.slice(start + 1, end) }
}

// The heading level is deliberately loose: the 2026-08-08 design writes the
// section as "## Milestones", while docs/tech-design-template.md — the
// template planning actually copies from — uses "### Milestones".
const MILESTONES_HEADING_RE = /^#{2,6}\s+Milestones\s*$/i

// "- M0: Rename + Vercel — needs: none — est: 2h — spec: e2e/rename.spec.ts",
// tolerating "- **M0** ..." and a trailing period instead of a colon. The id
// must be M<digits>: that is what maps to a "<parent>-m<N>" child slug, and
// an id that can never map is worse than a skipped line.
const MILESTONE_BULLET_RE = /^[-*]\s*\**\s*M(\d+)\**\s*[:.]\s*(.+)$/i

// The name ends at the first segment separator or keyed field, whichever
// comes first. Keyed extraction rather than splitting on the separator,
// because a milestone name may legitimately contain a hyphen.
const MILESTONE_FIELD_START_RE = /[—–]|needs:|est(?:imate)?:|spec:/i
const MILESTONE_NEEDS_RE = /needs:\s*([^—–\n]*)/i
const MILESTONE_EST_RE = /est(?:imate)?:\s*([^—–\n]*)/i
// One or more comma-separated relative e2e file paths — no backticks
// required (unlike Finding/QaCase locations), since this is a plan author
// declaring a path, not citing one out of generated prose.
const MILESTONE_SPEC_RE = /spec:\s*([^—–\n]*)/i

// Parses the "## Milestones" section of a tech-design.md into declarations.
// Pure/sync so parsing correctness is directly testable without touching the
// filesystem. Never throws — same tolerance rule as parseTimelineContent and
// parseFindings: a stray line in a plan doc must never take the dashboard
// down, so anything that does not match the bullet shape is skipped.
export function parseMilestonesContent(raw: string): MilestoneDecl[] {
  const decls: MilestoneDecl[] = []
  const seen = new Set<string>()
  const section = sectionLines(raw.split('\n'), MILESTONES_HEADING_RE)
  if (!section) return decls

  let inFence = false

  for (const line of section.body) {
    const trimmed = line.trim()

    // A fenced code block is opaque to bullet detection too — the same
    // "## Milestones" example inside a ```markdown fence could itself
    // contain bullet-shaped lines that must not be read as real
    // declarations.
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    const bullet = trimmed.match(MILESTONE_BULLET_RE)
    if (!bullet) continue

    const n = parseInt(bullet[1], 10)
    if (isNaN(n)) continue
    const id = `M${n}`
    if (seen.has(id)) continue // a repeated id: the first declaration wins
    seen.add(id)

    const rest = bullet[2]
    const fieldStart = rest.search(MILESTONE_FIELD_START_RE)
    const name = (fieldStart === -1 ? rest : rest.slice(0, fieldStart))
      .trim()
      .replace(/[\s—–-]+$/, '')

    const needsRaw = rest.match(MILESTONE_NEEDS_RE)?.[1].trim() ?? ''
    const needs = !needsRaw || /^none$/i.test(needsRaw)
      ? []
      : needsRaw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)

    const estRaw = rest.match(MILESTONE_EST_RE)?.[1].trim() ?? ''
    const specRaw = rest.match(MILESTONE_SPEC_RE)?.[1].trim() ?? ''

    decls.push({ id, name, needs, estimate: estRaw || null, specFile: specRaw || null })
  }

  return decls
}

// The heading level is deliberately loose, same rationale as Milestones
// above ("## Summary" vs. the template's "### Summary").
const SUMMARY_HEADING_RE = /^#{2,6}\s+Summary\s*$/i

// The raw Markdown body of a tech-design.md's first "## Summary" section —
// see tech-design-plan-summary-milestone-tests.md, "Summary is pinned and
// stripped". Everything under the heading is part of the summary, including
// a misplaced "**QA Spec:**" line or a table — this parser does not
// special-case that; the planning convention forbids putting anything but
// prose there instead. null when the heading is absent, or its body is
// blank (an empty heading is not a summary worth pinning).
export function parseSummarySection(raw: string): string | null {
  const section = sectionLines(raw.split('\n'), SUMMARY_HEADING_RE)
  if (!section) return null
  const body = section.body.join('\n').trim()
  return body || null
}

// `raw` with the "## Summary" heading and its body removed, so the plan
// document rendered below the pinned summary card doesn't repeat it
// verbatim. Returns `raw` unchanged when there is no such section — a
// no-op, not an error, per this file's tolerance rule.
export function stripSummarySection(raw: string): string {
  const lines = raw.split('\n')
  const section = sectionLines(lines, SUMMARY_HEADING_RE)
  if (!section) return raw
  return [...lines.slice(0, section.start), ...lines.slice(section.end)].join('\n')
}

export type { MilestoneStatus }

// Matches each declared milestone to its dispatched "<parentSlug>-m<N>" child
// and lays the declarations out in dependency waves.
//
// wave(m) = 1                                   if m.needs is empty
// wave(m) = 1 + max(wave(d) for d in m.needs)   otherwise
//
// Longest path, not shortest: that is what makes a diamond resolve correctly,
// putting a converging milestone after the LATER of its blockers with no
// tie-breaking judgment call.
//
// Pure and directly unit-testable, matching this file's existing convention —
// which is also why it cannot live inside parseTask: matching a declared M2 to
// a dispatched "overlap-m2" child requires seeing the whole task list, so
// parseAllTasks runs it as a second pass (same place isOrphaned already runs).
export function computeMilestones(
  decls: MilestoneDecl[],
  parentSlug: string,
  allTasks: Task[],
): MilestoneStatus[] {
  const byId = new Map(decls.map((d) => [d.id.toUpperCase(), d]))
  const waves = new Map<string, number>()
  const visiting = new Set<string>()

  function waveOf(id: string): number {
    const cached = waves.get(id)
    if (cached !== undefined) return cached

    if (visiting.has(id)) {
      // A cycle. Plan review is supposed to catch this before dev ever
      // starts; the dashboard's only job is to not hang over it, so the back
      // edge is cut here and the fact is logged rather than swallowed.
      console.error(`[taskParser] milestone dependency cycle reaching ${id} in ${parentSlug} — cutting the back edge`)
      return 1
    }

    visiting.add(id)
    let wave = 1
    for (const need of byId.get(id)?.needs ?? []) {
      const key = need.toUpperCase()
      // A needs: id nothing declares is skipped, not thrown on — the same
      // tolerance rule the parsers follow.
      if (!byId.has(key)) continue
      wave = Math.max(wave, waveOf(key) + 1)
    }
    visiting.delete(id)

    waves.set(id, wave)
    return wave
  }

  const bySlug = new Map(allTasks.map((t) => [t.slug, t]))

  return decls.map((d) => {
    const id = d.id.toUpperCase()
    const n = parseInt(id.slice(1), 10)
    const child = isNaN(n) ? null : bySlug.get(`${parentSlug}-m${n}`) ?? null
    const state: MilestoneStatus['state'] =
      child === null ? 'queued' : child.status === 'done' ? 'done' : 'dispatched'

    return { ...d, wave: waveOf(id), task: child, state }
  })
}

// A flat (non-milestone) task's tech-design.md has no "## Milestones"
// section to hang a `spec:` field off, but the task IS its own plan 1:1 —
// so it gets one standalone declared line instead:
//   **QA Spec:** `e2e/foo.spec.ts`
// A plan author declaring a path is held to the stricter backtick-quoted
// shape (unlike FINDING_BULLET_RE's tail, which now also tolerates a bare
// path) — this is authored once by a human/planning session, not generated
// prose a worker might slip up on, so there is no leniency gap to close here.
const QA_SPEC_LINE_RE =
  /^\*\*QA Spec:\*\*\s*(`[^`]+`(?:\s*,?\s*(?:and\s+)?`[^`]+`)*)\s*$/im

// Pulls every backtick-quoted location out of a QA_SPEC_LINE_RE match and
// joins them into a single comma-separated string — the common case is
// exactly one, but a plan may cite several spec files.
function extractLocations(tail: string): string {
  const matches = tail.match(/`([^`]+)`/g) ?? []
  return matches.map((m) => m.slice(1, -1)).join(', ')
}

export function parseQaSpecFile(raw: string): string | null {
  const match = raw.match(QA_SPEC_LINE_RE)
  return match ? extractLocations(match[1]) : null
}

// Pulls every `test(...)` case title out of a Playwright spec file's raw
// source, in file order — used to preview a task's planned QA cases before
// QA_REPORT.md exists (see qaSpecFile on Task). Deliberately shallow: it
// does not track test.describe nesting or tags, it just collects every
// top-level test() call's first (string) argument. Good enough for a
// preview list; the real, authoritative pass/fail titles come from
// QA_REPORT.md once QA actually runs.
const TEST_TITLE_RE = /\btest(?:\.only|\.skip)?\(\s*(['"])((?:\\.|(?!\1).)*)\1/g

export function parseQaCaseTitles(raw: string): string[] {
  const titles: string[] = []
  for (const match of raw.matchAll(TEST_TITLE_RE)) {
    titles.push(match[2])
  }
  return titles
}

// ---------------------------------------------------------------------------
// METRICS types
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  contextPct?: number
  model?: string | { id: string; display_name?: string }
  inputTokens?: number
  outputTokens?: number
}

// The METRICS-<claude-session-id>.json shape — a MetricsSnapshot plus the
// identity fields that make one session distinguishable from another in the
// same task dir. See the plan's "File formats" section for the contract.
export interface PerSessionMetrics extends MetricsSnapshot {
  sessionId?: string
  stage?: string
  startedAt?: string
  updatedAt?: string
}

// How recently a per-session file must have been touched for its session to
// render as live. Nothing on disk can prove a Claude process is still
// breathing, so this is an honest approximation rather than a fact — which is
// already true today, where the model just hides it by assuming the METRICS
// file is always the live one.
export const LIVE_SESSION_WINDOW_MS = 10 * 60 * 1000

// Sorting key for per-session files: when it started, falling back to when it
// was last touched, falling back to the filename so the order is at least
// stable rather than dependent on readdir.
function sessionOrderKey(data: PerSessionMetrics, file: string): string {
  return data.startedAt || data.updatedAt || file
}

function sessionIdFromFilename(file: string): string | null {
  const match = file.match(/^METRICS-(.+)\.json$/)
  return match ? match[1] : null
}

// Parses the per-session files, dropping any that are half-written. Shared by
// buildSessions and newestSnapshot so the two never disagree about which
// files count.
function parsePerSession(
  perSession: { file: string; raw: string }[],
): { data: PerSessionMetrics; file: string }[] {
  const parsed: { data: PerSessionMetrics; file: string }[] = []
  for (const { file, raw } of perSession) {
    try {
      parsed.push({ data: JSON.parse(raw) as PerSessionMetrics, file })
    } catch {
      // A file caught mid-write drops out of the history; it doesn't break it.
      console.error(`[taskParser] skipping unparseable per-session metrics file ${file}`)
    }
  }
  return parsed
}

// Which snapshot should drive the card's CTX and Model tiles: the
// newest-updated per-session file when there is one, else the legacy METRICS
// file exactly as before.
export function newestSnapshot(
  current: MetricsSnapshot | null,
  perSession: { file: string; raw: string }[],
): PerSessionMetrics | null {
  const parsed = parsePerSession(perSession)
  if (parsed.length === 0) return current
  return parsed.reduce((a, b) =>
    (b.data.updatedAt || '') > (a.data.updatedAt || '') ? b : a
  ).data
}

// Turns the raw METRICS-N.json snapshot contents, the live METRICS file, and
// the per-session METRICS-<id>.json files into one entry per session, oldest
// first. Split out from parseTask so the ordering, the liveness rule and the
// malformed-JSON handling are testable without touching disk.
//
// `perSession` and `now` are optional so the legacy two-argument call shape
// keeps working unchanged.
//
// The legacy METRICS file is DROPPED whenever any per-session file exists:
// both writers emit METRICS and the writing session's own per-session file in
// the same breath, so keeping both would count that session's tokens twice.
// Legacy METRICS-N.json handover snapshots are always kept — they record
// sessions no per-session file covers.
export function buildSessions(
  snapshots: { n: number; raw: string }[],
  current: MetricsSnapshot | null,
  perSession: { file: string; raw: string }[] = [],
  now: number = Date.now(),
): SessionMetric[] {
  const sessions: SessionMetric[] = []

  for (const { n, raw } of [...snapshots].sort((a, b) => a.n - b.n)) {
    let data: MetricsSnapshot
    try {
      data = JSON.parse(raw) as MetricsSnapshot
    } catch {
      continue // a corrupt snapshot drops out of the history, it doesn't break it
    }
    sessions.push({
      n,
      contextPct: typeof data.contextPct === 'number' ? data.contextPct : null,
      inputTokens: typeof data.inputTokens === 'number' ? data.inputTokens : 0,
      outputTokens: typeof data.outputTokens === 'number' ? data.outputTokens : 0,
      current: false,
      stage: null,
      sessionId: null,
      startedAt: null,
      updatedAt: null,
    })
  }

  const parsed = parsePerSession(perSession)

  if (parsed.length === 0) {
    if (current) {
      // The live session always numbers one past the last completed one, even
      // if a snapshot went missing — its number tracks handovers, not array
      // length.
      const lastN = sessions.length ? sessions[sessions.length - 1].n : 0
      sessions.push({
        n: lastN + 1,
        contextPct: typeof current.contextPct === 'number' ? current.contextPct : null,
        inputTokens: typeof current.inputTokens === 'number' ? current.inputTokens : 0,
        outputTokens: typeof current.outputTokens === 'number' ? current.outputTokens : 0,
        current: true,
        stage: null,
        sessionId: null,
        startedAt: null,
        updatedAt: null,
      })
    }
    return sessions
  }

  parsed.sort((a, b) =>
    sessionOrderKey(a.data, a.file) < sessionOrderKey(b.data, b.file) ? -1 : 1
  )

  // Only the newest-updated session can be live, and only if it was touched
  // inside the window.
  const newestFile = parsed.reduce((a, b) =>
    (b.data.updatedAt || '') > (a.data.updatedAt || '') ? b : a
  ).file

  let n = sessions.length ? sessions[sessions.length - 1].n : 0
  for (const { data, file } of parsed) {
    n++
    const updatedAt = typeof data.updatedAt === 'string' ? data.updatedAt : null
    const updatedMs = updatedAt ? Date.parse(updatedAt) : NaN
    sessions.push({
      n,
      contextPct: typeof data.contextPct === 'number' ? data.contextPct : null,
      inputTokens: typeof data.inputTokens === 'number' ? data.inputTokens : 0,
      outputTokens: typeof data.outputTokens === 'number' ? data.outputTokens : 0,
      current: file === newestFile && !isNaN(updatedMs) && now - updatedMs < LIVE_SESSION_WINDOW_MS,
      stage: typeof data.stage === 'string' && STAGE_SET.has(data.stage) ? (data.stage as Stage) : null,
      sessionId: typeof data.sessionId === 'string' && data.sessionId
        ? data.sessionId
        : sessionIdFromFilename(file),
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : null,
      updatedAt,
    })
  }

  return sessions
}

// ---------------------------------------------------------------------------
// Done tab — resolve each done task's real completion date
// ---------------------------------------------------------------------------

// Resolved merge-commit dates never change once found, so cache to avoid
// re-spawning `git log` on every refresh — refreshTasks() reparses every
// task on any watched file change (STATUS/METRICS/etc. for *any* task). A
// miss is just as permanent as a hit here (resolveCompletionDate only calls
// this for a 'done' task, whose repo/branch history won't grow a "Merge
// <branch>" commit after the fact), so it's cached too via `Date | null` —
// without that, every squash-merged-via-GitHub-PR done task (the "Merge
// <branch>" convention never matches those) re-spawns `git log` on every
// single refresh, forever, which is exactly what turned into a several-dozen
// concurrent `git log` pileup in production. Keyed by slug+branch (not slug
// alone) because a task dir can be reused for a fresh request on a different
// branch (see orchestrator-prompt.md's "Reuse rule") — keying on slug alone
// would keep serving the old branch's date.
const mergeCommitDateCache = new Map<string, Date | null>()

// Looks for a commit whose message mentions "Merge <branch>" — this repo's
// own convention for direct (no-PR) merges, e.g. "Merge claude/foo: did the
// thing" or "Merge claude/foo into master". Repos that merge via squashed
// GitHub PRs (branch name doesn't appear in the squash commit message) won't
// match here; callers fall back to STATUS mtime in that case.
export async function getMergeCommitDate(repoDir: string, branch: string): Promise<Date | null> {
  if (!branch) return null
  try {
    const { stdout } = await execa('git', [
      '-C', repoDir,
      'log', '--all', '-F', '--grep', `Merge ${branch}`,
      '-1', '--format=%aI',
    ])
    const iso = stdout.trim()
    if (!iso) return null
    const date = new Date(iso)
    return isNaN(date.getTime()) ? null : date
  } catch {
    return null
  }
}

// Prefers the merge commit date (durable — survives worktree cleanup and
// later STATUS edits) over the STATUS file's mtime (the existing signal,
// only as reliable as whoever last touched STATUS — see the STATUS-path bug
// fixed in a43c6cb, now fixed but still just a "last touched" timestamp).
async function resolveCompletionDate(
  slug: string,
  repo: string,
  branch: string,
  statusMtime: Date
): Promise<{ date: Date; source: 'merge-commit' | 'status-mtime' }> {
  const cacheKey = `${slug}:${branch}`
  if (mergeCommitDateCache.has(cacheKey)) {
    const cached = mergeCommitDateCache.get(cacheKey)!
    return cached ? { date: cached, source: 'merge-commit' } : { date: statusMtime, source: 'status-mtime' }
  }

  const mergeDate = repo && branch ? await getMergeCommitDate(path.join(reposDir(), repo), branch) : null
  mergeCommitDateCache.set(cacheKey, mergeDate)
  return mergeDate ? { date: mergeDate, source: 'merge-commit' } : { date: statusMtime, source: 'status-mtime' }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function parseTask(taskDir: string): Promise<Task | null> {
  const dir = expandHome(taskDir)
  const slug = path.basename(dir)

  // STATUS is required to determine task state; treat missing as 'working'.
  const statusPath = path.join(dir, 'STATUS')
  const statusContent = await readFileSafe(statusPath)

  const statusFields = parseStatusContent(statusContent ?? 'working')

  // All remaining I/O is independent — dispatch concurrently.
  const worktreePath = path.join(worktreesDir(), slug)
  const metricsPath = path.join(dir, 'METRICS')

  const [statusStat, taskMdContent, worktreeAccess, devUrlRaw, itermSessionRaw, tmuxSessionRaw, verifyRaw, timelineRaw, metricsContent, plan, reviewRaw, qaRaw, techDesignRaw, triageRaw, qaTriageRaw, autoModeRaw] =
    await Promise.all([
      statSafe(statusPath),
      readFileSafe(path.join(dir, 'TASK.md')),
      fs.access(worktreePath).then(() => true).catch(() => false),
      readFileSafe(path.join(dir, 'DEV_URL')),
      readFileSafe(path.join(dir, 'ITERM_SESSION')),
      readFileSafe(path.join(dir, 'TMUX_SESSION')),
      readFileSafe(path.join(dir, 'VERIFY')),
      readFileSafe(path.join(dir, 'TIMELINE')),
      readFileSafe(metricsPath),
      parsePlan(dir),
      readFileSafe(path.join(dir, 'task-pr-review.md')),
      readFileSafe(path.join(dir, 'QA_REPORT.md')),
      readFileSafe(path.join(dir, 'tech-design.md')),
      readFileSafe(path.join(dir, 'TRIAGE.json')),
      readFileSafe(path.join(dir, 'QA_TRIAGE.json')),
      readFileSafe(path.join(dir, 'AUTO_MODE')),
    ])

  const autoModeOverride = parseAutoModeOverride(autoModeRaw)

  // An empty tech-design.md still counts as present — this must stay
  // equivalent to the fs.access check it replaced, or every task holding an
  // empty plan file silently falls back a stage.
  const hasTechDesign = techDesignRaw !== null

  const updatedAt = statusStat ? statusStat.mtime : new Date()

  const taskMdFields: TaskMdFields = taskMdContent
    ? parseTaskMdContent(taskMdContent)
    : { title: '', mode: '', repo: '', branch: '' }

  const worktree: string | null = worktreeAccess ? worktreePath : null

  // Trim once, not twice
  const trimmedDevUrl = devUrlRaw?.trim()
  const devUrl: string | null = trimmedDevUrl || null

  const trimmedSessionId = itermSessionRaw?.trim()
  const itermSessionId: string | null = trimmedSessionId || null

  const trimmedTmuxSession = tmuxSessionRaw?.trim()
  const tmuxSession: string | null = trimmedTmuxSession || null

  // Only the first line is the verifier itself; planning may append notes below it.
  const trimmedVerifier = verifyRaw?.split('\n')[0]?.trim()
  const verifier: string | null = trimmedVerifier || null

  const stageHistory = timelineRaw ? parseTimelineContent(timelineRaw) : []

  const stage = computeStage({
    status: statusFields.status,
    mode: taskMdFields.mode,
    stageHistory,
    hasTechDesign,
    reviewVerdict: reviewRaw ? parseVerdict(reviewRaw) : null,
    qaResult: qaRaw ? parseQaResult(qaRaw) : null,
  })

  // Multi-milestone project progress — only set for slugs like "overlap-m2".
  const milestoneSlug = parseMilestoneSlug(slug)
  let projectBase: string | undefined
  let milestoneCurrent: number | undefined
  let milestoneTotal: number | undefined

  if (milestoneSlug) {
    projectBase = milestoneSlug.projectBase
    milestoneCurrent = milestoneSlug.milestoneNumber + 1
    if (taskMdFields.repo) {
      const total = await countMilestonesInPlan(taskMdFields.repo)
      if (total !== null && total > 0) {
        milestoneTotal = total
      }
    }
  }

  // Declared milestones. computeMilestones is run here with an empty task
  // list, which produces correct waves and every milestone `queued` — the
  // dispatched children are stitched on in parseAllTasks, where the whole
  // list is visible. undefined (not []) when nothing is declared, so
  // "milestones absent" stays the signal for the flat 8-stage pipeline.
  const milestoneDecls = techDesignRaw ? parseMilestonesContent(techDesignRaw) : []
  const milestones = milestoneDecls.length
    ? computeMilestones(milestoneDecls, slug, [])
    : undefined

  // Flat-task QA spec: read directly off this task's own tech-design.md
  // when it has no Milestones section of its own (a plain, non-milestone
  // task). A milestone child has no tech-design.md of its own at all — its
  // declared `spec:` field lives in the PARENT's Milestones section, so
  // parseAllTasks's second pass stitches it on once the whole task list
  // (parent included) is visible, same place/reason as projectTitle. That
  // pass can't run here, so this falls back to reading the parent's
  // tech-design.md directly and pulling out this milestone's own
  // declaration — closing the gap for a milestone child parsed standalone,
  // and reusing parseMilestoneSlug (already computed above as
  // milestoneSlug) rather than re-deriving the parent slug.
  let qaSpecFile = !milestones && techDesignRaw ? parseQaSpecFile(techDesignRaw) : null
  if (qaSpecFile === null && milestoneSlug) {
    const parentTechDesignRaw = await readFileSafe(
      path.join(dir, '..', milestoneSlug.projectBase, 'tech-design.md'),
    )
    if (parentTechDesignRaw) {
      const ownDecl = parseMilestonesContent(parentTechDesignRaw).find(
        (d) => d.id === `M${milestoneSlug.milestoneNumber}`,
      )
      qaSpecFile = ownDecl?.specFile ?? null
    }
  }

  // Completion date — only meaningful once the task is actually done. A
  // handover status doesn't qualify: the task is still continuing in a new
  // session, not finished.
  let completedAt: string | null = null
  let completedAtSource: 'merge-commit' | 'status-mtime' | null = null
  if (statusFields.status === 'done') {
    const resolved = await resolveCompletionDate(slug, taskMdFields.repo, taskMdFields.branch, updatedAt)
    completedAt = resolved.date.toISOString()
    completedAtSource = resolved.source
  }

  // METRICS (current session)
  let parsedCurrentMetrics: MetricsSnapshot | null = null
  if (metricsContent) {
    try {
      parsedCurrentMetrics = JSON.parse(metricsContent) as MetricsSnapshot
    } catch {
      // Ignore malformed METRICS JSON
    }
  }

  // METRICS-N.json — legacy handover snapshots (digits only).
  // METRICS-<claude-session-id>.json — one per session, the current model.
  // The digits-only test is what keeps the two apart: a Claude session id
  // always contains hyphens, so it can never be mistaken for a handover
  // snapshot, and vice versa.
  const snapshotContents: { n: number; raw: string }[] = []
  const perSessionContents: { file: string; raw: string }[] = []
  try {
    const entries = await fs.readdir(dir)
    const legacyFiles = entries.filter((e) => /^METRICS-\d+\.json$/.test(e))
    const perSessionFiles = entries.filter(
      (e) => /^METRICS-.+\.json$/.test(e) && !/^METRICS-\d+\.json$/.test(e)
    )

    const loadedLegacy = await Promise.all(
      legacyFiles.map(async (file) => {
        const raw = await readFileSafe(path.join(dir, file))
        const n = parseInt(file.slice('METRICS-'.length), 10)
        return raw ? { n, raw } : null
      })
    )
    for (const entry of loadedLegacy) if (entry) snapshotContents.push(entry)

    const loadedPerSession = await Promise.all(
      perSessionFiles.map(async (file) => {
        const raw = await readFileSafe(path.join(dir, file))
        return raw ? { file, raw } : null
      })
    )
    for (const entry of loadedPerSession) if (entry) perSessionContents.push(entry)
  } catch (err) {
    console.error(`[taskParser] failed to list metrics files in ${dir}:`, err)
  }

  const sessions = buildSessions(snapshotContents, parsedCurrentMetrics, perSessionContents)

  // The card's CTX and Model tiles describe this task's newest session: the
  // newest-updated per-session file when there is one, else the legacy
  // METRICS file exactly as before.
  const headline = newestSnapshot(parsedCurrentMetrics, perSessionContents)

  let contextPct: number | undefined
  let model: string | undefined
  let metricsUpdatedAt: Date | undefined

  if (headline) {
    contextPct = typeof headline.contextPct === 'number' ? headline.contextPct : undefined
    model = typeof headline.model === 'string' ? headline.model
          : typeof headline.model === 'object' && headline.model !== null ? headline.model.id
          : undefined

    // A per-session file records its own updatedAt; the legacy METRICS file
    // records nothing, so fall back to its mtime as before.
    const headlineUpdatedAt = typeof headline.updatedAt === 'string' ? new Date(headline.updatedAt) : null
    if (headlineUpdatedAt && !isNaN(headlineUpdatedAt.getTime())) {
      metricsUpdatedAt = headlineUpdatedAt
    } else if (parsedCurrentMetrics) {
      const mStat = await statSafe(metricsPath)
      metricsUpdatedAt = mStat ? mStat.mtime : undefined
    }
  }

  // TRIAGE.json — persisted human selection of which findings a future fixer
  // agent should act on. Malformed/missing JSON degrades to null (no
  // persisted selection yet), matching the METRICS-parsing pattern above:
  // never throw, never break the dashboard over a corrupt state file.
  let triageSelected: number[] | null = null
  if (triageRaw) {
    try {
      const parsedTriage = JSON.parse(triageRaw) as { selected?: unknown }
      if (Array.isArray(parsedTriage.selected)) {
        triageSelected = parsedTriage.selected.filter((n): n is number => typeof n === 'number')
      }
    } catch {
      // Ignore malformed TRIAGE.json — falls back to the null default.
    }
  }

  const findings = reviewRaw ? applyTriageSelection(parseFindings(reviewRaw), triageSelected) : []

  // A section whose declared "(N)" heading disagrees with how many bullets
  // actually parsed means at least one bullet didn't match the expected
  // shape (even after FINDING_BULLET_RE's bare-location leniency) — logged
  // here so it's never silently lost, and surfaced to the CR tab via
  // findingsParseMismatch on the returned Task.
  const findingsParseMismatch = reviewRaw ? findFindingsParseMismatch(reviewRaw, findings) : []
  if (findingsParseMismatch.length) {
    console.error(
      `[taskParser] ${slug}: task-pr-review.md bullet count mismatch — ${findingsParseMismatch.join('; ')}`,
    )
  }

  // QA_TRIAGE.json — same shape and same reasoning as TRIAGE.json above, kept
  // as a separate sidecar file (not reusing TRIAGE.json) since a task can in
  // principle carry both a task-pr-review.md and a QA_REPORT.md at once, and
  // their selection state must not collide.
  let qaTriageSelected: number[] | null = null
  if (qaTriageRaw) {
    try {
      const parsedQaTriage = JSON.parse(qaTriageRaw) as { selected?: unknown }
      if (Array.isArray(parsedQaTriage.selected)) {
        qaTriageSelected = parsedQaTriage.selected.filter((n): n is number => typeof n === 'number')
      }
    } catch {
      // Ignore malformed QA_TRIAGE.json — falls back to the null default.
    }
  }

  const qaFailures = qaRaw ? applyQaTriageSelection(parseQaFailures(qaRaw), qaTriageSelected) : []
  const qaCases = qaRaw ? parseQaCases(qaRaw) : []

  // Same idea as findingsParseMismatch above, for QA_REPORT.md's
  // Failing/Passing Cases sections.
  const qaCasesParseMismatch = qaRaw ? findQaCasesParseMismatch(qaRaw, qaCases) : []
  if (qaCasesParseMismatch.length) {
    console.error(
      `[taskParser] ${slug}: QA_REPORT.md bullet count mismatch — ${qaCasesParseMismatch.join('; ')}`,
    )
  }

  // showsOnBoard and attentionStatus are recomputed for every task in
  // parseAllTasks's second pass (once milestones are stitched with the
  // dispatched children and the real live-session set is known). The values
  // set here are the correct standalone answer for a lone parseTask call —
  // shouldShowOnBoard only needs this task's own slug/milestones, and
  // computeAttentionStatus degrades correctly with a null liveSessionIds
  // (same as "can't confirm working").
  const showsOnBoard = shouldShowOnBoard({ slug, milestones } as Task)
  const attentionStatus = computeAttentionStatus(
    { status: statusFields.status, itermSessionId, qaFailures, findings, milestones } as Task,
    null,
  )

  // Every session counted exactly once. For a legacy-only task dir this is
  // arithmetically identical to the old "live METRICS + non-current
  // snapshots" sum, because buildSessions puts the live METRICS entry in the
  // list — which is what the pre-existing totals tests assert.
  let totalInputTokens = 0
  let totalOutputTokens = 0
  for (const session of sessions) {
    totalInputTokens += session.inputTokens
    totalOutputTokens += session.outputTokens
  }

  return {
    slug,
    ...taskMdFields,
    worktree,
    devUrl,
    verifier,
    stageHistory,
    stage,
    findings,
    findingsParseMismatch,
    qaFailures,
    qaCases,
    qaCasesParseMismatch,
    itermSessionId,
    tmuxSession,
    plan,
    projectBase,
    milestoneCurrent,
    milestoneTotal,
    milestones,
    qaSpecFile,
    showsOnBoard,
    attentionStatus,
    autoModeOverride,
    // The correct standalone answer for a lone parseTask call (global
    // default off) — parseAllTasks recomputes this in its second pass once
    // the real SETTINGS.json is known, same pattern as showsOnBoard/
    // attentionStatus above.
    autoMode: computeEffectiveAutoMode(autoModeOverride, DEFAULT_SETTINGS.autoMode),
    ...statusFields,
    updatedAt,
    completedAt,
    completedAtSource,
    contextPct,
    model,
    totalInputTokens,
    totalOutputTokens,
    metricsUpdatedAt,
    sessions,
  }
}

// ---------------------------------------------------------------------------
// Done tab — group completed tasks into per-date cards
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// 'YYYY-MM-DD' in local time (not UTC) — grouping follows the developer's
// own calendar day, not a timezone offset from it. Exported for
// POST /shelve/:slug, which dates the BACKLOG.md entry it writes the same
// way, so a shelved row sorts alongside hand-written ones on the same day.
export function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function parseDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// 'Today' / 'Yesterday' for the first two days, then a human date — with the
// year appended only when it differs from the current year.
export function dateGroupLabel(dateKey: string, now: Date = new Date()): string {
  if (dateKey === 'unknown') return 'Unknown date'

  const groupDate = parseDateKey(dateKey)
  const today = parseDateKey(localDateKey(now))
  const diffDays = Math.round((today.getTime() - groupDate.getTime()) / 86_400_000)

  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'

  const label = `${WEEKDAY_NAMES[groupDate.getDay()]}, ${MONTH_NAMES[groupDate.getMonth()]} ${groupDate.getDate()}`
  return groupDate.getFullYear() === now.getFullYear() ? label : `${label}, ${groupDate.getFullYear()}`
}

// Groups done tasks by their resolved completedAt into one card per
// calendar date, most recent first. Tasks with no resolvable date (null or
// unparseable completedAt) land in a trailing "unknown" bucket instead of
// being dropped or mis-sorted. A handover status doesn't count as done — the
// task is still continuing in a new session, not finished — so it stays out
// of the Done tab.
export function groupDoneTasksByDate(tasks: Task[], now: Date = new Date()): DoneDateGroup[] {
  const doneTasks = tasks.filter((t) => t.status === 'done')

  const buckets = new Map<string, Task[]>()
  for (const task of doneTasks) {
    const parsed = task.completedAt ? new Date(task.completedAt) : null
    const key = parsed && !isNaN(parsed.getTime()) ? localDateKey(parsed) : 'unknown'
    const bucket = buckets.get(key)
    if (bucket) bucket.push(task)
    else buckets.set(key, [task])
  }

  for (const [key, list] of buckets) {
    if (key === 'unknown') continue
    list.sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
  }

  const dateKeys = [...buckets.keys()].filter((k) => k !== 'unknown').sort().reverse()
  const orderedKeys = buckets.has('unknown') ? [...dateKeys, 'unknown'] : dateKeys

  return orderedKeys.map((key) => ({
    dateKey: key,
    label: dateGroupLabel(key, now),
    tasks: buckets.get(key)!,
  }))
}

// A task is orphaned only once BOTH its iTerm tab and any tmux session
// backing it are gone. A closed tab with a live tmux session means the
// worker detached, not died — see the design doc for why.
export function isOrphaned(
  status: Task['status'],
  itermSessionId: string | null,
  liveIds: Set<string>,
  tmuxSession: string | null,
  liveTmuxSessions: Set<string>,
): boolean {
  return (
    status === 'working' &&
    !!itermSessionId &&
    !liveIds.has(itermSessionId) &&
    !liveTmuxSessions.has(tmuxSession ?? '')
  )
}

// The main-grid filter. A plain task (no declared milestones) and a
// milestone child (identified by slug shape, not by whether some parent's
// stitched list currently claims it — a child must stay reachable even if
// its own tech-design.md is edited out from under it) always render. A
// milestone-declaring parent renders only while at least one of its own
// declared milestones is still 'queued': once every one has been dispatched
// or merged, the parent's whole reason for having a card — triggering
// what's left — is gone, and each milestone's own progress already lives
// on that milestone's own card. This reverses the read-layer plan's
// original "keep children off the main grid" call.
export function shouldShowOnBoard(task: Task): boolean {
  // A shelved task is neither done nor active, so it belongs on neither
  // tab: groupDoneTasksByDate keys off `status === 'done'`, and this is the
  // one boolean activeTasksOf ANDs against for In Progress. Checked before
  // the milestone rules so a shelved milestone child drops off too.
  if (task.status === 'shelved') return false
  if (parseMilestoneSlug(task.slug)) return true
  if (!task.milestones || task.milestones.length === 0) return true
  return task.milestones.some((m) => m.state === 'queued')
}

// "Does this need me right now", replacing the raw STATUS value everywhere
// a card renders it. Deliberately approximate, matching the honesty already
// applied to CTX/liveness elsewhere in this design: nothing on disk proves
// a Claude process is still thinking versus stalled, and this treats "a
// triage checklist exists at all" as the actionable signal, since whether
// someone has already looked at it isn't tracked as a separate field.
export function computeAttentionStatus(
  task: Task,
  liveSessionIds: Set<string> | null,
): AttentionStatus {
  // Explicit 'waiting' status always means "blocked on the human," even if
  // the tab happens to still be technically live — the process is paused on
  // stdin, which is not the same thing as "actively working." This check
  // must run before the liveness check.
  if (task.status === 'waiting') return 'needs-you'

  // 'paused' means the user deliberately set this task aside — distinct from
  // 'waiting' (blocked on a decision) so the badge/CTA can read "Resume"
  // rather than the more urgent "Needs you". Also wins over liveness: same
  // reasoning as 'waiting' above.
  // 'shelved' shares that branch rather than earning an AttentionStatus of
  // its own: "does this need me right now" has the same answer for both,
  // and a shelved task never reaches a surface that renders one — no card,
  // and stateOptions derives its filter chips from the active list — so a
  // fourth member would be a permanently unselectable chip. Anything that
  // needs the distinction reads `status` off the same object.
  if (task.status === 'paused' || task.status === 'shelved') return 'paused'

  if (liveSessionIds && task.itermSessionId && liveSessionIds.has(task.itermSessionId)) {
    return 'working'
  }

  // Findings/qaFailures are parsed fresh from task-pr-review.md/QA_REPORT.md
  // on every read and are never archived once a task ships — so a `done`
  // task that once had a CR comment or QA failure would otherwise read
  // needs-you forever. Only a task that can still be acted on should flag.
  if (task.status !== 'done' && (task.qaFailures.length > 0 || task.findings.length > 0)) return 'needs-you'

  if (task.milestones) {
    const byId = new Map(task.milestones.map((m) => [m.id, m]))
    // needs.length > 0 excludes a root milestone (no deps) from this check —
    // it is trivially "ready" the moment the project is declared, which is
    // just the normal starting state (already visible via the task's own
    // stage/status), not a fresh unblock worth flagging. Without this guard
    // `[].every(...)` is vacuously true and every freshly-declared project
    // would read as needs-you before anyone had done anything.
    const ready = task.milestones.some(
      (m) => m.state === 'queued' && m.needs.length > 0 && m.needs.every((id) => byId.get(id)?.state === 'done')
    )
    if (ready) return 'needs-you'
  }

  return 'idle'
}

export async function parseAllTasks(
  tasksDir: string,
  settings: Settings = DEFAULT_SETTINGS,
): Promise<Task[]> {
  const dir = expandHome(tasksDir)

  // If the directory doesn't exist, return empty
  try {
    await fs.access(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  // Parse each immediate subdirectory concurrently
  const results = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dir, entry)
      try {
        const stat = await fs.stat(entryPath)
        if (stat.isDirectory()) {
          return parseTask(entryPath)
        }
      } catch {
        // ignore stat errors for individual entries
      }
      return null
    })
  )

  const tasks = results.filter((t): t is Task => t !== null)

  // Second pass: attach each declared milestone to its dispatched
  // "<parent>-m<N>" child, and stamp the parent's own title and declared
  // spec file onto that child as projectTitle/qaSpecFile. Neither can
  // happen inside parseTask — matching a declared M2 to a dispatched
  // "overlap-m2" child, or a child to its parent's title, needs every
  // directory parsed first. MilestoneStatus extends MilestoneDecl, so the
  // unstitched value parseTask produced is a valid input to
  // computeMilestones here.
  for (const task of tasks) {
    if (task.milestones) {
      task.milestones = computeMilestones(task.milestones, task.slug, tasks)
      for (const m of task.milestones) {
        if (m.task) {
          m.task.projectTitle = task.title
          m.task.qaSpecFile = m.specFile
        }
      }
    }
  }

  // The main-grid filter, computed once here rather than re-derived by
  // every renderer. Every task needs it, not only milestone-declaring ones.
  for (const task of tasks) {
    task.showsOnBoard = shouldShowOnBoard(task)
  }

  // Resolve each task's effective auto mode against the real global
  // default, now that it's known. parseTask's own value only ever assumed
  // DEFAULT_SETTINGS (auto off) — the only place the global default reaches
  // a task is here.
  for (const task of tasks) {
    task.autoMode = computeEffectiveAutoMode(task.autoModeOverride, settings.autoMode)
  }

  // Orphan detection: a task stuck at "working" whose iTerm tab has already
  // closed almost certainly finished (merged/closed/abandoned) without the
  // worker ever writing STATUS=done. Flag it rather than guess the outcome —
  // liveIds is null when iTerm2 scripting is unavailable, so we don't want to
  // false-flag every task in that case.
  //
  // liveTmuxSessions defaults to an empty set on failure (e.g. no tmux
  // server running) rather than null-skipping like liveIds does: an empty
  // set can never make isOrphaned return false for a task that would
  // otherwise be orphaned, so this safely degrades to iTerm-only orphan
  // detection instead of needing a second skip branch.
  const [liveIds, liveTmuxSessions] = await Promise.all([
    getLiveSessionIds(),
    getLiveTmuxSessions().then((s) => s ?? new Set<string>()),
  ])
  if (liveIds) {
    for (const task of tasks) {
      task.orphaned = isOrphaned(task.status, task.itermSessionId, liveIds, task.tmuxSession, liveTmuxSessions)
    }
  }

  // Reuses the same liveIds this loop already computed. Runs after the
  // milestone-stitching pass above, since the "queued milestone whose deps
  // are all done" case needs task.milestones already stitched. Unlike
  // orphan detection, this does not skip when liveIds is null — a null set
  // just means "can't confirm working", which computeAttentionStatus
  // already degrades through correctly.
  for (const task of tasks) {
    task.attentionStatus = computeAttentionStatus(task, liveIds)
  }

  return tasks
}
