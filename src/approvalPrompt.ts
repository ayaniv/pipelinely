import type { Task } from './types.js'

// A Claude Code selection dialog (permission prompt, plan approval,
// AskUserQuestion) that a worker's tmux pane is stopped on. Derived at read
// time from the pane text, never stored — nothing writes STATUS when a
// session waits on a click.
export interface DialogOption {
  number: number  // the digit that picks it, as printed on screen
  label: string   // text after "<n>. ", pointer stripped, capped
}

export interface ApprovalPrompt {
  session: string   // tmux session the dialog is in, e.g. "worker-foo-cr2"
  question: string  // the dialog's question, e.g. "Do you want to proceed?"
  summary: string   // one line: "<header> — <first content line>", capped
  options: DialogOption[]  // visible options only, in screen order
  // Identifies this exact dialog instance (see fingerprintPrompt), so a click
  // made against one dialog can never answer a later one.
  fingerprint: string
}

export const SUMMARY_MAX_CHARS = 160
export const OPTION_LABEL_MAX_CHARS = 120
// How much transcript above the dialog distinguishes it from a later dialog
// that asks the identical question.
export const FINGERPRINT_CONTEXT_LINES = 6
// A custom status line and the "⏵⏵ … mode" line can sit below the dialog's
// footer, so the footer is looked for in a window rather than on the last line.
const FOOTER_WINDOW_LINES = 8
const CAPTURE_TAIL_LINES = 60
const MAX_QUESTION_LINES = 3
// Descriptions can trail the last option (plan approval's input row), but a
// long run of prose between the options and the footer is not a dialog.
const MAX_LINES_BELOW_OPTIONS = 4
// Likewise between two options: a wrapped label plus a description. A longer
// gap means the next number up belongs to unrelated text, e.g. an assistant list.
const MAX_LINES_BETWEEN_OPTIONS = 4
const FOOTER_TEXT = 'Esc to cancel'
const OPTION_LINE = /^((?:[❯↑↓]\s*)*)(\d+)\.\s+\S/
const OPTION_LABEL = /^(?:[❯↑↓]\s*)*\d+\.\s+(.*)$/
const POINTER = '❯'
const RULE_LINE = /^[─━╭╰-]{10,}/
const BOX_BORDER = /^\s*│\s?|\s*│\s*$/g

function toCleanLines(paneText: string): string[] {
  const lines = paneText.split('\n').map((line) => line.trimEnd().replace(BOX_BORDER, '').trim())
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-CAPTURE_TAIL_LINES)
}

function findFooterIndex(lines: string[]): number {
  let seenNonBlank = 0
  for (let i = lines.length - 1; i >= 0 && seenNonBlank < FOOTER_WINDOW_LINES; i--) {
    if (lines[i] === '') continue
    seenNonBlank++
    if (lines[i].includes(FOOTER_TEXT)) return i
  }
  return -1
}

interface OptionRun {
  topIndex: number
  options: DialogOption[]
}

function truncateLabel(label: string): string {
  return label.length > OPTION_LABEL_MAX_CHARS ? `${label.slice(0, OPTION_LABEL_MAX_CHARS - 1)}…` : label
}

// Walks up from the footer collecting consecutively numbered options (they
// need not start at 1 — a long list scrolls). Non-option lines between two
// options are descriptions or wrapped labels and are absorbed.
function collectOptions(lines: string[], footerIndex: number): OptionRun | null {
  let nextNumber: number | null = null
  let topIndex = -1
  const options: DialogOption[] = []
  let pointerCount = 0
  let linesBelowOptions = 0
  let linesSinceOption = 0
  for (let i = footerIndex - 1; i >= 0; i--) {
    const line = lines[i]
    if (line === '') continue
    if (RULE_LINE.test(line)) break
    const match = OPTION_LINE.exec(line)
    if (!match) {
      if (options.length === 0 && ++linesBelowOptions > MAX_LINES_BELOW_OPTIONS) return null
      if (options.length > 0 && ++linesSinceOption > MAX_LINES_BETWEEN_OPTIONS) break
      continue
    }
    const number = Number(match[2])
    if (nextNumber !== null && number !== nextNumber) break
    nextNumber = number - 1
    linesSinceOption = 0
    topIndex = i
    options.unshift({ number, label: truncateLabel(OPTION_LABEL.exec(line)?.[1] ?? '') })
    if (match[1].includes(POINTER)) pointerCount++
  }
  if (options.length < 2 || pointerCount !== 1) return null
  return { topIndex, options }
}

