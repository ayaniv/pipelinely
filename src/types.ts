export interface Plan {
  total: number
  done: number
  milestones: { label: string; done: boolean }[]
}

export type AutoModeOverride = 'auto' | 'manual' | 'inherit'

// ${TASKS_DIR}/SETTINGS.json — orchestrator-level preferences. One key
// today; JSON because the backlog item asks for a settings file, not a
// setting file.
export interface Settings {
  autoMode: boolean
}

// A single "- [ ] <description> (<date>)" line from BACKLOG.md, with an
// optional indented context line. Ordinarily not a task — no STATUS, no
// worktree — but an entry carrying a `shelved:` marker line points back at
// one that was already dispatched and then taken off the board.
export interface BacklogItem {
  description: string
  date: string | null
  context: string | null
  done: boolean
  // The task dir a shelved entry came from, parsed out of its indented
  // `shelved: <slug>` marker line; null for an ordinary, never-dispatched
  // item. The slug is the whole pointer — repo, branch, plan and worktree
  // path are all already derivable from it.
  shelvedSlug: string | null
  // The project (repo) this item belongs to, parsed from a "[<project>]" prefix
  // on its checklist line; null for an untagged item. Untagged is a permanent,
  // first-class state — capture is deliberately low-friction (see
  // orchestrator-prompt.md's "Backlog"), so an idea can always be recorded
  // before its repo is known.
  project: string | null
}

// One global progress bar (across all tasks) shows whichever multi-milestone
// project is currently active — see computeActiveProject in taskParser.ts.
export interface ActiveProjectProgress {
  projectBase: string
  current: number
  total: number
}

// One card per calendar date on the Done tab — see groupDoneTasksByDate in
// taskParser.ts. dateKey is 'YYYY-MM-DD' (local calendar date) or 'unknown'
// for tasks with no resolvable completedAt.
export interface DoneDateGroup {
  dateKey: string
  label: string   // 'Today' | 'Yesterday' | 'Fri, Jul 18' | 'Fri, Jul 18, 2025' | 'Unknown date'
  tasks: Task[]
}

export type AttentionStatus = 'working' | 'idle' | 'needs-you' | 'paused'

// The eight pipeline stages, in order. A task sits in exactly one at a time.
export type Stage =
  | 'planning'
  | 'plan-review'
  | 'dev'
  | 'qa'
  | 'qa-fixes'
  | 'code-review'
  | 'comment-fix'
  | 'merge'

// One line of the append-only TIMELINE file: when a stage was entered, and an
// optional free-text note the worker recorded with it.
export interface StageEvent {
  stage: Stage
  at: string        // ISO-8601, verbatim from the file
  note: string | null
}

// One Claude session's own metrics. Two sources feed this: the legacy chain
// (the METRICS file plus the METRICS-N.json snapshots /pipelinely-handover writes), and
// the per-session METRICS-<claude-session-id>.json files every session writes
// for itself. The legacy chain records neither a stage nor a session id, so
// those fields are null for its entries.
export interface SessionMetric {
  n: number                  // 1-based, in handover order then startedAt order
  contextPct: number | null  // null when the snapshot never recorded one
  inputTokens: number
  outputTokens: number
  current: boolean           // approximate — see LIVE_SESSION_WINDOW_MS in taskParser.ts
  stage: Stage | null        // which pipeline stage this session ran; null for legacy entries
  sessionId: string | null   // Claude session id; null for legacy entries
  startedAt: string | null   // ISO-8601, verbatim from the file; null for legacy entries
  updatedAt: string | null   // ISO-8601, verbatim from the file; null for legacy entries
}

// One code-review finding, parsed from task-pr-review.md's "Must Fix" /
// "Should Fix" / "Suggestions" bullet lists — see parseFindings in
// taskParser.ts.
export interface Finding {
  severity: 'must' | 'should' | 'suggestion'
  category: string
  description: string
  location: string  // e.g. "cities.ts:88" — verbatim from the backtick-quoted path:line(s);
                     // multiple locations on one finding are comma-joined into this one string
}

// One failing QA case, parsed from QA_REPORT.md's "### Failing Cases" bullet
// list — see parseQaFailures in taskParser.ts. No severity tiering (unlike
// Finding's must/should): a QA case either failed or it didn't.
export interface QaFailure {
  label: string        // e.g. "Case 3" — the bracketed part of the bullet
  description: string
  location: string     // e.g. a case id/slug — verbatim from the backtick-quoted part(s);
                        // multiple locations on one failure are comma-joined into this one string
}

