import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execa } from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const SCRIPT = path.join(import.meta.dirname, 'write-intent.sh')
const SLUG = 'some-task'
const PARENT_SLUG = 'big-feature'
const CHILD_SLUG = `${PARENT_SLUG}-m1`
const EXIT_IO_FAILURE = 1
const EXIT_BAD_ARGS = 2
const EXIT_ALREADY_EXISTS = 3
const EXIT_NOTHING_TO_AMEND = 4
const READ_ONLY_MODE = 0o444
const PERMISSION_BITS = 0o777

// Verbatim on purpose: shell metacharacters, a markdown heading and a
// branch-prefix-looking token must all survive into INTENT.md untouched —
// the request is the developer's words, never something the shell or the
// writer gets to reinterpret.
const REQUEST = [
  'make the review check the PR against what I asked, not the PR body',
  '## not a real heading — it is part of what I typed',
  'touch $HOME and `backticks` and "quotes" and claude/not-a-branch',
].join('\n')
const MILESTONE_BULLET = '- M1: CR brief — needs: M0 — est: 4h — spec: src/stageBrief.test.ts'

describe('scripts/write-intent.sh', () => {
  let rootDir: string
  let tasksDir: string
  let intentPath: string

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-intent-'))
    tasksDir = path.join(rootDir, 'tasks')
    fs.mkdirSync(path.join(tasksDir, SLUG), { recursive: true })
    fs.mkdirSync(path.join(tasksDir, PARENT_SLUG), { recursive: true })
    fs.writeFileSync(
      path.join(tasksDir, PARENT_SLUG, 'tech-design.md'),
      ['# Big feature', '', '## Milestones', '- M0: Intent file — needs: none — est: 2h', MILESTONE_BULLET, ''].join('\n'),
    )
    intentPath = path.join(tasksDir, SLUG, 'INTENT.md')
  })

  afterEach(() => {
    // INTENT.md is 0444 by design; rmSync with force still removes it since
    // the parent dir stays writable.
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  function createArgs(slug = SLUG, extra: string[] = []): string[] {
    return [
      '--tasks-dir', tasksDir,
      '--slug', slug,
      '--create',
      '--title', 'Some task',
      '--repo', 'cockpit-ai',
      '--created-by', 'orchestrator',
      '--source', 'free-text',
      ...extra,
    ]
  }

  function run(args: string[], input: string) {
    return execa('bash', [SCRIPT, ...args], { input, reject: false })
  }

  function mode(filePath: string): number {
    return fs.statSync(filePath).mode & PERMISSION_BITS
  }

  describe('--create', () => {
    it('writes INTENT.md read-only (0444) with the request verbatim under its own section', async () => {
      const result = await run(createArgs(), REQUEST)

      expect(result.exitCode).toBe(0)
      expect(mode(intentPath)).toBe(READ_ONLY_MODE)
      const content = fs.readFileSync(intentPath, 'utf-8')
      expect(content.split('\n')[0]).toBe('# Intent: Some task')
      expect(content).toContain('- Slug: some-task')
      expect(content).toContain('- Repo: cockpit-ai')
      expect(content).toMatch(/^- Created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z by orchestrator$/m)
      expect(content).toContain('- Source: free-text')
      expect(content).toContain('## Original request (verbatim)')
      for (const line of REQUEST.split('\n')) expect(content).toContain(`> ${line}`)
      expect(content).toContain('## Amendments')
    })

    it('records "None stated by the developer." when no criteria or exclusions were given (D4 default)', async () => {
      await run(createArgs(), REQUEST)

      const content = fs.readFileSync(intentPath, 'utf-8')
      const criteria = content.split('## Acceptance criteria')[1].split('\n## ')[0]
      const exclusions = content.split('## Out of scope / must not')[1].split('\n## ')[0]
      expect(criteria.trim()).toBe('- None stated by the developer.')
      expect(exclusions.trim()).toBe('- None stated by the developer.')
    })

    it('writes each stated criterion and exclusion as its own bullet, as given', async () => {
      await run(
        createArgs(SLUG, [
          '--criterion', 'the brief names INTENT.md',
          '--criterion', 'CR never writes TASK.md',
          '--out-of-scope', 'no dashboard changes',
        ]),
        REQUEST,
      )

      const content = fs.readFileSync(intentPath, 'utf-8')
      expect(content).toContain('- the brief names INTENT.md\n- CR never writes TASK.md')
      expect(content).toContain('- no dashboard changes')
      expect(content).not.toContain('None stated by the developer.')
    })

    it('creates the task dir when it does not exist yet (INTENT.md is written before the tab opens)', async () => {
      const result = await run(createArgs('brand-new-task'), REQUEST)

      expect(result.exitCode).toBe(0)
      // Written to a temp file and linked into place, so no temp file is left behind.
      expect(fs.readdirSync(path.join(tasksDir, 'brand-new-task'))).toEqual(['INTENT.md'])
    })

    it('two racing --create calls: exactly one wins (exit 0), the other exits 3, and the file is one complete request', async () => {
      const [first, second] = await Promise.all([run(createArgs(), 'request one'), run(createArgs(), 'request two')])

      expect([first.exitCode, second.exitCode].sort()).toEqual([0, EXIT_ALREADY_EXISTS])
      const content = fs.readFileSync(intentPath, 'utf-8')
      expect(content.includes('> request one') !== content.includes('> request two')).toBe(true)
      expect(fs.readdirSync(path.join(tasksDir, SLUG))).toEqual(['INTENT.md'])
      expect(mode(intentPath)).toBe(READ_ONLY_MODE)
    })

    it('a milestone child gets a parent pointer and a verbatim snapshot of its M<N> bullet', async () => {
      const result = await run(
        ['--tasks-dir', tasksDir, '--slug', CHILD_SLUG, '--create', '--title', 'CR brief',
          '--repo', 'cockpit-ai', '--created-by', 'pipelinely-dev', '--source', 'milestone'],
        '',
      )

      expect(result.exitCode).toBe(0)
      const content = fs.readFileSync(path.join(tasksDir, CHILD_SLUG, 'INTENT.md'), 'utf-8')
      expect(content).toContain(`- Source: milestone M1 of ${PARENT_SLUG}`)
      expect(content).toContain(`- Parent intent: ${path.join(tasksDir, PARENT_SLUG, 'INTENT.md')}`)
      const scope = content.split('## Milestone scope')[1].split('\n## ')[0]
      expect(scope.trim()).toBe(MILESTONE_BULLET)
    })

    it('refuses a second --create with exit 3 and leaves the original bytes unchanged', async () => {
      await run(createArgs(), REQUEST)
      const before = fs.readFileSync(intentPath)

      const result = await run(createArgs(), 'a different request')

      expect(result.exitCode).toBe(EXIT_ALREADY_EXISTS)
      expect(result.stderr).toContain('INTENT.md')
      expect(fs.readFileSync(intentPath).equals(before)).toBe(true)
      expect(mode(intentPath)).toBe(READ_ONLY_MODE)
    })

    it('a plain shell redirect onto a created INTENT.md fails (EACCES) — the guarantee the 0444 mode buys', async () => {
      await run(createArgs(), REQUEST)

      const result = await execa('bash', ['-c', `echo overwritten > '${intentPath}'`], { reject: false })

      expect(result.exitCode).not.toBe(0)
      expect(fs.readFileSync(intentPath, 'utf-8')).toContain(`> ${REQUEST.split('\n')[0]}`)
    })

    it('refuses an empty request for a non-milestone task with exit 2 and writes nothing', async () => {
      const result = await run(createArgs(), '')

      expect(result.exitCode).toBe(EXIT_BAD_ARGS)
      expect(fs.existsSync(intentPath)).toBe(false)
    })

    it('refuses a milestone child whose M<N> bullet is missing from the parent tech-design.md with exit 2', async () => {
      const result = await run(
        ['--tasks-dir', tasksDir, '--slug', `${PARENT_SLUG}-m7`, '--create', '--title', 'Ghost',
          '--repo', 'cockpit-ai', '--created-by', 'pipelinely-dev', '--source', 'milestone'],
        '',
      )

      expect(result.exitCode).toBe(EXIT_BAD_ARGS)
      expect(result.stderr).toContain('M7')
      expect(fs.existsSync(path.join(tasksDir, `${PARENT_SLUG}-m7`, 'INTENT.md'))).toBe(false)
    })

    it('exits 1 with a logged error when the task dir cannot be written', async () => {
      fs.chmodSync(path.join(tasksDir, SLUG), 0o555)
      try {
        const result = await run(createArgs(), REQUEST)

        expect(result.exitCode).toBe(EXIT_IO_FAILURE)
        expect(result.stderr).not.toBe('')
        expect(fs.existsSync(intentPath)).toBe(false)
      } finally {
        fs.chmodSync(path.join(tasksDir, SLUG), 0o755)
      }
    })
  })

  describe('--amend', () => {
    it('appends a dated, sourced entry; the prior bytes stay an exact prefix; the mode returns to 0444', async () => {
      await run(createArgs(), REQUEST)
      const before = fs.readFileSync(intentPath)

      const result = await run(
        ['--tasks-dir', tasksDir, '--slug', SLUG, '--amend', '--source', 'NEW REQUEST'],
        'also cover milestone children',
      )

      expect(result.exitCode).toBe(0)
      const after = fs.readFileSync(intentPath)
      expect(after.subarray(0, before.length).equals(before)).toBe(true)
      const appended = after.subarray(before.length).toString('utf-8')
      expect(appended).toMatch(/^\n?### \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z — NEW REQUEST$/m)
      expect(appended).toContain('> also cover milestone children')
      expect(mode(intentPath)).toBe(READ_ONLY_MODE)
    })

    it('refuses with exit 4 when there is no INTENT.md to amend, and creates none', async () => {
      const result = await run(
        ['--tasks-dir', tasksDir, '--slug', SLUG, '--amend', '--source', 'NEW REQUEST'],
        'something',
      )

      expect(result.exitCode).toBe(EXIT_NOTHING_TO_AMEND)
      expect(fs.existsSync(intentPath)).toBe(false)
    })

    it('refuses an empty amendment with exit 2 and leaves the file byte-identical and 0444', async () => {
      await run(createArgs(), REQUEST)
      const before = fs.readFileSync(intentPath)

      const result = await run(['--tasks-dir', tasksDir, '--slug', SLUG, '--amend', '--source', 'NEW REQUEST'], '')

      expect(result.exitCode).toBe(EXIT_BAD_ARGS)
      expect(fs.readFileSync(intentPath).equals(before)).toBe(true)
      expect(mode(intentPath)).toBe(READ_ONLY_MODE)
    })
  })

  describe('bad arguments (exit 2, nothing touched)', () => {
    it.each([
      ['no mode flag', ['--tasks-dir', '<tasks>', '--slug', SLUG]],
      ['both --create and --amend', ['--tasks-dir', '<tasks>', '--slug', SLUG, '--create', '--amend', '--source', 'x']],
      ['a relative --tasks-dir', ['--tasks-dir', 'tasks', '--slug', SLUG, '--amend', '--source', 'x']],
      ['an unsafe slug', ['--tasks-dir', '<tasks>', '--slug', '../escape', '--amend', '--source', 'x']],
      ['an unknown --created-by', ['--tasks-dir', '<tasks>', '--slug', SLUG, '--create', '--title', 't', '--repo', 'r', '--created-by', 'dev-worker', '--source', 'free-text']],
      ['--amend without --source', ['--tasks-dir', '<tasks>', '--slug', SLUG, '--amend']],
      ['an unknown flag', ['--tasks-dir', '<tasks>', '--slug', SLUG, '--create', '--force']],
    ])('%s', async (_label, rawArgs) => {
      const args = rawArgs.map((arg) => (arg === '<tasks>' ? tasksDir : arg))

      const result = await run(args, REQUEST)

      expect(result.exitCode).toBe(EXIT_BAD_ARGS)
      expect(result.stderr).not.toBe('')
      expect(fs.readdirSync(path.join(tasksDir, SLUG))).toEqual([])
      expect(fs.existsSync(path.join(rootDir, 'escape'))).toBe(false)
    })
  })
})
