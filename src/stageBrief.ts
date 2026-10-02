import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parseMilestoneSlug, parseTaskMdContent } from './taskParser.js'
import { STAGE_SKILL_DIR } from './stageScope.js'

const execFileAsync = promisify(execFile)

const TEMPLATE_START_MARKER = '<!-- brief-template:start -->'
const TEMPLATE_END_MARKER = '<!-- brief-template:end -->'
const NONE_RECORDED = 'none recorded'
const BRIEF_FILE = 'TASK-cr.md'
const INTENT_FILE = 'INTENT.md'
const REVIEW_REPORT_FILE = 'task-pr-review.md'

// plan-review and QA still overwrite TASK.md with "<title> — <stage>" until
// slice 2, so a TASK.md carrying this suffix says nothing about the original
// request and its title must not leak into the brief.
const STAGE_SUFFIX_RE = /\s+—\s+(?:code review|QA|plan review)$/i

// The implementation session's own working files: a fresh review must not
// inherit the reasoning in them. Order is the order they render in.
const DEV_ARTIFACTS = ['TASK.md', 'TASK-dev.md', 'HANDOVER-*.md', 'METRICS*'] as const
const TRANSCRIPT_ENTRY = 'any Claude transcript for this task (`~/.claude/projects/*`)'

// The closed set of placeholders a brief template may use. A typo in the
// skill must fail loudly here instead of shipping a literal `{{...}}` to a
// reviewer.
const PLACEHOLDERS = [
  'title',
  'repo',
  'branch',
  'prNumber',
  'worktree',
  'taskDir',
  'intentBlock',
  'planLine',
  'verifyLine',
  'priorReviewBlock',
  'doNotRead',
] as const
type Placeholder = (typeof PLACEHOLDERS)[number]
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

export type BriefValues = Record<string, string>