// One QA case (pass or fail), parsed from QA_REPORT.md's combined
// "### Failing Cases" + "### Passing Cases" bullet lists — see parseQaCases
// in taskParser.ts. Unlike QaFailure, this covers every case QA ran, not
// just the failures the qa-fixes checklist triages.
export interface QaCase extends QaFailure {
  passed: boolean
}

// One milestone declared in a task's tech-design.md "## Milestones" section
// — see parseMilestonesContent in taskParser.ts. This is what the plan says;
// MilestoneStatus below is what the dashboard computed about it.
export interface MilestoneDecl {
  id: string               // 'M0', 'M1', ... — always upper-case M + digits
  name: string             // "Rename + Vercel"
  needs: string[]          // declared dependency ids; empty for a root milestone
  estimate: string | null  // verbatim from the plan, e.g. '4h'; null when unstated
  specFile: string | null  // declared "spec:" field — relative e2e file path(s)
                            // this milestone's cases live in, comma-joined if
                            // multiple; null when undeclared
}

// A declared milestone plus everything the dashboard worked out about it:
// which dependency wave it sits in, and which dispatched child task (if any)
// is doing it. Computed on every refresh in parseAllTasks, never stored.
export interface MilestoneStatus extends MilestoneDecl {
  wave: number                              // 1-based, longest-path layering
  task: Task | null                         // the dispatched child, once it exists
  state: 'queued' | 'dispatched' | 'done'
}

// One group in the Plan tab's derived test list — GET /tech-design/:slug's
// testGroups. One group per declared milestone for a fan-out parent (in
// declared order), or exactly one for a flat task's own `**QA Spec:**` line.
// See readSpecTitles in server.ts for how titles/missingSpecFiles are
// resolved from specFile.
export interface PlanTestGroup {
  milestoneId: string | null    // 'M0', 'M1', ...; null for a flat task's group
  name: string | null           // the milestone's declared name; null for a flat task's group
  specFile: string | null       // declared spec path(s), comma-joined if multiple; null when undeclared
  titles: string[]              // test() titles read live from specFile; [] when unreadable or undeclared
  missingSpecFiles: string[]    // specFile path(s) that couldn't be read from any candidate worktree root
  // Lets the client tell "the plan names a file that isn't there" apart from
  // "there is no worktree on disk to look in" (not dispatched yet, or
  // already cleaned up after merge) — the second is normal for a done task
  // and must not read as a broken plan.
  hasWorktree: boolean
}

export interface Task {
  slug: string             // task folder name = iTerm2 tab name
  title: string            // first line of TASK.md (e.g. "# HON-33049: Fix owner role")
  mode: 'investigate' | 'verify' | 'implement' | ''  // from TASK.md; '' when not found
  repo: string             // parsed from TASK.md (line starting with "## Workspace" section or repo: field)
  branch: string           // parsed from TASK.md
  worktree: string | null  // absolute path under WORKTREES_DIR (default ~/Dev/worktrees)/<slug> if that dir exists, else null
  devUrl: string | null    // trimmed contents of DEV_URL file if exists, else null
  verifier: string | null  // first line of the VERIFY file — the command or target that decides whether this task is done. null when the task has no verifier, which the dashboard shows rather than hides.
  itermSessionId: string | null // trimmed contents of ITERM_SESSION file — stable iTerm2 session id for focus
  tmuxSession: string | null // trimmed contents of TMUX_SESSION file — tmux session name, used as a reattach fallback when the iTerm tab is gone but the tmux session backing it is still alive
  plan: Plan | null        // parsed from PLAN.md milestone checklist; null if PLAN.md absent
  stageHistory: StageEvent[]  // parsed TIMELINE entries in file order; empty for task dirs that predate the pipeline
  stage: Stage | null      // computed, never stored — see computeStage in taskParser.ts. null once the task is done.
  findings: (Finding & { selected: boolean })[]  // parsed from task-pr-review.md, selection state merged from TRIAGE.json; [] when there's no review yet
  // Non-empty when a task-pr-review.md section's declared "(N)" heading count
  // disagrees with how many bullets actually parsed for it — a bullet that
  // still doesn't match FINDING_BULLET_RE's shape (even after its
  // bare-location leniency) rather than just a missing-backtick one. See
  // findFindingsParseMismatch in taskParser.ts; rendered as a warning on the
  // CR tab so format drift is never silently dropped.
  findingsParseMismatch: string[]
  qaFailures: (QaFailure & { selected: boolean })[]  // parsed from QA_REPORT.md, selection state merged from QA_TRIAGE.json; [] when there's no QA report yet or all cases passed
  qaCases: QaCase[]        // every case QA_REPORT.md recorded, pass and fail; [] when there's no QA report yet
  qaCasesParseMismatch: string[]  // same idea as findingsParseMismatch, for QA_REPORT.md's Failing/Passing Cases sections — see findQaCasesParseMismatch

