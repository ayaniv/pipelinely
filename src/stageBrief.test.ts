import { describe, it, expect, expectTypeOf, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeStageBrief, extractBriefTemplate, renderBriefTemplate, isBriefStage } from './stageBrief.js'
import { INTENT_BRIEF_STAGES } from './nextAction.js'
import { parseTaskMdContent } from './taskParser.js'

const REAL_SKILLS_DIR = path.resolve(import.meta.dirname, '..', '.claude', 'skills')
const TSX_BIN = path.resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
const CLI_PATH = path.resolve(import.meta.dirname, 'stageBriefCli.ts')

const SLUG = 'some-task'
const PARENT_SLUG = 'big-feature'
const CHILD_SLUG = `${PARENT_SLUG}-m1`
const PR_NUMBER = 42
const BRANCH = `claude/${SLUG}`
const VERIFY_COMMAND = 'npx vitest run src/foo.test.ts'

// Every placeholder the renderer fills, in a template small enough to read
// at a glance. The real template lives in pipelinely-cr/SKILL.md; the "real
// skill" describe block below renders that one too.
const FIXTURE_TEMPLATE = [
  '# {{title}} — code review',
  '',
  '## Workspace',
  '- Repo: {{repo}}',
  '- PR: #{{prNumber}}',
  '- Worktree: {{worktree}}',
  '',
  '## Intent (read these first)',
  '{{intentBlock}}',
  '- Approved plan: {{planLine}}',
  '- Verifier: {{verifyLine}}',
  '{{priorReviewBlock}}',
  '',
  '## Do not read',
  '{{doNotRead}}',
  '',
  '## Steps',
  '1. cd into {{worktree}}',
  '2. Write the report to {{taskDir}}/task-pr-review.md',
  '',
  '## Branch (last line the dashboard reads)',
  '- Branch: {{branch}}',
].join('\n')

function skillWithTemplate(template: string): string {
  return ['# Cockpit CR', '', '```', '<!-- brief-template:start -->', template, '<!-- brief-template:end -->', '```', ''].join('\n')
}

// Names a review session must never be pointed at as an input: they carry
// the implementation session's own reasoning.
const DEV_ARTIFACT_PATTERNS = [/\bTASK\.md\b/, /TASK-dev\.md/, /HANDOVER-/, /METRICS/, /\.claude\/projects/]

function sectionLineRange(content: string, heading: string): [number, number] {
  const lines = content.split('\n')
  const start = lines.indexOf(heading)
  if (start === -1) return [-1, -1]
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i
      break
    }
  }
  return [start, end]
}

function linesOutsideSection(content: string, heading: string): string[] {
  const [start, end] = sectionLineRange(content, heading)
  return content.split('\n').filter((_line, i) => i < start || i >= end)
}

function git(cwd: string, args: string[], date?: string): string {
  const env = date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env
  return execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf-8' })
}