function collectQuestionLines(lines: string[], optionsTopIndex: number): { question: string; firstIndex: number } | null {
  let i = optionsTopIndex - 1
  while (i >= 0 && lines[i] === '') i--
  const collected: string[] = []
  let firstIndex = -1
  while (i >= 0 && lines[i] !== '' && !RULE_LINE.test(lines[i]) && collected.length < MAX_QUESTION_LINES) {
    collected.unshift(lines[i])
    firstIndex = i
    i--
  }
  if (collected.length === 0) return null
  return { question: collected.join(' '), firstIndex }
}

function truncateSummary(summary: string): string {
  return summary.length > SUMMARY_MAX_CHARS ? `${summary.slice(0, SUMMARY_MAX_CHARS - 1)}…` : summary
}

// The dialog's top rule, and the non-blank lines between it and the question.
function findDialogHeader(lines: string[], questionFirstIndex: number): { ruleIndex: number; region: string[] } {
  let i = questionFirstIndex - 1
  const region: string[] = []
  while (i >= 0 && !RULE_LINE.test(lines[i])) {
    if (lines[i] !== '') region.unshift(lines[i])
    i--
  }
  return { ruleIndex: i, region }
}

// "<header> — <tool call>" from the lines between the dialog's top rule and its question.
function buildSummary(header: { ruleIndex: number; region: string[] }, question: string): string {
  const { ruleIndex, region } = header
  if (ruleIndex < 0 || region.length === 0) return truncateSummary(question)
  return truncateSummary(region.length === 1 ? region[0] : `${region[0]} — ${region[1]}`)
}

function buildContext(lines: string[], ruleIndex: number): string[] {
  if (ruleIndex < 0) return []
  return lines.slice(0, ruleIndex).filter((line) => line !== '').slice(-FINGERPRINT_CONTEXT_LINES)
}

// Strict on purpose: a missed detection is better than a false alarm. Every
// step must pass — the `Esc to cancel` footer near the bottom, consecutively
// numbered options directly above it, and exactly one `❯` among them. It
// never matches on dialog wording, which varies by tool and model.
// `context` is server-side input to the fingerprint only and is never published.
export type DetectedDialog = Omit<ApprovalPrompt, 'session' | 'fingerprint'> & { context: string[] }

export function detectApprovalPrompt(paneText: string): DetectedDialog | null {
  const lines = toCleanLines(paneText)
  const footerIndex = findFooterIndex(lines)
  if (footerIndex < 0) return null
  const options = collectOptions(lines, footerIndex)
  if (!options) return null
  const questionBlock = collectQuestionLines(lines, options.topIndex)
  if (!questionBlock) return null
  const header = findDialogHeader(lines, questionBlock.firstIndex)
  return {
    question: questionBlock.question,
    summary: buildSummary(header, questionBlock.question),
    options: options.options,
    context: buildContext(lines, header.ruleIndex),
  }
}

// One predicate for "can this task's panes be blocked on a dialog", shared by
// the poll and the read-time stamp so a task that just turned done drops its
// prompt on the same refresh.
export function isApprovalPollable(task: Pick<Task, 'status'>): boolean {
  return task.status !== 'done' && task.status !== 'shelved'
}

// A session belongs to the task with the longest slug for which it is
// `worker-<slug>` or `worker-<slug>-<suffix>` (secondary sessions carry
// arbitrary suffixes: -cr2, -qa, -devurl, ...), or whose TMUX_SESSION names
// it exactly. Unmatched sessions — the orchestrator, other claude-* tabs —
// are dropped, so they are never captured.
export function assignSessionsToTasks(
  sessions: Iterable<string>,
  tasks: Pick<Task, 'slug' | 'tmuxSession'>[],
): Map<string, string> {
  const assignments = new Map<string, string>()
  for (const session of sessions) {
    const exact = tasks.find((task) => task.tmuxSession === session)
    if (exact) {
      assignments.set(session, exact.slug)
      continue
    }
    let longestSlug: string | null = null
    for (const { slug } of tasks) {
      const isMatch = session === `worker-${slug}` || session.startsWith(`worker-${slug}-`)
      if (isMatch && (longestSlug === null || slug.length > longestSlug.length)) longestSlug = slug
    }
    if (longestSlug !== null) assignments.set(session, longestSlug)
  }
  return assignments
}

// Assigns against every task, so a lingering session of a finished task is not
// claimed by an active task with a shorter slug; only then drops the sessions
// whose owner is not pollable. The poll and the answer route both judge
// ownership through this one function.
export function assignSessionsToPollableTasks(
  sessions: Iterable<string>,
  tasks: Pick<Task, 'slug' | 'status' | 'tmuxSession'>[],
): Map<string, string> {
  const pollableSlugs = new Set(tasks.filter(isApprovalPollable).map((task) => task.slug))
  return new Map([...assignSessionsToTasks(sessions, tasks)].filter(([, slug]) => pollableSlugs.has(slug)))
}
