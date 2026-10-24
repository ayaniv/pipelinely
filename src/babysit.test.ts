import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runBabysit, type BabysitDeps, type BabysitResult } from './babysit.js'
import { babysitDeps } from './babysitDeps.js'
import { loadTasks } from './loadTasks.js'
import { createPrMergeStateCache, createPrNumberCache } from './prLookup.js'
import { DEFAULT_SETTINGS } from './taskParser.js'
import { INTENT_BRIEF_STAGES, LOAD_AVERAGE_CEILING, type SweepTask } from './nextAction.js'
import { QA_SKIPPED_STATUS_REASON } from './nextStageCta.js'
import type { Settings } from './types.js'

// pipelinely-babysit-skill-plan M1 — the /pipelinely-babysit CLI. It PRINTS the
// actions one sweep would take; the skill executes them. Every rule is the
// shared decision in nextAction.ts, so these tests pin the CLI's wiring of it
// (settings, load, ordering, scoping, the TIMELINE/STATUS writes) rather than
// re-deriving the decision table, which nextAction.test.ts already owns.

const UI_VERIFY = 'npx tsc --noEmit && npx vitest run && npx playwright test --project=ui --grep-invert @pending'
const UNIT_VERIFY = 'npx tsc --noEmit && npx vitest run'
const QA_MARKER = 'CR approved, ready for QA'
const QA_BRIEF_STAGES = [...INTENT_BRIEF_STAGES, 'qa'] as const

function sweepTask(slug: string, waitingReason: string, extra: Partial<SweepTask> = {}): SweepTask {
  return { slug, status: 'waiting', waitingReason, repo: 'cockpit-ai', verifier: UNIT_VERIFY, stageHistory: [], ...extra }
}

const planReady = (slug = 'plan-task') => sweepTask(slug, 'plan ready for review')
const devReady = (slug = 'dev-task') => sweepTask(slug, 'plan reviewed, ready for dev')
const prOpen = (slug = 'cr-task') => sweepTask(slug, 'PR open, ready for CR')
const qaReady = (slug = 'qa-task', extra: Partial<SweepTask> = {}) => sweepTask(slug, QA_MARKER, { verifier: UI_VERIFY, ...extra })

