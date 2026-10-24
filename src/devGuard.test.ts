import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { checkDevTarget, describeDevGuardOutcome } from './devGuard.js'

const tsxBin = path.resolve(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx')
const cliPath = path.resolve(import.meta.dirname, 'devGuardCli.ts')

const PARENT = 'big-feature'
const THREE_MILESTONES = `# Plan

## Milestones
- M0: Foundations — needs: none — est: 2h
- M1: API — needs: M0 — est: 3h
- M2: UI — needs: M0, M1 — est: 4h
`

let sandbox: string
let tasksDir: string

beforeEach(() => {
  sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-guard-')))
  tasksDir = path.join(sandbox, 'tasks')
  fs.mkdirSync(tasksDir)
})

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true })
})

function writeTask(slug: string, files: Record<string, string>): void {
  const dir = path.join(tasksDir, slug)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
}

const PLAN_REVIEWED_TIMELINE = '2026-10-01T10:00:00Z planning done\n2026-10-01T11:00:00Z plan-review approved\n'

function writeReviewedParent(techDesign: string = THREE_MILESTONES): void {
  writeTask(PARENT, { 'tech-design.md': techDesign, STATUS: 'working', TIMELINE: PLAN_REVIEWED_TIMELINE })
}

describe('checkDevTarget', () => {
  it('lets a flat task through — its tech-design.md declares no milestones', async () => {
    writeTask('flat-task', { 'tech-design.md': '# Plan\n\nJust do the thing.\n', STATUS: 'working' })

    expect(await checkDevTarget(tasksDir, 'flat-task')).toEqual({ kind: 'dispatchable' })
  })

  it('lets a brand-new slug through — no task dir exists yet', async () => {
    expect(await checkDevTarget(tasksDir, 'never-seen')).toEqual({ kind: 'dispatchable' })
  })

  it('lets a task with a tech-design.md-less dir through', async () => {
    writeTask('no-plan', { STATUS: 'working' })

    expect(await checkDevTarget(tasksDir, 'no-plan')).toEqual({ kind: 'dispatchable' })
  })

  it('lets a milestone child through — it has no tech-design.md of its own', async () => {
    writeTask(PARENT, { 'tech-design.md': THREE_MILESTONES, STATUS: 'working' })
    writeTask(`${PARENT}-m0`, { STATUS: 'working' })

    expect(await checkDevTarget(tasksDir, `${PARENT}-m0`)).toEqual({ kind: 'dispatchable' })
  })

  it('lets a malformed Milestones section through — no bullet parses, so nothing is declared', async () => {
    writeTask('garbled', { 'tech-design.md': '## Milestones\nsome prose\n- not a milestone bullet\n', STATUS: 'working' })

    expect(await checkDevTarget(tasksDir, 'garbled')).toEqual({ kind: 'dispatchable' })
  })

  it('refuses a parent with queued, dispatched and done milestones, and says which are dispatchable now', async () => {
    writeReviewedParent()
    writeTask(`${PARENT}-m0`, { STATUS: 'done' })
    writeTask(`${PARENT}-m1`, { STATUS: 'working' })

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind).toBe('milestone-parent')
    if (outcome.kind !== 'milestone-parent') return
    expect(outcome.milestones.map(({ id, name, state, isDispatchableNow }) => ({ id, name, state, isDispatchableNow }))).toEqual([
      { id: 'M0', name: 'Foundations', state: 'done', isDispatchableNow: false },
      { id: 'M1', name: 'API', state: 'dispatched', isDispatchableNow: false },
      { id: 'M2', name: 'UI', state: 'queued', isDispatchableNow: false },
    ])
  })

  it('marks a queued milestone dispatchable once every milestone it needs is done', async () => {
    writeReviewedParent()
    writeTask(`${PARENT}-m0`, { STATUS: 'done' })

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind === 'milestone-parent' && outcome.milestones.filter((m) => m.isDispatchableNow).map((m) => m.id)).toEqual(['M1'])
  })

  it('still refuses a parent whose milestones are all done', async () => {
    writeTask(PARENT, { 'tech-design.md': THREE_MILESTONES, STATUS: 'working' })
    for (const n of [0, 1, 2]) writeTask(`${PARENT}-m${n}`, { STATUS: 'done' })

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind).toBe('milestone-parent')
    expect(outcome.kind === 'milestone-parent' && outcome.milestones.every((m) => m.state === 'done' && !m.isDispatchableNow)).toBe(true)
  })

  it('refuses a parent whose milestones are all still queued, with only the root dispatchable', async () => {
    writeReviewedParent()

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind === 'milestone-parent' && outcome.milestones.filter((m) => m.isDispatchableNow).map((m) => m.id)).toEqual(['M0'])
  })

  it('marks nothing dispatchable before the parent is plan-reviewed, even for a root milestone', async () => {
    writeTask(PARENT, { 'tech-design.md': THREE_MILESTONES, STATUS: 'working', TIMELINE: '2026-10-01T10:00:00Z planning done\n' })

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind === 'milestone-parent' && outcome.milestones.some((m) => m.isDispatchableNow)).toBe(false)
  })

  it('does not count a needs: id that no milestone declares as done', async () => {
    writeReviewedParent('## Milestones\n- M0: Foundations — needs: M9 — est: 2h\n')

    const outcome = await checkDevTarget(tasksDir, PARENT)

    expect(outcome.kind === 'milestone-parent' && outcome.milestones.map((m) => m.isDispatchableNow)).toEqual([false])
  })

  it('throws when tech-design.md exists but cannot be read, rather than letting the slug through', async () => {
    writeTask(PARENT, { STATUS: 'working' })
    fs.mkdirSync(path.join(tasksDir, PARENT, 'tech-design.md'))

    await expect(checkDevTarget(tasksDir, PARENT)).rejects.toThrow()
  })

  it('rejects a slug that is not a plain directory name rather than reading outside the tasks dir', async () => {
    await expect(checkDevTarget(tasksDir, '../escape')).rejects.toThrow()
  })
})