describe('stageBrief — code-review brief', () => {
  let rootDir: string
  let tasksDir: string
  let worktreesDir: string
  let skillsDir: string
  let taskDir: string
  let worktree: string

  function writeTaskFile(slug: string, name: string, content: string): void {
    fs.mkdirSync(path.join(tasksDir, slug), { recursive: true })
    fs.writeFileSync(path.join(tasksDir, slug, name), content)
  }

  function writeSkill(template: string): void {
    fs.mkdirSync(path.join(skillsDir, 'pipelinely-cr'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'pipelinely-cr', 'SKILL.md'), skillWithTemplate(template))
  }

  function render(slug = SLUG, dirs: { tasksDir: string; worktreesDir: string; skillsDir: string } = { tasksDir, worktreesDir, skillsDir }) {
    return writeStageBrief({ stage: 'code-review', slug, prNumber: PR_NUMBER, ...dirs })
  }

  function readBrief(slug = SLUG): string {
    return fs.readFileSync(path.join(tasksDir, slug, 'TASK-cr.md'), 'utf-8')
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-brief-')))
    tasksDir = path.join(rootDir, 'tasks')
    worktreesDir = path.join(rootDir, 'worktrees')
    skillsDir = path.join(rootDir, 'skills')
    taskDir = path.join(tasksDir, SLUG)
    worktree = path.join(worktreesDir, SLUG)
    fs.mkdirSync(worktree, { recursive: true })
    writeSkill(FIXTURE_TEMPLATE)

    // TASK.md here was already overwritten by plan-review (slice 1 doesn't
    // stop that), which is exactly why the title's stage suffix is stripped.
    writeTaskFile(SLUG, 'TASK.md', [`# Some task — plan review`, '', '## Workspace', '- Repo: cockpit-ai', `- Branch: ${BRANCH}`, ''].join('\n'))
    writeTaskFile(SLUG, 'INTENT.md', '# Intent: Some task\n\n## Original request (verbatim)\n> do the thing\n')
    writeTaskFile(SLUG, 'tech-design.md', '# Some task\n\n## Summary\nPlan.\n')
    writeTaskFile(SLUG, 'VERIFY', `${VERIFY_COMMAND}\nsecond line is ignored\n`)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    for (const dir of [taskDir, path.join(tasksDir, CHILD_SLUG)]) {
      if (fs.existsSync(dir)) fs.chmodSync(dir, 0o755)
    }
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  describe('inputs it names', () => {
    it('names the absolute INTENT.md, the approved tech-design.md, VERIFY\'s first line, the PR and the worktree', async () => {
      await render()
      const brief = readBrief()

      expect(brief).toContain(path.join(taskDir, 'INTENT.md'))
      expect(brief).toContain(`- Approved plan: ${path.join(taskDir, 'tech-design.md')}`)
      expect(brief).toContain(`- Verifier: \`${VERIFY_COMMAND}\``)
      expect(brief).not.toContain('second line is ignored')
      expect(brief).toContain(`- PR: #${PR_NUMBER}`)
      expect(brief).toContain(`- Worktree: ${worktree}`)
      expect(brief).toContain(`${taskDir}/task-pr-review.md`)
      expect(brief.split('\n')[0]).toBe('# Some task — code review')
    })

    it('for a <parent>-m<N> child, names both its own and the parent INTENT.md, and falls back to the parent plan', async () => {
      writeTaskFile(PARENT_SLUG, 'INTENT.md', '# Intent: Big feature\n')
      writeTaskFile(PARENT_SLUG, 'tech-design.md', '# Big feature\n\n## Milestones\n- M1: Child\n')
      writeTaskFile(CHILD_SLUG, 'TASK.md', `# Child\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: claude/${CHILD_SLUG}\n`)
      writeTaskFile(CHILD_SLUG, 'INTENT.md', '# Intent: Child\n')
      fs.mkdirSync(path.join(worktreesDir, CHILD_SLUG), { recursive: true })

      await render(CHILD_SLUG)
      const brief = readBrief(CHILD_SLUG)

      expect(brief).toContain(path.join(tasksDir, CHILD_SLUG, 'INTENT.md'))
      expect(brief).toContain(path.join(tasksDir, PARENT_SLUG, 'INTENT.md'))
      expect(brief).toContain(`- Approved plan: ${path.join(tasksDir, PARENT_SLUG, 'tech-design.md')}`)
    })

    it('says "none recorded" when there is no VERIFY and no tech-design.md', async () => {
      fs.rmSync(path.join(taskDir, 'VERIFY'))
      fs.rmSync(path.join(taskDir, 'tech-design.md'))

      await render()
      const brief = readBrief()

      expect(brief).toContain('- Verifier: none recorded')
      expect(brief).toContain('- Approved plan: none recorded')
    })
  })

  describe('exclusions', () => {
    it('mentions TASK.md, TASK-dev.md, HANDOVER-*, METRICS* and Claude transcripts only inside "## Do not read"', async () => {
      writeTaskFile(SLUG, 'TASK-dev.md', '# dev brief\n')
      writeTaskFile(SLUG, 'HANDOVER-1.md', 'handover\n')
      writeTaskFile(SLUG, 'METRICS', '{}\n')

      await render()
      const brief = readBrief()

      const [start] = sectionLineRange(brief, '## Do not read')
      expect(start).toBeGreaterThan(-1)
      const outside = linesOutsideSection(brief, '## Do not read').join('\n')
      for (const pattern of DEV_ARTIFACT_PATTERNS) expect(outside).not.toMatch(pattern)
      const [doNotStart, doNotEnd] = sectionLineRange(brief, '## Do not read')
      const inside = brief.split('\n').slice(doNotStart, doNotEnd).join('\n')
      for (const pattern of DEV_ARTIFACT_PATTERNS) expect(inside).toMatch(pattern)
    })

    it('takes no free-text input: its only parameters are the stage, the slug, the PR number (code review only) and three directories', () => {
      type Locations = { slug: string; tasksDir: string; worktreesDir: string; skillsDir: string }
      expectTypeOf(writeStageBrief).parameter(0).toEqualTypeOf<Locations & ({ stage: 'code-review'; prNumber: number } | { stage: 'merge-conflicts' })>()
    })
  })

  describe('legacy task with no INTENT.md', () => {
    beforeEach(() => {
      fs.rmSync(path.join(taskDir, 'INTENT.md'))
    })

    it('still renders (never refuses), with a loud NO RECORDED INTENT block listing the best available sources', async () => {
      writeTaskFile(SLUG, 'TASK-dev.md', '# Some task\n')

      await render()
      const brief = readBrief()

      expect(brief).toContain('NO RECORDED INTENT')
      expect(brief).toContain(path.join(taskDir, 'TASK-dev.md'))
      expect(brief).toContain(path.join(taskDir, 'tech-design.md'))
      expect(brief).not.toContain(path.join(taskDir, 'INTENT.md'))
    })

    it('does not offer a TASK.md that a stage already overwrote (its title carries a stage suffix) as a source', async () => {
      await render()
      const [start, end] = sectionLineRange(readBrief(), '## Intent (read these first)')
      const intentSection = readBrief().split('\n').slice(start, end).join('\n')

      expect(intentSection).not.toContain(path.join(taskDir, 'TASK.md'))
    })

    it('offers an original-brief TASK.md (no stage suffix) as a source and drops it from "## Do not read"', async () => {
      writeTaskFile(SLUG, 'TASK.md', `# Some task\n\n## Workspace\n- Repo: cockpit-ai\n- Branch: ${BRANCH}\n`)

      await render()
      const brief = readBrief()
      const [start, end] = sectionLineRange(brief, '## Do not read')
      const doNotRead = brief.split('\n').slice(start, end).join('\n')

      expect(brief).toContain(path.join(taskDir, 'TASK.md'))
      expect(doNotRead).not.toMatch(/\bTASK\.md\b/)
    })
  })

  describe('round 2 and later (derived from files, never from text)', () => {
    const FIRST_COMMIT_DATE = '2026-09-01T10:00:00Z'
    const REVIEW_FINISHED_AT = '2026-09-02T10:00:00Z'
    const FIX_COMMIT_DATE = '2026-09-03T10:00:00Z'
    // pipelinely-cr-fixes rewrites task-pr-review.md AFTER it pushes, so the
    // report's own mtime is later than the very commits round 2 must list.
    const REPORT_REWRITTEN_BY_CR_FIXES = new Date('2026-09-04T10:00:00Z')

    function writePriorReport(content = '## Code Review\n\n**Verdict: CHANGES REQUIRED**\n'): string {
      const reportPath = path.join(taskDir, 'task-pr-review.md')
      fs.writeFileSync(reportPath, content)
      fs.utimesSync(reportPath, REPORT_REWRITTEN_BY_CR_FIXES, REPORT_REWRITTEN_BY_CR_FIXES)
      return reportPath
    }

    beforeEach(() => {
      git(worktree, ['init', '-q', '-b', 'main'])
      git(worktree, ['config', 'user.email', 'test@example.com'])
      git(worktree, ['config', 'user.name', 'Test'])
      fs.writeFileSync(path.join(worktree, 'a.txt'), 'a\n')
      git(worktree, ['add', '.'])
      git(worktree, ['commit', '-q', '-m', 'feat: first implementation'], FIRST_COMMIT_DATE)
      fs.writeFileSync(path.join(worktree, 'a.txt'), 'b\n')
      git(worktree, ['commit', '-q', '-am', 'Merge origin/master into claude/some-other-branch'], FIX_COMMIT_DATE)
      writeTaskFile(SLUG, 'TIMELINE', [
        '2026-08-31T10:00:00Z dev PR #42 opened',
        `${REVIEW_FINISHED_AT} code-review changes required: 1 must-fix`,
        '2026-09-03T11:00:00Z comment-fix fixed 1',
        '',
      ].join('\n'))
    })

    it('has no prior-review block on round 1', async () => {
      await render()

      expect(readBrief()).not.toContain('Prior report')
    })

    it('points at an existing task-pr-review.md as "prior report: verify each item" and lists only commits after the last code-review TIMELINE entry (not the report mtime)', async () => {
      const reportPath = writePriorReport()

      await render()
      const brief = readBrief()

      expect(brief).toContain(reportPath)
      expect(brief).toMatch(/verify each item/i)
      expect(brief).toContain('Merge origin/master into claude/some-other-branch')
      expect(brief).not.toContain('feat: first implementation')
    })

    it('still points at the prior report, saying the commits are unavailable, when TIMELINE has no code-review entry', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      writeTaskFile(SLUG, 'TIMELINE', '2026-08-31T10:00:00Z dev PR #42 opened\n')
      const reportPath = writePriorReport()

      await render()
      const brief = readBrief()

      expect(brief).toContain(reportPath)
      expect(brief).toMatch(/commits since that report: unavailable/i)
      expect(errorSpy).toHaveBeenCalled()
    })

    it('a stray branch-prefix phrase from git log never becomes the parsed branch: the brief ends with the real Branch line', async () => {
      writePriorReport('**Verdict: CHANGES REQUIRED**\n')

      await render()
      const brief = readBrief()

      expect(parseTaskMdContent(brief).branch).toBe(BRANCH)
      expect(parseTaskMdContent(brief).repo).toBe('cockpit-ai')
      expect(brief.trimEnd().split('\n').at(-1)).toBe(`- Branch: ${BRANCH}`)
    })

    it('still renders, saying the commits are unavailable and logging why, when git log fails', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      writePriorReport('**Verdict: CHANGES REQUIRED**\n')
      fs.rmSync(worktree, { recursive: true, force: true })

      await render()

      expect(readBrief()).toMatch(/commits since that report: unavailable/i)
      expect(errorSpy).toHaveBeenCalled()
    })
  })

  describe('side effects and determinism', () => {
    it('writes only TASK-cr.md: TASK.md, INTENT.md and every other file are byte-identical afterwards', async () => {
      const before = new Map(fs.readdirSync(taskDir).map((name) => [name, fs.readFileSync(path.join(taskDir, name))]))

      await render()

      const after = fs.readdirSync(taskDir)
      expect(after.sort()).toEqual([...before.keys(), 'TASK-cr.md'].sort())
      for (const [name, bytes] of before) expect(fs.readFileSync(path.join(taskDir, name)).equals(bytes), name).toBe(true)
    })

    it('is byte-identical across two calls on the same task dir', async () => {
      await render()
      const first = readBrief()
      await render()

      expect(readBrief()).toBe(first)
    })

    it('renders byte-equal briefs for two identical task dirs, modulo their root (auto and manual dispatch share this one renderer)', async () => {
      const otherRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-brief-twin-')))
      try {
        fs.cpSync(rootDir, otherRoot, { recursive: true })
        const twin = { tasksDir: path.join(otherRoot, 'tasks'), worktreesDir: path.join(otherRoot, 'worktrees'), skillsDir: path.join(otherRoot, 'skills') }

        await render()
        await render(SLUG, twin)
        const twinBrief = fs.readFileSync(path.join(twin.tasksDir, SLUG, 'TASK-cr.md'), 'utf-8')

        expect(twinBrief.split(otherRoot).join(rootDir)).toBe(readBrief())
      } finally {
        fs.rmSync(otherRoot, { recursive: true, force: true })
      }
    })
  })

  describe('template failures', () => {
    it('throws, naming the markers, and writes nothing when the skill has no brief-template markers', async () => {
      fs.writeFileSync(path.join(skillsDir, 'pipelinely-cr', 'SKILL.md'), '# Cockpit CR\n\nNo template here.\n')

      await expect(render()).rejects.toThrow(/brief-template/)
      expect(fs.existsSync(path.join(taskDir, 'TASK-cr.md'))).toBe(false)
    })

    it('throws, naming the placeholder, when the template uses one the renderer does not know', async () => {
      writeSkill(`${FIXTURE_TEMPLATE}\n{{orchestratorNotes}}`)

      await expect(render()).rejects.toThrow(/orchestratorNotes/)
      expect(fs.existsSync(path.join(taskDir, 'TASK-cr.md'))).toBe(false)
    })

    it('extractBriefTemplate returns exactly the text between the markers', () => {
      expect(extractBriefTemplate(skillWithTemplate('a\n{{title}}\nb'), 'SKILL.md')).toBe('a\n{{title}}\nb')
    })

    it('renderBriefTemplate never re-expands a placeholder that appears inside a filled-in value', () => {
      expect(renderBriefTemplate('{{title}} {{repo}}', { title: '{{repo}}', repo: 'r' })).toBe('{{repo}} r')
    })
  })

  describe('the real pipelinely-cr template', () => {
    it('renders against the real SKILL.md, ends with the real Branch line, and keeps dev artifacts inside "## Do not read"', async () => {
      await render(SLUG, { tasksDir, worktreesDir, skillsDir: REAL_SKILLS_DIR })
      const brief = readBrief()

      expect(brief).toContain(path.join(taskDir, 'INTENT.md'))
      expect(brief).not.toMatch(/\{\{\w+\}\}/)
      expect(parseTaskMdContent(brief).branch).toBe(BRANCH)
      expect(brief.trimEnd().split('\n').at(-1)).toBe(`- Branch: ${BRANCH}`)
      const outside = linesOutsideSection(brief, '## Do not read').join('\n')
      for (const pattern of DEV_ARTIFACT_PATTERNS) expect(outside).not.toMatch(pattern)
      expect(brief).toMatch(/\*\*Intent: SATISFIED \| PARTIAL \| NOT MET \| NO RECORDED INTENT\*\*/)
      expect(brief).toContain('[Intent]')
      expect(brief).toContain('INTENT.md:<line>')
    })

    it('keeps the current Status wording verbatim (approved-with-comments routes to cr-fixes)', async () => {
      await render(SLUG, { tasksDir, worktreesDir, skillsDir: REAL_SKILLS_DIR })
      const brief = readBrief()

      expect(brief).toContain('waiting: CR found <n> must-fix comments, triage and dispatch cr-fixes')
      expect(brief).toContain('waiting: CR approved, ready for QA')
      expect(brief).toContain('waiting: CR approved with comments, triage and dispatch cr-fixes')
    })
  })

  describe('stage-brief CLI', () => {
    function runCli(args: string[]) {
      const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: tasksDir, WORKTREES_DIR: worktreesDir }
      const result = spawnSync(TSX_BIN, [CLI_PATH, ...args], { env, cwd: rootDir, encoding: 'utf-8' })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    }

    it('writes <tasks-dir>/<slug>/TASK-cr.md from the real skill and prints its path', () => {
      const result = runCli(['code-review', SLUG, String(PR_NUMBER)])

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(path.join(taskDir, 'TASK-cr.md'))
      expect(fs.existsSync(path.join(taskDir, 'TASK-cr.md'))).toBe(true)
    })

    it.each([
      ['an unsupported stage', ['qa', SLUG, '42']],
      ['an unsafe slug', ['code-review', '..', '42']],
      ['a PR that is not a positive integer', ['code-review', SLUG, '42; rm -rf /']],
      ['a missing PR number', ['code-review', SLUG]],
      ['a task that does not exist', ['code-review', 'no-such-task', '42']],
    ])('exits 1 with one logged stderr line and writes nothing for %s', (_label, args) => {
      const result = runCli(args)

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).not.toBe('')
      expect(fs.existsSync(path.join(taskDir, 'TASK-cr.md'))).toBe(false)
    })

    it('exits 1 naming TASK-cr.md when the task dir cannot be written', () => {
      fs.chmodSync(taskDir, 0o555)

      const result = runCli(['code-review', SLUG, String(PR_NUMBER)])

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('TASK-cr.md')
    })
  })
})