  // Multi-milestone project progress — only set when slug matches "<projectBase>-m<N>".
  projectBase?: string      // slug with the trailing "-m<N>" stripped
  milestoneCurrent?: number // N + 1 (this milestone counts as reached)
  milestoneTotal?: number   // milestone count from the repo's plan.md; undefined if unreadable/unparseable

  // Milestone fan-out — set only when THIS task's tech-design.md declares a
  // "## Milestones" section, following the same convention as projectBase /
  // milestoneCurrent / milestoneTotal above: present only for the kind of
  // task it describes, absent otherwise. Absent means the flat 8-stage
  // pipeline, which is every pre-existing task dir.
  milestones?: MilestoneStatus[]

  // A dispatched milestone child's own card needs to self-identify in a
  // mixed grid ("which project is this"). Populated in parseAllTasks's
  // second pass, the same place computeMilestones stitches the child on —
  // both need to see the whole task list to find one another. Absent for
  // every task that isn't a dispatched milestone child.
  projectTitle?: string

  // Relative e2e file path(s) (comma-joined if multiple) that hold this
  // task's planned QA cases, letting the dashboard preview case titles
  // before QA_REPORT.md exists. For a flat task this is read directly off
  // its own tech-design.md (parseQaSpecFile); for a milestone child it has
  // no tech-design.md of its own, so it's stitched on in parseAllTasks's
  // second pass from its declaration's `spec:` field, same place/reason as
  // projectTitle above. null when undeclared either way.
  qaSpecFile?: string | null

  // The main-grid filter, computed once so renderDashboard never re-derives
  // the rule client-side. True for every plain task and every milestone
  // child; false only for a milestone-declaring parent once none of its own
  // declared milestones remain 'queued' — see shouldShowOnBoard below.
  showsOnBoard: boolean

  // "Does this need me right now", replacing the raw STATUS value on the
  // card's badge row. See computeAttentionStatus below.
  attentionStatus: AttentionStatus

  // ${TASKS_DIR}/<slug>/AUTO_MODE — this task's own answer, or 'inherit'
  // when it doesn't have one. 'inherit' is a real state, not a missing
  // value, which is why this is a union and not boolean | null.
  autoModeOverride: AutoModeOverride
  // The resolved answer for THIS task: computeEffectiveAutoMode(override,
  // settings.autoMode). Computed in parseAllTasks, never stored — the
  // client reads this rather than re-deriving the rule, so there is no
  // third copy of it to drift (cf. NEXT_STAGE_BY_WAITING_REASON's
  // hand-mirrored client copy and the lockstep test that guards it).
  autoMode: boolean

  // from STATUS file
  // 'shelved' is a bare STATUS word (like 'done'/'review', not a
  // "<key>: <reason>" template): the task was deliberately taken off both
  // board tabs and recorded as a BACKLOG.md entry, with its task dir and
  // branch left intact. No reason is captured — see shouldShowOnBoard.
  status: 'working' | 'waiting' | 'paused' | 'review' | 'done' | 'handover' | 'shelved'
  waitingReason?: string   // text after "waiting: " prefix (trimmed) — blocked on a decision only the user can make
  pausedReason?: string    // text after "paused: " prefix (trimmed) — the user deliberately set this task aside; distinct from waiting because a "Resume" CTA only makes sense here
  reviewRef?: string       // text after "review: " prefix — a PR URL or number, when the worker recorded one
  doneNote?: string        // text after "done: " prefix (trimmed) — the worker's closing note, e.g. what merged and what didn't
  handoverSession?: number // number parsed from "handover: session #N" pattern
  updatedAt: Date          // mtime of STATUS file
  orphaned?: boolean       // status is 'working' but both the iTerm tab AND any backing tmux session are gone — likely finished without reporting done. A closed tab with a still-live tmux session is NOT orphaned (see isOrphaned in taskParser.ts).

  // Completion date for done tasks — see resolveCompletionDate in
  // taskParser.ts. null for tasks that are not yet done.
  completedAt: string | null        // ISO timestamp: merge-commit date if resolvable, else STATUS mtime
  completedAtSource: 'merge-commit' | 'status-mtime' | null

  // from METRICS + METRICS-N.json (cumulative across handovers)
  contextPct?: number      // from METRICS file: contextPct field (0-100)
  model?: string           // from METRICS file: model field
  totalInputTokens: number // sum of inputTokens from METRICS + all METRICS-*.json
  totalOutputTokens: number
  metricsUpdatedAt?: Date  // mtime of METRICS file (current session only)
  sessions: SessionMetric[]  // per-session context and token history; [] when the task has no METRICS at all
}