describe('describeDevGuardOutcome', () => {
  it('exits 0 with no output for a dispatchable target', () => {
    expect(describeDevGuardOutcome(PARENT, { kind: 'dispatchable' })).toEqual({ exitCode: 0, lines: [] })
  })

  it('exits 2 and lists every milestone with its state and the dispatchable ones', async () => {
    writeReviewedParent()
    writeTask(`${PARENT}-m0`, { STATUS: 'done' })

    const { exitCode, lines } = describeDevGuardOutcome(PARENT, await checkDevTarget(tasksDir, PARENT))
    const text = lines.join('\n')

    expect(exitCode).toBe(2)
    expect(text).toContain(`'${PARENT}' is a milestone parent`)
    expect(text).toContain('M0 Foundations — done')
    expect(text).toContain('M1 API — queued')
    expect(text).toContain('M2 UI — queued')
    expect(text).toContain(`/pipelinely-dev ${PARENT}-m1`)
    expect(text).not.toContain(`/pipelinely-dev ${PARENT}-m2`)
  })

  it('says nothing is dispatchable when every milestone is done or running', async () => {
    writeReviewedParent()
    for (const n of [0, 1, 2]) writeTask(`${PARENT}-m${n}`, { STATUS: 'done' })

    const { lines } = describeDevGuardOutcome(PARENT, await checkDevTarget(tasksDir, PARENT))

    expect(lines.join('\n')).toContain('Nothing is dispatchable')
  })
})

describe('dev-guard CLI', () => {
  function runCli(args: string[]) {
    const env: NodeJS.ProcessEnv = { ...process.env, TASKS_DIR: tasksDir, INIT_CWD: sandbox }
    const result = spawnSync(tsxBin, [cliPath, ...args], { env, cwd: sandbox, encoding: 'utf-8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  it('exits 0 for a flat task', () => {
    writeTask('flat-task', { 'tech-design.md': '# Plan\n', STATUS: 'working' })

    expect(runCli(['flat-task']).status).toBe(0)
  })

  it('exits 2 for a milestone parent, listing the milestones on stdout', () => {
    writeTask(PARENT, { 'tech-design.md': THREE_MILESTONES, STATUS: 'working' })

    const result = runCli([PARENT])

    expect(result.status).toBe(2)
    expect(result.stdout).toContain('M0 Foundations — queued')
  })

  it('exits 1 with one stderr line when no slug is given', () => {
    const result = runCli([])

    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
    expect(result.stderr).toContain('Usage')
  })

  it('exits 1 for a slug that tries to leave the tasks dir', () => {
    const result = runCli(['../escape'])

    expect(result.status).toBe(1)
    expect(result.stderr.trim().split('\n')).toHaveLength(1)
  })
})