describe('stageBrief — merge-conflicts brief', () => {
  const MERGE_SLUG = 'conflicted-task'
  const MERGE_BRANCH = `claude/${MERGE_SLUG}`
  const MERGE_PR = 149
  const PREVIOUS_STATUS = 'waiting: fixes pushed, ready to re-run QA'
  // A conflicting path that itself looks like a branch ("fix/…"): the brief
  // must still end with the real Branch line, so the parser's last-match rule
  // reads the task's own branch.
  const CONFLICTED_FILES = ['fix/strategy.ts', 'web/src/stageView.ts']

  const MERGE_TEMPLATE = [
    '# {{title}} — merge conflicts',
    '- Repo: {{repo}}',
    '- PR: #{{prNumber}}',
    '- Worktree: {{worktree}}',
    '{{intentBlock}}',
    '- Approved plan: {{planLine}}',
    '- Verifier: {{verifyLine}}',
    '## Conflicting files (base: {{baseRef}})',
    '{{conflictingFiles}}',
    '## Status',
    'restore `{{previousStatus}}` to {{taskDir}}/STATUS',
    '- Branch: {{branch}}',
  ].join('\n')

  let rootDir: string
  let tasksDir: string
  let worktreesDir: string
  let skillsDir: string
  let taskDir: string
  let worktree: string

  function writeTaskFile(name: string, content: string): void {
    fs.writeFileSync(path.join(taskDir, name), content)
  }

  function writeMergeSkill(template: string): void {
    fs.mkdirSync(path.join(skillsDir, 'pipelinely-merge-conflicts'), { recursive: true })
    fs.writeFileSync(path.join(skillsDir, 'pipelinely-merge-conflicts', 'SKILL.md'), skillWithTemplate(template))
  }

  function render(dirs: { skillsDir: string } = { skillsDir }) {
    return writeStageBrief({ stage: 'merge-conflicts', slug: MERGE_SLUG, tasksDir, worktreesDir, ...dirs })
  }

  function readBrief(): string {
    return fs.readFileSync(path.join(taskDir, 'TASK-merge.md'), 'utf-8')
  }

  function commitFile(file: string, content: string, message: string): void {
    fs.mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true })
    fs.writeFileSync(path.join(worktree, file), content)
    git(worktree, ['add', file])
    git(worktree, ['commit', '-q', '-m', message], '2026-10-01T10:00:00Z')
  }

  // A worktree whose HEAD and origin/master edit the same lines of each
  // CONFLICTED_FILES entry, plus one file only master touched (merges clean).
  function makeConflictedWorktree(): void {
    git(worktree, ['init', '-q', '-b', 'base'])
    git(worktree, ['config', 'user.email', 'test@example.com'])
    git(worktree, ['config', 'user.name', 'Test'])
    for (const file of CONFLICTED_FILES) commitFile(file, 'base\n', `base ${file}`)
    git(worktree, ['checkout', '-q', '-b', 'master-side'])
    for (const file of CONFLICTED_FILES) commitFile(file, 'master\n', `master ${file}`)
    commitFile('only-master.ts', 'clean\n', 'master only')
    git(worktree, ['update-ref', 'refs/remotes/origin/master', 'HEAD'])
    git(worktree, ['checkout', '-q', 'base'])
    git(worktree, ['checkout', '-q', '-b', MERGE_BRANCH])
    for (const file of CONFLICTED_FILES) commitFile(file, 'ours\n', `ours ${file}`)
  }

  beforeEach(() => {
    rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-brief-merge-')))
    tasksDir = path.join(rootDir, 'tasks')
    worktreesDir = path.join(rootDir, 'worktrees')
    skillsDir = path.join(rootDir, 'skills')
    taskDir = path.join(tasksDir, MERGE_SLUG)
    worktree = path.join(worktreesDir, MERGE_SLUG)
    fs.mkdirSync(taskDir, { recursive: true })
    fs.mkdirSync(worktree, { recursive: true })
    writeMergeSkill(MERGE_TEMPLATE)
    makeConflictedWorktree()

    writeTaskFile('TASK.md', ['# Conflicted task', '', '## Workspace', '- Repo: cockpit-ai', `- Branch: ${MERGE_BRANCH}`, ''].join('\n'))
    writeTaskFile('INTENT.md', '# Intent: Conflicted task\n')
    writeTaskFile('tech-design.md', '# Plan\n')
    writeTaskFile('VERIFY', 'npx vitest run\n')
    writeTaskFile('STATUS', `${PREVIOUS_STATUS}\n`)
    writeTaskFile('TIMELINE', [
      '2026-10-01T09:00:00Z dev PR #120 opened: an older round',
      `2026-10-01T10:00:00Z dev PR #${MERGE_PR} opened: the change`,
      '2026-10-01T11:00:00Z dev merged origin/master (M2, PR #119) into branch',
      '2026-10-01T12:00:00Z qa 2 failures',
      '',
    ].join('\n'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('writes TASK-merge.md naming the PR from TIMELINE, the conflicting files, and the STATUS to restore', async () => {
    const briefPath = await render()

    expect(briefPath).toBe(path.join(taskDir, 'TASK-merge.md'))
    const brief = readBrief()
    expect(brief).toContain(`- PR: #${MERGE_PR}`)
    expect(brief).toContain(`- Worktree: ${worktree}`)
    expect(brief).toContain(path.join(taskDir, 'INTENT.md'))
    expect(brief).toContain(`- Approved plan: ${path.join(taskDir, 'tech-design.md')}`)
    expect(brief).toContain('- Verifier: `npx vitest run`')
    for (const file of CONFLICTED_FILES) expect(brief).toContain(`- \`${file}\``)
    expect(brief).not.toContain('only-master.ts')
    expect(brief).toContain(`restore \`${PREVIOUS_STATUS}\``)
  })

  it('is deterministic: the same files render the same brief', async () => {
    await render()
    const first = readBrief()
    await render()
    expect(readBrief()).toBe(first)
  })

  it('never writes TASK.md, in the task dir or the worktree, and leaves the worktree untouched', async () => {
    const taskMdBefore = fs.readFileSync(path.join(taskDir, 'TASK.md'), 'utf-8')
    const headBefore = git(worktree, ['rev-parse', 'HEAD'])

    await render()

    expect(fs.readFileSync(path.join(taskDir, 'TASK.md'), 'utf-8')).toBe(taskMdBefore)
    expect(fs.existsSync(path.join(worktree, 'TASK.md'))).toBe(false)
    expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(headBefore)
    expect(git(worktree, ['status', '--porcelain'])).toBe('')
  })

  it('ends with the real Branch line even when a conflicting path looks like a branch', async () => {
    await render()
    const brief = readBrief()

    expect(brief.trimEnd().split('\n').at(-1)).toBe(`- Branch: ${MERGE_BRANCH}`)
    expect(parseTaskMdContent(brief).branch).toBe(MERGE_BRANCH)
  })

  it('says so when the branch already merges cleanly', async () => {
    git(worktree, ['update-ref', 'refs/remotes/origin/master', 'base'])

    await render()

    expect(readBrief()).toMatch(/none — .*merges cleanly/)
  })

  it('merges the base the repo actually has — origin/main on a main-based repo — not a hard-coded origin/master', async () => {
    const masterSide = git(worktree, ['rev-parse', 'origin/master']).trim()
    git(worktree, ['update-ref', '-d', 'refs/remotes/origin/master'])
    git(worktree, ['update-ref', 'refs/remotes/origin/main', masterSide])

    await render()
    const brief = readBrief()

    expect(brief).toContain('base: origin/main')
    expect(brief).not.toContain('origin/master')
    for (const file of CONFLICTED_FILES) expect(brief).toContain(`- \`${file}\``)
  })

  it('renders "unavailable", and logs, when the conflict list cannot be computed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    git(worktree, ['update-ref', '-d', 'refs/remotes/origin/master'])

    await render()

    expect(readBrief()).toMatch(/unavailable \(/)
    expect(errorSpy).toHaveBeenCalled()
  })

  it('refuses, writing nothing, when TIMELINE names no PR this task opened', async () => {
    writeTaskFile('TIMELINE', '2026-10-01T11:00:00Z dev merged origin/master (M2, PR #119) into branch\n')

    await expect(render()).rejects.toThrow(/PR/)
    expect(fs.existsSync(path.join(taskDir, 'TASK-merge.md'))).toBe(false)
  })

  it('records "none recorded" for a missing STATUS rather than inventing one', async () => {
    fs.rmSync(path.join(taskDir, 'STATUS'))

    await render()

    expect(readBrief()).toContain('restore `none recorded`')
  })

  describe('the real pipelinely-merge-conflicts template', () => {
    it('renders with no leftover placeholder, carrying the merge, verify, push and STATUS rules, and ends with the Branch line', async () => {
      await render({ skillsDir: REAL_SKILLS_DIR })
      const brief = readBrief()

      expect(brief).not.toMatch(/\{\{\w+\}\}/)
      expect(brief).toContain('git merge origin/master')
      expect(brief).not.toContain('{{baseRef}}')
      expect(brief).toMatch(/never (a )?rebase/i)
      expect(brief).toMatch(/force-push/i)
      expect(brief).toContain('npx tsc --noEmit')
      expect(brief).toContain('npx vitest run')
      expect(brief).toContain('--project=ui')
      expect(brief).toContain(`gh pr view ${MERGE_PR} --json mergeable`)
      expect(brief).toContain('MERGE_NOTES.md')
      expect(brief).toContain(`echo "working" > ${taskDir}/STATUS`)
      expect(brief).toContain(PREVIOUS_STATUS)
      expect(brief).toContain('merge-conflicts')
      for (const file of CONFLICTED_FILES) expect(brief).toContain(file)
      expect(parseTaskMdContent(brief).branch).toBe(MERGE_BRANCH)
      expect(brief.trimEnd().split('\n').at(-1)).toBe(`- Branch: ${MERGE_BRANCH}`)
    })
  })

  describe('stage-brief CLI', () => {
    function runCli(args: string[]) {
      const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: tasksDir, WORKTREES_DIR: worktreesDir }
      const result = spawnSync(TSX_BIN, [CLI_PATH, ...args], { env, cwd: rootDir, encoding: 'utf-8' })
      return { status: result.status, stdout: result.stdout, stderr: result.stderr }
    }

    it('writes TASK-merge.md from the real skill, the PR read from TIMELINE, and prints its path', () => {
      const result = runCli(['merge-conflicts', MERGE_SLUG])

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.stdout).toContain(path.join(taskDir, 'TASK-merge.md'))
    })

    it('exits 1 with one stderr line, writing nothing, for a task that does not exist', () => {
      const result = runCli(['merge-conflicts', 'no-such-task'])

      expect(result.status).toBe(1)
      expect(result.stderr.trim()).not.toBe('')
    })
  })
})

describe('isBriefStage', () => {
  it.each(['code-review', 'merge-conflicts'])('accepts %s', (stage) => {
    expect(isBriefStage(stage)).toBe(true)
  })

  it.each([['qa'], ['constructor'], ['']])('rejects %j, and undefined', (stage) => {
    expect(isBriefStage(stage)).toBe(false)
    expect(isBriefStage(undefined)).toBe(false)
  })

  it('accepts every stage whose dispatch is gated on an intent brief: adding qa there without a qa brief here must fail', () => {
    for (const stage of INTENT_BRIEF_STAGES) expect(isBriefStage(stage), stage).toBe(true)
  })
})