// The only inputs a brief is built from: a stage, a task, a PR number and
// where things live. No free-text parameter on purpose — a brief derived from
// files cannot carry the dev worker's own account of what it built.
export interface StageBriefOptions {
  stage: 'code-review'
  slug: string
  prNumber: number
  tasksDir: string
  worktreesDir: string
  skillsDir: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function readTextIfPresent(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return (await readTextIfPresent(filePath)) !== null
}

export function extractBriefTemplate(skillMd: string, skillPath: string): string {
  const starts = skillMd.split(TEMPLATE_START_MARKER).length - 1
  const ends = skillMd.split(TEMPLATE_END_MARKER).length - 1
  if (starts !== 1 || ends !== 1) {
    throw new Error(
      `${skillPath} must contain exactly one ${TEMPLATE_START_MARKER} / ${TEMPLATE_END_MARKER} pair (found ${starts} start, ${ends} end)`
    )
  }
  const afterStart = skillMd.slice(skillMd.indexOf(TEMPLATE_START_MARKER) + TEMPLATE_START_MARKER.length)
  const endIndex = afterStart.indexOf(TEMPLATE_END_MARKER)
  if (endIndex === -1) throw new Error(`${skillPath}: ${TEMPLATE_END_MARKER} comes before ${TEMPLATE_START_MARKER}`)
  return afterStart.slice(0, endIndex).replace(/^\n/, '').replace(/\n$/, '')
}

// Single pass with a function replacer: a value that itself contains `{{...}}`
// (a commit subject, a path) is never re-expanded.
export function renderBriefTemplate(template: string, values: BriefValues): string {
  return template.replace(PLACEHOLDER_RE, (_match, name: string) => {
    if (!(PLACEHOLDERS as readonly string[]).includes(name) || !(name in values)) {
      throw new Error(`Unknown brief placeholder {{${name}}}`)
    }
    return values[name as Placeholder]
  })
}

function stripStageSuffix(title: string): string {
  return title.replace(STAGE_SUFFIX_RE, '')
}

function hasStageSuffix(title: string): boolean {
  return STAGE_SUFFIX_RE.test(title)
}

// A TASK.md is only a record of the original request while no stage has
// overwritten it.
async function isOriginalBrief(taskMdPath: string): Promise<boolean> {
  const content = await readTextIfPresent(taskMdPath)
  return content !== null && !hasStageSuffix(parseTaskMdContent(content).title)
}

interface TaskLocations {
  slug: string
  taskDir: string
  parentTaskDir: string | null
  worktree: string
}

function locateTask(opts: StageBriefOptions): TaskLocations {
  const milestone = parseMilestoneSlug(opts.slug)
  return {
    slug: opts.slug,
    taskDir: path.join(opts.tasksDir, opts.slug),
    parentTaskDir: milestone ? path.join(opts.tasksDir, milestone.projectBase) : null,
    worktree: path.join(opts.worktreesDir, opts.slug),
  }
}

interface IntentBlock {
  text: string
  // Dev artifacts the block names as intent sources; they leave "Do not read".
  namedSources: readonly string[]
}

async function buildIntentBlock(where: TaskLocations): Promise<IntentBlock> {
  const intentPath = path.join(where.taskDir, INTENT_FILE)
  const parentIntentPath = where.parentTaskDir ? path.join(where.parentTaskDir, INTENT_FILE) : null
  const hasParentIntent = parentIntentPath !== null && (await fileExists(parentIntentPath))

  if (await fileExists(intentPath)) {
    const lines = [`- Intent: ${intentPath}`]
    if (hasParentIntent) lines.push(`- Parent intent: ${parentIntentPath}`)
    return { text: lines.join('\n'), namedSources: [] }
  }

  const taskMdPath = path.join(where.taskDir, 'TASK.md')
  const devBriefPath = path.join(where.taskDir, 'TASK-dev.md')
  const worktreeTaskMdPath = path.join(where.worktree, 'TASK.md')
  const ownPlanPath = path.join(where.taskDir, 'tech-design.md')
  const parentPlanPath = where.parentTaskDir ? path.join(where.parentTaskDir, 'tech-design.md') : null

  const candidates: { path: string; devArtifact?: (typeof DEV_ARTIFACTS)[number]; isUsable: () => Promise<boolean> }[] = [
    { path: taskMdPath, devArtifact: 'TASK.md', isUsable: () => isOriginalBrief(taskMdPath) },
    { path: devBriefPath, devArtifact: 'TASK-dev.md', isUsable: () => fileExists(devBriefPath) },
    { path: worktreeTaskMdPath, isUsable: () => isOriginalBrief(worktreeTaskMdPath) },
    { path: ownPlanPath, isUsable: () => fileExists(ownPlanPath) },
  ]
  if (parentPlanPath) candidates.push({ path: parentPlanPath, isUsable: () => fileExists(parentPlanPath) })
  if (parentIntentPath && hasParentIntent) candidates.push({ path: parentIntentPath, isUsable: () => Promise.resolve(true) })

  const sources: string[] = []
  const namedSources: (typeof DEV_ARTIFACTS)[number][] = []
  let hasOwnPlan = false
  for (const candidate of candidates) {
    // The parent's plan is a fallback for the task's own, not an addition.
    if (candidate.path === parentPlanPath && hasOwnPlan) continue
    if (!(await candidate.isUsable())) continue
    sources.push(`- Source: ${candidate.path}`)
    if (candidate.devArtifact) namedSources.push(candidate.devArtifact)
    if (candidate.path === ownPlanPath) hasOwnPlan = true
  }

  const text = [
    '**NO RECORDED INTENT.** This task predates `INTENT.md`, so the developer\'s original request was never saved. Reconstruct it from the sources below, best first.',
    ...(sources.length > 0 ? sources : ['- (no source files found)']),
    'The PR body is the author\'s claim, not intent. Report `**Intent: NO RECORDED INTENT**` and name the source you used.',
  ].join('\n')
  return { text, namedSources }
}

function buildDoNotRead(namedSources: readonly string[]): string {
  const entries = [...DEV_ARTIFACTS.filter((name) => !namedSources.includes(name)).map((name) => `\`${name}\``), TRANSCRIPT_ENTRY]
  const leading = entries.slice(0, -1)
  const list = leading.length > 0 ? `${leading.join(', ')}, or ${entries.at(-1)}` : entries[0]
  return list
}

async function readVerifyLine(taskDir: string): Promise<string> {
  const verify = await readTextIfPresent(path.join(taskDir, 'VERIFY'))
  const firstLine = verify?.split('\n').find((line) => line.trim() !== '')
  return firstLine ? `\`${firstLine.trim()}\`` : NONE_RECORDED
}

async function buildPlanLine(where: TaskLocations): Promise<string> {
  const candidates = [path.join(where.taskDir, 'tech-design.md')]
  if (where.parentTaskDir) candidates.push(path.join(where.parentTaskDir, 'tech-design.md'))
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  return NONE_RECORDED
}

// The cutoff for "what changed since the last review" is the CR session's own
// TIMELINE line, not the report's mtime: pipelinely-cr-fixes rewrites the report
// after it pushes its fix commits, so the mtime is later than the very
// commits round 2 has to list.
async function findLastReviewTimestamp(taskDir: string): Promise<string | null> {
  const timeline = await readTextIfPresent(path.join(taskDir, 'TIMELINE'))
  const reviewLines = (timeline ?? '').split('\n').filter((line) => /^\S+\s+code-review\b/.test(line))
  return reviewLines.length > 0 ? reviewLines.at(-1)!.split(/\s+/)[0] : null
}

async function listCommitsSince(worktree: string, since: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', worktree, 'log', '--first-parent', '--format=%h %s', `--since=${since}`, 'HEAD'])
  const commits = stdout.trim()
  return commits === '' ? '(none)' : commits.split('\n').map((line) => `  - ${line}`).join('\n')
}

async function describeCommitsSinceReview(where: TaskLocations): Promise<string> {
  try {
    const since = await findLastReviewTimestamp(where.taskDir)
    if (since === null) throw new Error('no code-review entry in TIMELINE')
    const commits = await listCommitsSince(where.worktree, since)
    return commits === '(none)' ? 'Commits since that report: (none)' : `Commits since that report:\n${commits}`
  } catch (err) {
    const reason = errorMessage(err).split('\n')[0]
    console.error(`stage-brief: cannot list commits since the last review of ${where.slug}: ${reason}`)
    return `Commits since that report: unavailable (${reason})`
  }
}

async function buildPriorReviewBlock(where: TaskLocations): Promise<string> {
  const reportPath = path.join(where.taskDir, REVIEW_REPORT_FILE)
  if (!(await fileExists(reportPath))) return ''
  return [
    '',
    '## Prior review',
    `- Prior report: \`${reportPath}\` — verify each item: fixed, not fixed, or no longer applies.`,
    `- ${await describeCommitsSinceReview(where)}`,
  ].join('\n')
}

async function readTaskFields(where: TaskLocations): Promise<{ title: string; repo: string; branch: string }> {
  const taskMdPath = path.join(where.taskDir, 'TASK.md')
  const taskMd = await readTextIfPresent(taskMdPath)
  if (taskMd === null) throw new Error(`No ${taskMdPath}: without it the task's repo is unknown`)
  const fields = parseTaskMdContent(taskMd)
  return { title: stripStageSuffix(fields.title), repo: fields.repo, branch: fields.branch || `claude/${where.slug}` }
}

export async function writeStageBrief(opts: StageBriefOptions): Promise<string> {
  const where = locateTask(opts)
  const skillPath = path.join(opts.skillsDir, STAGE_SKILL_DIR[opts.stage]!, 'SKILL.md')
  const template = extractBriefTemplate(await fs.readFile(skillPath, 'utf-8'), skillPath)

  const { title, repo, branch } = await readTaskFields(where)
  const intent = await buildIntentBlock(where)
  const values: BriefValues = {
    title,
    repo,
    branch,
    prNumber: String(opts.prNumber),
    worktree: where.worktree,
    taskDir: where.taskDir,
    intentBlock: intent.text,
    planLine: await buildPlanLine(where),
    verifyLine: await readVerifyLine(where.taskDir),
    priorReviewBlock: await buildPriorReviewBlock(where),
    doNotRead: buildDoNotRead(intent.namedSources),
  }

  const briefPath = path.join(where.taskDir, BRIEF_FILE)
  await fs.writeFile(briefPath, `${renderBriefTemplate(template, values)}\n`)
  return briefPath
}