describe('babysit CLI', () => {
  let tasksDir: string
  let tasks: SweepTask[]
  let settings: Settings
  let load1: number
  let liveTmux: string[]
  let deps: BabysitDeps

  beforeEach(async () => {
    tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-babysit-test-'))
    tasks = []
    settings = { ...DEFAULT_SETTINGS }
    load1 = 1
    liveTmux = []
    deps = {
      tasksDir,
      readSettings: async () => settings,
      loadTasks: async () => tasks,
      loadavg: () => load1,
      listTmuxSessions: async () => liveTmux,
    }
  })

  afterEach(async () => {
    await fs.rm(tasksDir, { recursive: true, force: true })
  })

  const run = (...argv: string[]): Promise<BabysitResult> => runBabysit(argv, deps)
  const printedAction = (result: BabysitResult) => JSON.parse(result.stdout.at(-1)!)

  async function makeTaskDir(slug: string, files: Record<string, string> = {}): Promise<string> {
    const dir = path.join(tasksDir, slug)
    await fs.mkdir(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content)
    return dir
  }

  describe('next', () => {
    it('prints exactly one JSON line on stdout', async () => {
      tasks = [prOpen()]
      const result = await run('next')
      expect(result.stdout).toHaveLength(1)
      expect(() => JSON.parse(result.stdout[0])).not.toThrow()
    })

    it('the real entry point prints the tasks dir as the very first stderr line, before anything can log', () => {
      const fixture = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pipelinely-babysit-cli-'))
      try {
        fsSync.mkdirSync(path.join(fixture, 't'))
        fsSync.writeFileSync(path.join(fixture, 't', 'STATUS'), 'waiting: CR approved, ready for QA\n')
        fsSync.writeFileSync(path.join(fixture, 't', 'TASK.md'), '- Repo: cockpit-ai\n- Branch: claude/t\n')
        fsSync.writeFileSync(path.join(fixture, 't', 'TIMELINE'), '2026-10-09T10:00:00Z code-review approved\n')
        const child = spawnSync('npx', ['tsx', 'src/babysitCli.ts', 'report'], {
          cwd: path.join(import.meta.dirname, '..'),
          env: { ...process.env, TASKS_DIR: fixture, REPOS_DIR: path.join(fixture, 'repos') },
          encoding: 'utf-8',
        })
        expect(child.stderr.split('\n')[0]).toBe(`tasks dir: ${fixture}`)
      } finally {
        fsSync.rmSync(fixture, { recursive: true, force: true })
      }
    }, 60_000)

    it.each([
      ['plan ready for review', planReady('t'), 'plan-review', '/pipelinely-plan-review t'],
      ['plan reviewed, ready for dev', devReady('t'), 'dev', '/pipelinely-dev t'],
      ['PR open, ready for CR', prOpen('t'), 'code-review', '/pipelinely-cr t'],
    ])('%s prints a dispatch of the existing skill', async (_state, task, stage, command) => {
      tasks = [task]
      const result = await run('next')
      expect(result.exitCode).toBe(0)
      expect(printedAction(result)).toEqual({ slug: 't', kind: 'dispatch', stage, command })
    })

    it('prints a QA skip with no command, since nothing is dispatched', async () => {
      tasks = [qaReady('docs-only', { qaSkipReason: 'docs only' })]
      const result = await run('next')
      expect(result.exitCode).toBe(0)
      expect(printedAction(result)).toEqual({ slug: 'docs-only', kind: 'skip-qa', stage: 'qa', command: null, reason: 'docs only' })
    })

    it('hands out the furthest-along action first, one at a time', async () => {
      tasks = [planReady('a-plan'), devReady('b-dev'), prOpen('c-cr')]
      const result = await run('next')
      expect(result.stdout).toHaveLength(1)
      expect(printedAction(result).slug).toBe('c-cr')
    })

    it('exits 3 when nothing is left to do', async () => {
      tasks = [{ ...prOpen(), status: 'working' }]
      const result = await run('next')
      expect(result.exitCode).toBe(3)
      expect(result.stdout).toEqual([])
    })

    it('leaves out the slugs handled this sweep (--done), failed ones included', async () => {
      tasks = [prOpen('first'), prOpen('second')]
      expect(printedAction(await run('next', '--done', 'first')).slug).toBe('second')
      expect((await run('next', '--done', 'first,second')).exitCode).toBe(3)
    })

    describe('load', () => {
      it('holds the sweep above the ceiling and says so, exit 4', async () => {
        tasks = [prOpen()]
        load1 = 12
        const result = await run('next')
        expect(result.exitCode).toBe(4)
        expect(result.stdout).toEqual(['held: load 12.0'])
      })

      it('holds at once when the load average cannot be read', async () => {
        tasks = [prOpen()]
        load1 = Number.NaN
        expect((await run('next')).exitCode).toBe(4)
      })

      it('holds just above the ceiling and runs at it', async () => {
        tasks = [prOpen()]
        load1 = LOAD_AVERAGE_CEILING + 0.1
        expect((await run('next')).exitCode).toBe(4)
        load1 = LOAD_AVERAGE_CEILING
        expect((await run('next')).exitCode).toBe(0)
      })

      it('is exit 3, not 4, when load is high but nothing would have been sent', async () => {
        tasks = [{ ...prOpen(), status: 'working' }]
        load1 = 50
        expect((await run('next')).exitCode).toBe(3)
      })

      it('re-reads the load on every call, so a rising load stops the sweep mid-way', async () => {
        tasks = [prOpen('first'), prOpen('second')]
        expect((await run('next')).exitCode).toBe(0)
        load1 = 11
        expect((await run('next', '--done', 'first')).exitCode).toBe(4)
      })
    })

    describe('hard stops', () => {
      it('never prints a merge: a ready-to-merge task is not an action', async () => {
        tasks = [sweepTask('ready', 'QA passed, ready to merge'), sweepTask('skipped', 'no QA needed, ready to merge')]
        expect((await run('next')).exitCode).toBe(3)
      })

      it('treats a conflicting PR as needs-you, never as an action', async () => {
        tasks = [prOpen('conflicted')].map((task) => ({ ...task, prMergeState: 'conflicting' as const }))
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toContain('conflicted')
      })

      it('sends a milestone parent to needs-you start-milestones, never /pipelinely-dev <parent>', async () => {
        tasks = [{ ...devReady('parent'), stageHistory: [{ stage: 'plan-review', at: '2026-10-09T09:00:00Z', note: 'round 1' }], milestones: [{ id: 'M0', needs: [], state: 'queued' }] }]
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/parent.*start-milestones/)
      })

      it('skips a task whose newest TIMELINE line is a successful dispatch for the same stage', async () => {
        const inFlight = { stage: 'code-review' as const, at: '2026-10-09T10:00:00Z', note: 'auto-dispatched — babysit' }
        tasks = [prOpen('in-flight')].map((task) => ({ ...task, stageHistory: [inFlight] }))
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/in-flight.*dispatch-in-flight/)
      })

      it('retries a task whose newest dispatch note is a failure', async () => {
        const failed = { stage: 'code-review' as const, at: '2026-10-09T10:00:00Z', note: 'auto-dispatch failed — no session' }
        tasks = [prOpen('retry')].map((task) => ({ ...task, stageHistory: [failed] }))
        expect((await run('next')).exitCode).toBe(0)
      })
    })

    describe('QA consent comes only from the recorded qaStartPolicy', () => {
      it.each([
        ['the default', { ...DEFAULT_SETTINGS }],
        ['ask-every-time', { ...DEFAULT_SETTINGS, qaStartPolicy: 'ask-every-time' as const }],
      ])('never prints a ui-only QA hand-off under %s, even with a brief and an auto-mode task', async (_label, value) => {
        settings = value
        deps.intentBriefStages = QA_BRIEF_STAGES
        tasks = [qaReady('qa', { autoMode: true })]
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/qa.*qa-consent/)
      })

      it('prints no QA dispatch when pre-approved but pipelinely-qa has no brief yet (master today)', async () => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        tasks = [qaReady('qa')]
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/qa.*qa-intent-brief/)
      })

      it('prints the QA dispatch when pre-approved and a QA brief exists', async () => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
        tasks = [qaReady('qa')]
        expect(printedAction(await run('next'))).toEqual({ slug: 'qa', kind: 'dispatch', stage: 'qa', command: '/pipelinely-qa qa' })
      })

      it('does not cover a QA run that touches integration, even when pre-approved', async () => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
        tasks = [qaReady('qa', { verifier: 'npx playwright test --project=ui --project=integration' })]
        expect((await run('next')).exitCode).toBe(3)
      })

      it('reads the setting from SETTINGS.json through readSettings: absent and malformed files mean ask', async () => {
        const realDeps = { ...deps, readSettings: (await import('./taskParser.js')).readSettings }
        realDeps.intentBriefStages = QA_BRIEF_STAGES
        tasks = [qaReady('qa')]
        expect((await runBabysit(['next'], realDeps)).exitCode).toBe(3)

        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await fs.writeFile(path.join(tasksDir, 'SETTINGS.json'), '{ not json')
        expect((await runBabysit(['next'], realDeps)).exitCode).toBe(3)
        expect(errorSpy).toHaveBeenCalled()
        errorSpy.mockRestore()

        await fs.writeFile(path.join(tasksDir, 'SETTINGS.json'), JSON.stringify({ qaStartPolicy: 'cockpit-ai-ui-preapproved' }))
        expect((await runBabysit(['next'], realDeps)).exitCode).toBe(0)
      })
    })

    describe('one QA at a time', () => {
      beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
      })

      it('sends none while another task is running its QA', async () => {
        tasks = [qaReady('waiting-qa'), { ...qaReady('running-qa'), status: 'working', stage: 'qa' }]
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/waiting-qa.*qa-in-flight/)
      })

      it('sends at most one per sweep: the second waits until the next sweep', async () => {
        tasks = [qaReady('qa-a'), qaReady('qa-b')]
        expect(printedAction(await run('next')).slug).toBe('qa-a')
        expect((await run('next', '--done', 'qa-a')).exitCode).toBe(3)
        expect((await run('report', '--done', 'qa-a')).stdout.join('\n')).toMatch(/qa-b.*one-qa-per-sweep/)
      })
    })

    describe('one QA per sweep, after a real dispatch', () => {
      it('holds the second QA once the first was dispatched and noted, even when its task reads working on qa-fixes', async () => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
        const dispatchedQa = { stage: 'qa' as const, at: '2026-10-09T10:00:00Z', note: 'auto-dispatched — babysit' }
        tasks = [{ ...qaReady('first'), status: 'working', stage: 'qa-fixes', stageHistory: [dispatchedQa] }, qaReady('second')]
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/second.*qa-in-flight/)
      })
    })

    describe('one QA at a time, when the dispatch note was never written', () => {
      beforeEach(() => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
        // t-qa is the task whose QA tab is open and still working.
        tasks = [qaReady('t-qa2'), { ...qaReady('t-qa'), status: 'working', stage: 'qa-fixes' }]
      })

      it('holds QA while a worker-<slug>-qa tmux session is live', async () => {
        liveTmux = ['worker-t-qa-qa']
        expect((await run('next')).exitCode).toBe(3)
        expect((await run('report')).stdout.join('\n')).toMatch(/t-qa2.*qa-in-flight/)
      })

      it('also recognises a numbered re-run session', async () => {
        liveTmux = ['worker-t-qa-qa2']
        expect((await run('next')).exitCode).toBe(3)
      })

      it('holds QA, and logs, when tmux cannot be listed', async () => {
        deps.listTmuxSessions = async () => {
          throw new Error('tmux down')
        }
        const result = await run('next')
        expect(result.exitCode).toBe(3)
        expect(result.stderr.join('\n')).toContain('tmux down')
      })

      it('does not count a QA tab left open by a task that is no longer working', async () => {
        tasks = [qaReady('t-qa')]
        liveTmux = ['worker-t-qa-qa']
        expect(printedAction(await run('next')).slug).toBe('t-qa')
      })

      it('does not count a QA tab whose task is not on the board', async () => {
        liveTmux = ['worker-long-gone-qa']
        expect(printedAction(await run('next')).slug).toBe('t-qa2')
      })

      it('still dispatches non-QA work when a QA session is live', async () => {
        liveTmux = ['worker-other-qa']
        tasks = [prOpen('cr')]
        expect(printedAction(await run('next')).slug).toBe('cr')
      })
    })

    describe('unsafe task names', () => {
      it.each([['ev$(touch PWNED)'], ['ev`x`'], ["ev'q;x"], ['ev a b'], ['ev\nnl'], ['-rf'], ['ev,comma'], ['ev\u202e']])(
        'never hands out or lists %j, and says so on stderr without echoing it raw',
        async (name) => {
          tasks = [prOpen(name), prOpen('fine')]
          const next = await run('next')
          expect(printedAction(next).slug).toBe('fine')
          expect((await run('next', '--done', 'fine')).exitCode).toBe(3)
          const report = await run('report')
          expect(report.stdout.join('\n')).not.toContain(name)
          expect(report.stdout.join('\n')).toMatch(/ignored:\*\* 1 task dir/)
          // Invisible characters are escaped too: JSON.stringify leaves a bidi override raw.
          expect(report.stderr.join('\n')).toContain(JSON.stringify(name).replace(/\u202e/g, '\\u202e'))
          expect(report.stderr.join('\n')).not.toContain('\u202e')
        },
      )
    })

    describe('scoping', () => {
      it('--except leaves the named tasks out entirely', async () => {
        tasks = [prOpen('keep'), prOpen('skip-me'), planReady('skip-too')]
        expect(printedAction(await run('next', '--except', 'skip-me', 'skip-too')).slug).toBe('keep')
        expect((await run('next', '--except', 'keep,skip-me', '--except', 'skip-too')).exitCode).toBe(3)
      })

      it('--except hides an excluded task from the report too', async () => {
        tasks = [sweepTask('ignored', 'QA passed, ready to merge'), sweepTask('shown', 'QA passed, ready to merge')]
        const text = (await run('report', '--except', 'ignored')).stdout.join('\n')
        expect(text).toContain('shown')
        expect(text).not.toContain('ignored')
      })

      it('--except still counts an excluded running QA, so excluding it does not free the slot', async () => {
        settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
        deps.intentBriefStages = QA_BRIEF_STAGES
        tasks = [qaReady('waiting-qa'), { ...qaReady('running-qa'), status: 'working', stage: 'qa' }]
        expect((await run('next', '--except', 'running-qa')).exitCode).toBe(3)
      })

      it('--only considers just that task (the skill\'s <slug> argument)', async () => {
        tasks = [prOpen('other'), planReady('mine')]
        expect(printedAction(await run('next', '--only', 'mine')).slug).toBe('mine')
      })

      it.each([['--except', 'T-CR'], ['--except', 'keep-'], ['--only', 'nobody']])(
        'refuses %s %s, a slug that names no task, instead of silently sweeping everything',
        async (flag, slug) => {
          tasks = [prOpen('keep'), planReady('mine')]
          for (const command of ['next', 'report']) {
            const result = await run(command, flag, slug)
            expect(result.exitCode).toBe(1)
            expect(result.stdout).toEqual([])
            expect(result.stderr.join('\n')).toContain(JSON.stringify(slug))
          }
        },
      )

      it('refuses a differently-cased --except of a real task', async () => {
        tasks = [prOpen('t-cr')]
        expect((await run('next', '--except', 'T-CR')).exitCode).toBe(1)
      })
    })

    describe('failures', () => {
      it('exit 1 and a logged line when the tasks cannot be loaded', async () => {
        deps.loadTasks = async () => {
          throw new Error('disk gone')
        }
        const result = await run('next')
        expect(result.exitCode).toBe(1)
        expect(result.stderr.join('\n')).toContain('disk gone')
      })

      it('exit 1 and a logged line when the settings cannot be read, never a silent default dispatch', async () => {
        deps.readSettings = async () => {
          throw new Error('EACCES')
        }
        tasks = [prOpen()]
        const result = await run('next')
        expect(result.exitCode).toBe(1)
        expect(result.stderr.join('\n')).toContain('EACCES')
        expect(result.stdout).toEqual([])
      })
    })
  })

  describe('skip-qa', () => {
    it('writes the recognised ready-to-merge STATUS and a qa TIMELINE line, through recordQaSkipped', async () => {
      await makeTaskDir('docs-only', { STATUS: `waiting: ${QA_MARKER}\n` })
      tasks = [qaReady('docs-only', { qaSkipReason: 'docs only' })]
      const result = await run('skip-qa', 'docs-only')
      expect(result.exitCode).toBe(0)
      expect(await fs.readFile(path.join(tasksDir, 'docs-only', 'STATUS'), 'utf-8')).toBe(`waiting: ${QA_SKIPPED_STATUS_REASON}\n`)
      expect(await fs.readFile(path.join(tasksDir, 'docs-only', 'TIMELINE'), 'utf-8')).toMatch(/ qa skipped — docs only\n$/)
    })

    it('refuses, writing nothing, when the decision for that task is not a skip (exit 2)', async () => {
      await makeTaskDir('needs-qa', { STATUS: `waiting: ${QA_MARKER}\n` })
      tasks = [qaReady('needs-qa')]
      const result = await run('skip-qa', 'needs-qa')
      expect(result.exitCode).toBe(2)
      expect(await fs.readFile(path.join(tasksDir, 'needs-qa', 'STATUS'), 'utf-8')).toBe(`waiting: ${QA_MARKER}\n`)
      await expect(fs.access(path.join(tasksDir, 'needs-qa', 'TIMELINE'))).rejects.toThrow()
    })

    it('exit 1 for a slug that is not a task, and without a slug', async () => {
      tasks = []
      expect((await run('skip-qa', 'ghost')).exitCode).toBe(1)
      expect((await run('skip-qa')).exitCode).toBe(1)
    })

    it('exit 1 and a logged line when the write fails', async () => {
      tasks = [qaReady('no-dir', { qaSkipReason: 'docs only' })]
      const result = await run('skip-qa', 'no-dir')
      expect(result.exitCode).toBe(1)
      expect(result.stderr.join('\n')).toContain('no-dir')
    })
  })

  describe('note', () => {
    beforeEach(async () => {
      await makeTaskDir('t')
    })
    const timeline = () => fs.readFile(path.join(tasksDir, 't', 'TIMELINE'), 'utf-8')

    it('appends the shared unattended-dispatch note, with no PR number in it', async () => {
      const result = await run('note', 't', 'code-review')
      expect(result.exitCode).toBe(0)
      expect(await timeline()).toMatch(/^\S+ code-review auto-dispatched — babysit\n$/)
      expect(await timeline()).not.toMatch(/#\d/)
    })

    it('records a failed dispatch as auto-dispatch failed, so the next sweep retries it', async () => {
      await run('note', 't', 'qa', '--failed', 'orchestrator', 'locked')
      expect(await timeline()).toMatch(/ qa auto-dispatch failed — babysit: orchestrator locked\n$/)
    })

    it('strips a PR reference from a failure reason: the dashboard takes the first #N of a note as the PR', async () => {
      await run('note', 't', 'dev', '--failed', 'collision with #123 and #45')
      expect(await timeline()).not.toMatch(/#\d/)
      expect(await timeline()).toContain('123')
    })

    it('keeps a multi-line reason on one TIMELINE line', async () => {
      await run('note', 't', 'dev', '--failed', 'line one\nline two')
      expect((await timeline()).trimEnd().split('\n')).toHaveLength(1)
    })

    it('strips invisible bidi and control characters from a failure reason', async () => {
      await run('note', 't', 'dev', '--failed', 'evil\u202eRTL\u0007bell')
      expect(await timeline()).toContain('evilRTLbell')
      expect(await timeline()).not.toMatch(/[\u202e\u0007]/)
    })

    it('takes a reason that starts with dashes as text, not as a flag', async () => {
      await run('note', 't', 'dev', '--failed', '--force push')
      expect(await timeline()).toMatch(/ dev auto-dispatch failed — babysit: --force push\n$/)
    })

    it.each([['merge'], ['comment-fix'], ['nonsense'], ['']])('refuses stage %j: only dispatchable stages get a note (exit 1)', async (stage) => {
      const result = await run('note', 't', stage)
      expect(result.exitCode).toBe(1)
      await expect(fs.access(path.join(tasksDir, 't', 'TIMELINE'))).rejects.toThrow()
    })

    it('exit 1 for an unknown task, and does not create its directory', async () => {
      const result = await run('note', 'ghost', 'dev')
      expect(result.exitCode).toBe(1)
      await expect(fs.access(path.join(tasksDir, 'ghost'))).rejects.toThrow()
    })

    it('rejects a slug that escapes the tasks dir', async () => {
      expect((await run('note', '../elsewhere', 'dev')).exitCode).toBe(1)
    })
  })

  describe('report', () => {
    it('lists needs-you with merges first, oldest PR first, then the rest in board order', async () => {
      tasks = [
        sweepTask('question', 'which database?'),
        sweepTask('merge-new', 'QA passed, ready to merge', { prNumber: '30' }),
        sweepTask('merge-old', 'QA passed, ready to merge', { prNumber: '12' }),
      ]
      const text = (await run('report')).stdout.join('\n')
      expect(text.indexOf('merge-old')).toBeLessThan(text.indexOf('merge-new'))
      expect(text.indexOf('merge-new')).toBeLessThan(text.indexOf('question'))
    })

    it('names the qaStartPolicy it read and the load', async () => {
      settings = { ...DEFAULT_SETTINGS, qaStartPolicy: 'cockpit-ai-ui-preapproved' }
      const text = (await run('report')).stdout.join('\n')
      expect(text).toContain('cockpit-ai-ui-preapproved')
    })

    it('lists what moved (--done) and what failed (--failed slug=reason), failures never as moved', async () => {
      tasks = [prOpen('moved'), prOpen('broke')]
      const text = (await run('report', '--done', 'moved,broke', '--failed', 'broke=orchestrator locked')).stdout.join('\n')
      expect(text).toMatch(/moved:.*\bmoved\b/s)
      expect(text).toMatch(/failed:[\s\S]*broke[\s\S]*orchestrator locked/)
      const movedSection = text.split(/failed:/i)[0]
      expect(movedSection).not.toContain('broke')
    })

    it('says plainly when the sweep was held by load', async () => {
      tasks = [prOpen('held-task')]
      load1 = 12
      expect((await run('report')).stdout.join('\n')).toMatch(/held-task.*load/)
    })

    it('prints a failure reason as one clean line: no forged lines, no #N', async () => {
      tasks = [planReady('t-plan')]
      const text = (await run('report', '--failed', 't-plan=x $(touch PWNED) #12\nINJECT **needs you:**')).stdout.join('\n')
      expect(text.split('\n').filter((line) => line.startsWith('INJECT'))).toEqual([])
      expect(text).not.toMatch(/#\d/)
      expect(text).toContain('INJECT')
    })

    it('lists a task whose dispatched skill asked the developer something under needs-you, never as moved', async () => {
      tasks = [devReady('asked-task'), prOpen('moved-task')]
      const text = (await run('report', '--done', 'asked-task,moved-task', '--asked', 'asked-task=run it anyway or backlog it?')).stdout.join('\n')
      const needsYou = text.split('**needs you:**')[1].split('**deferred:**')[0]
      expect(needsYou).toMatch(/^- asked-task — asked \(run it anyway or backlog it\?\)$/m)
      expect(text).toMatch(/moved:\*\* moved-task$/m)
      expect(text).not.toMatch(/asked-task — not run this sweep/)
    })

    it('prints an asked question as one clean line: no forged lines, no #N', async () => {
      tasks = [devReady('asked-task')]
      const text = (await run('report', '--asked', 'asked-task=which repo? #12\nINJECT **moved:** x')).stdout.join('\n')
      expect(text.split('\n').filter((line) => line.startsWith('INJECT'))).toEqual([])
      expect(text).not.toMatch(/#\d/)
    })

    it('exits 0 even with nothing to report', async () => {
      expect((await run('report')).exitCode).toBe(0)
    })
  })

  describe('slug lists are validated loudly', () => {
    it.each([
      ['next', '--done', 'ok,bad\nname'],
      ['next', '--done', 'ev$(touch X)'],
      ['next', '--except', 'ev`x`'],
      ['next', '--except', 'a b'],
      ['next', '--only', '-rf'],
      ['next', '--only', '..'],
      ['report', '--done', 'ok,ev name'],
      ['report', '--failed', 'bad\nforged=oops'],
      ['report', '--asked', 'ev$(x)=why?'],
    ])('%s %s %j exits 1, naming the flag and the escaped slug, and prints nothing on stdout', async (command, flag, value) => {
      tasks = [prOpen('ok')]
      const result = await run(command, flag, value)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toEqual([])
      expect(result.stderr.join('\n')).toMatch(new RegExp(`${flag}: .* is not a task slug`))
      // Escaped, never echoed raw: no stderr line carries a raw newline.
      expect(result.stderr.filter((line) => line.includes('\n'))).toEqual([])
    })

    it('still takes an empty --done (the first call of a sweep) and empty comma segments', async () => {
      tasks = [prOpen('ok')]
      expect((await run('next', '--done')).exitCode).toBe(0)
      expect((await run('next', '--done', ',ok,')).exitCode).toBe(3)
    })
  })

  describe('tmux-name', () => {
    it('returns the base when it is free', async () => {
      expect((await run('tmux-name', 'worker-x-cr')).stdout).toEqual(['worker-x-cr'])
    })

    it('returns the next free number when the base is live, never killing the old one', async () => {
      liveTmux = ['worker-x-cr', 'worker-x-cr2']
      expect((await run('tmux-name', 'worker-x-cr')).stdout).toEqual(['worker-x-cr3'])
    })

    it('exit 1 and a logged line when tmux cannot be listed, rather than guessing a name', async () => {
      deps.listTmuxSessions = async () => {
        throw new Error('tmux exploded')
      }
      const result = await run('tmux-name', 'worker-x-cr')
      expect(result.exitCode).toBe(1)
      expect(result.stderr.join('\n')).toContain('tmux exploded')
      expect(result.stdout).toEqual([])
    })

    it('exit 1 without a base', async () => {
      expect((await run('tmux-name')).exitCode).toBe(1)
    })
  })

  describe('usage', () => {
    it.each([[[]], [['nonsense']], [['merge', 'x']]])('%j is exit 1 with a usage line', async (argv) => {
      const result = await runBabysit(argv, deps)
      expect(result.exitCode).toBe(1)
      expect(result.stderr.join('\n')).toMatch(/usage/i)
    })
  })
})

describe('loadTasks', () => {
  let tasksDir: string

  beforeEach(async () => {
    tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-babysit-load-'))
    await fs.mkdir(path.join(tasksDir, 'a-task'), { recursive: true })
    await fs.writeFile(path.join(tasksDir, 'a-task', 'STATUS'), 'waiting: CR approved, ready for QA\n')
    await fs.writeFile(path.join(tasksDir, 'a-task', 'TASK.md'), '## Workspace\n- Repo: cockpit-ai\n- Branch: claude/a-task\n')
    await fs.writeFile(path.join(tasksDir, 'a-task', 'TIMELINE'), '2026-10-09T10:00:00Z code-review approved\n')
  })

  afterEach(async () => {
    await fs.rm(tasksDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  const lookups = (mergeState: () => Promise<'mergeable' | 'conflicting' | 'unknown' | null>) => ({
    lookUpPrNumber: async () => ({ prNumber: '77', isOpen: true }),
    lookUpPrMergeState: mergeState,
    prNumberCache: createPrNumberCache(),
    prMergeStateCache: createPrMergeStateCache(),
  })

  it('resolves the PR number and merge state with the same pipeline the server uses', async () => {
    const [task] = await loadTasks(tasksDir, DEFAULT_SETTINGS, lookups(async () => 'conflicting'))
    expect(task).toMatchObject({ slug: 'a-task', prNumber: '77', prMergeState: 'conflicting' })
  })

  it('reads a gh failure as unknown, logs it, and never as conflicting', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const [task] = await loadTasks(
      tasksDir,
      DEFAULT_SETTINGS,
      lookups(async () => {
        throw new Error('gh unreachable')
      }),
    )
    expect(task.prMergeState).toBe('unknown')
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('77'), expect.any(Error))
  })
})

// Real STATUS / TIMELINE / VERIFY / AUTO_MODE files in a temp tasks dir, read
// through the CLI's own production wiring (babysitDeps → loadTasks → gh), with
// a fake `gh` first on PATH. Only the load and tmux are injected: the machine's
// real load would make these flaky, and tmux must never be the real one.
// Every `next` spawns a node fake `gh` per task, and one test sweeps a whole
// board call by call; at the 5 s default that is a coin flip on a loaded machine.
const REAL_FILES_TEST_TIMEOUT_MS = 30_000

describe('babysit over real task files and a fake gh', { timeout: REAL_FILES_TEST_TIMEOUT_MS }, () => {
  const HOSTILE_NAMES = ['ev$(touch PWNED)', 'ev`touch PWNED2`', 'ev name', 'ev\nnl', '-rf', 'ev,comma']
  const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, 'gh-calls.log'), JSON.stringify(args) + '\\n')
const prs = JSON.parse(fs.readFileSync(path.join(__dirname, 'prs.json'), 'utf-8'))
if (args[0] === 'pr' && args[1] === 'list') {
  const pr = prs.find((candidate) => candidate.branch === args[args.indexOf('--head') + 1])
  console.log(JSON.stringify(pr ? [{ number: pr.number, state: 'OPEN', createdAt: '2026-10-01T00:00:00Z', isCrossRepository: false }] : []))
} else if (args[0] === 'pr' && args[1] === 'view') {
  const pr = prs.find((candidate) => String(candidate.number) === args[2])
  if (!pr) { process.stderr.write('no such PR'); process.exit(1) }
  console.log(JSON.stringify({ state: 'OPEN', mergeable: pr.mergeable, mergeStateStatus: pr.mergeable === 'CONFLICTING' ? 'DIRTY' : 'CLEAN', headRefName: pr.branch }))
} else process.exit(2)
`

  let root: string
  let tasksDir: string
  let binDir: string
  let liveTmux: string[]
  let deps: BabysitDeps

  interface TaskFiles {
    status: string
    timeline?: string[]
    verify?: string
    autoMode?: 'auto' | 'manual'
  }

  async function writeTask(slug: string, { status, timeline = [], verify = UNIT_VERIFY, autoMode }: TaskFiles): Promise<void> {
    const dir = path.join(tasksDir, slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'TASK.md'), `## Workspace\n- Repo: cockpit-ai\n- Branch: claude/${slug}\n`)
    await fs.writeFile(path.join(dir, 'STATUS'), `${status}\n`)
    await fs.writeFile(path.join(dir, 'TIMELINE'), timeline.map((line) => `${line}\n`).join(''))
    await fs.writeFile(path.join(dir, 'VERIFY'), `${verify}\n`)
    if (autoMode) await fs.writeFile(path.join(dir, 'AUTO_MODE'), `${autoMode}\n`)
  }

  async function writePrs(prs: { branch: string; number: number; mergeable: 'MERGEABLE' | 'CONFLICTING' }[]): Promise<void> {
    await fs.writeFile(path.join(binDir, 'prs.json'), JSON.stringify(prs))
  }

  const run = (...argv: string[]): Promise<BabysitResult> => runBabysit(argv, deps)

  // What the skill does: call `next`, add the printed slug to --done, repeat.
  // Bounded by the number of task dirs plus one, so an action handed out
  // forever fails here instead of hanging.
  async function sweep(): Promise<{ slugs: string[]; exitCode: number }> {
    const taskDirCount = (await fs.readdir(tasksDir)).length
    const slugs: string[] = []
    for (let call = 0; call <= taskDirCount; call++) {
      const result = await run('next', '--done', slugs.join(','))
      if (result.exitCode !== 0) return { slugs, exitCode: result.exitCode }
      const { slug } = JSON.parse(result.stdout[0])
      expect(slugs).not.toContain(slug)
      slugs.push(slug)
    }
    throw new Error(`next kept handing out actions after ${taskDirCount + 1} calls: ${slugs.join(',')}`)
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-babysit-real-'))
    tasksDir = path.join(root, 'tasks')
    binDir = path.join(root, 'bin')
    await fs.mkdir(tasksDir)
    await fs.mkdir(path.join(root, 'repos', 'cockpit-ai'), { recursive: true })
    await fs.mkdir(path.join(root, 'worktrees'))
    await fs.mkdir(binDir)
    await fs.writeFile(path.join(binDir, 'gh'), FAKE_GH, { mode: 0o755 })
    await writePrs([])
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH}`)
    vi.stubEnv('REPOS_DIR', path.join(root, 'repos'))
    vi.stubEnv('WORKTREES_DIR', path.join(root, 'worktrees'))
    liveTmux = []
    deps = { ...babysitDeps(tasksDir), loadavg: () => 1, listTmuxSessions: async () => liveTmux }
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    await fs.rm(root, { recursive: true, force: true })
  })

  describe('a mixed board', () => {
    beforeEach(async () => {
      await writeTask('t-plan', { status: 'waiting: plan ready for review' })
      await writeTask('t-dev', { status: 'waiting: plan reviewed, ready for dev' })
      await writeTask('t-cr', { status: 'waiting: PR open, ready for CR', timeline: ['2026-10-09T10:00:00Z dev PR #11 opened'] })
      await writeTask('t-conflict', { status: 'waiting: PR open, ready for CR', timeline: ['2026-10-09T10:00:00Z dev PR #12 opened'] })
      await writeTask('t-merge', { status: 'waiting: QA passed, ready to merge', timeline: ['2026-10-09T10:00:00Z dev PR #13 opened'] })
      // AUTO_MODE is not QA consent: only qaStartPolicy is.
      await writeTask('t-qa', { status: 'waiting: CR approved, ready for QA', verify: UI_VERIFY, autoMode: 'auto', timeline: ['2026-10-09T10:00:00Z dev PR #14 opened'] })
      await writeTask('t-working', { status: 'working' })
      for (const name of HOSTILE_NAMES) await writeTask(name, { status: 'waiting: PR open, ready for CR' })
      await writePrs([
        { branch: 'claude/t-cr', number: 11, mergeable: 'MERGEABLE' },
        { branch: 'claude/t-conflict', number: 12, mergeable: 'CONFLICTING' },
        { branch: 'claude/t-merge', number: 13, mergeable: 'MERGEABLE' },
        { branch: 'claude/t-qa', number: 14, mergeable: 'MERGEABLE' },
      ])
    })

    it('hands out each safe action once, furthest-along first, then stops (exit 3)', async () => {
      expect(await sweep()).toEqual({ slugs: ['t-cr', 't-dev', 't-plan'], exitCode: 3 })
    })

    it('reads the conflict from gh itself, so the conflicting PR is never handed out', async () => {
      await sweep()
      const calls = (await fs.readFile(path.join(binDir, 'gh-calls.log'), 'utf-8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
      expect(calls).toContainEqual(['pr', 'view', '12', '--json', 'state,mergeable,mergeStateStatus,headRefName'])
    })

    it('never prints a hostile folder name, as a slug or inside a command, and runs nothing from it', async () => {
      const printed: string[] = []
      const done: string[] = []
      for (let call = 0; call < 10; call++) {
        const result = await run('next', '--done', done.join(','))
        printed.push(...result.stdout)
        if (result.exitCode !== 0) break
        done.push(JSON.parse(result.stdout[0]).slug)
      }
      const report = await run('report', '--done', done.join(','))
      printed.push(...report.stdout)
      for (const name of HOSTILE_NAMES) {
        expect(printed.join('\n')).not.toContain(name)
        expect(report.stderr.join('\n')).toContain(JSON.stringify(name))
      }
      expect(report.stdout.join('\n')).toContain(`**ignored:** ${HOSTILE_NAMES.length} task dir(s)`)
      expect(fsSync.existsSync(path.join(process.cwd(), 'PWNED'))).toBe(false)
      expect(fsSync.existsSync(path.join(tasksDir, 'PWNED'))).toBe(false)
    })

    it('reports what moved, and lists the conflict, the merge and the un-consented QA as the developer\'s', async () => {
      const { slugs } = await sweep()
      const text = (await run('report', '--done', slugs.join(','))).stdout.join('\n')
      expect(text).toMatch(/^\*\*moved:\*\* t-cr, t-dev, t-plan$/m)
      const needsYou = text.split('**needs you:**')[1]
      expect(needsYou).toMatch(/^- t-merge — merge /m)
      expect(needsYou).toMatch(/^- t-conflict — merge-conflicts /m)
      expect(needsYou).toMatch(/^- t-qa — qa-consent /m)
      expect(text).not.toContain('t-working')
    })

    it('a `note` written after a dispatch keeps the task out of the next sweep', async () => {
      expect((await run('note', 't-cr', 'code-review')).exitCode).toBe(0)
      expect((await sweep()).slugs).not.toContain('t-cr')
    })
  })

  describe('one QA at a time, from real files', () => {
    beforeEach(async () => {
      await fs.writeFile(path.join(tasksDir, 'SETTINGS.json'), JSON.stringify({ qaStartPolicy: 'cockpit-ai-ui-preapproved' }))
      deps.intentBriefStages = QA_BRIEF_STAGES
      for (const [slug, number] of [['q-one', 21], ['q-two', 22]] as const) {
        await writeTask(slug, { status: `waiting: ${QA_MARKER}`, verify: UI_VERIFY, timeline: [`2026-10-09T10:00:00Z dev PR #${number} opened`] })
      }
      await writePrs([
        { branch: 'claude/q-one', number: 21, mergeable: 'MERGEABLE' },
        { branch: 'claude/q-two', number: 22, mergeable: 'MERGEABLE' },
      ])
    })

    it('hands out one QA, and with no qa note written still not a second, while its worker session is live', async () => {
      const first = await run('next')
      expect(JSON.parse(first.stdout[0])).toMatchObject({ kind: 'dispatch', stage: 'qa' })
      const firstSlug: string = JSON.parse(first.stdout[0]).slug
      // What the QA launch script leaves behind: STATUS working and a live
      // worker tmux session, but no `qa` TIMELINE note (the note failed).
      await fs.writeFile(path.join(tasksDir, firstSlug, 'STATUS'), 'working\n')
      liveTmux = [`worker-${firstSlug}-qa`]
      expect((await run('next', '--done', firstSlug)).exitCode).toBe(3)
      expect((await run('next')).exitCode).toBe(3)
      expect((await run('report', '--done', firstSlug)).stdout.join('\n')).toMatch(/q-(one|two) — (qa-in-flight|one-qa-per-sweep)/)
    })

    it('frees the slot again once that worker session is gone (the failure path is not a permanent hold)', async () => {
      liveTmux = []
      expect(JSON.parse((await run('next')).stdout[0]).stage).toBe('qa')
    })
  })
})
