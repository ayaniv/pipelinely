import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { applyDesignApproval, designApprovalBlocker } from './designApproval.js'
import type { StageEvent, Task } from './types.js'

const APPROVED_STATUS = { status: 'waiting' as const, waitingReason: 'design approved, ready to merge' }
const event = (stage: StageEvent['stage'], note: string | null = null, at = '2026-10-01T10:00:00Z'): StageEvent => ({ stage, at, note })

describe('designApprovalBlocker', () => {
  it('never blocks a dev task, whatever its TIMELINE says', () => {
    expect(designApprovalBlocker({ kind: 'dev', stageHistory: [], status: 'working' })).toBeNull()
  })

  it('blocks a ds task with no design-approval line at all', () => {
    const blocker = designApprovalBlocker({ kind: 'ds', stageHistory: [event('qa'), event('design-qa', '4 stories compared')], ...APPROVED_STATUS })
    expect(blocker?.kind).toBe('design-approval-required')
    expect(blocker?.detail).toMatch(/design approval/i)
  })

  it('blocks when the last design-approval line requested changes', () => {
    const history = [event('design-qa'), event('design-approval', 'changes requested')]
    expect(designApprovalBlocker({ kind: 'ds', stageHistory: history, ...APPROVED_STATUS })?.kind).toBe('design-approval-required')
  })

  it('blocks an approval that predates the latest design QA run: the code it approved has since changed', () => {
    const history = [event('design-qa'), event('design-approval', 'approved'), event('design-fixes'), event('design-qa')]
    expect(designApprovalBlocker({ kind: 'ds', stageHistory: history, ...APPROVED_STATUS })?.kind).toBe('design-approval-required')
  })

  it('allows a ds task whose last design-approval line is an approval after the last design QA', () => {
    const history = [event('design-qa'), event('design-approval', 'changes requested'), event('design-fixes'), event('design-qa'), event('design-approval', 'approved')]
    expect(designApprovalBlocker({ kind: 'ds', stageHistory: history, ...APPROVED_STATUS })).toBeNull()
  })

  it('blocks an approval line whose STATUS write never landed: a half-written decision must not open merge', () => {
    const history = [event('design-qa'), event('design-approval', 'approved')]
    const staleStatus = { status: 'waiting' as const, waitingReason: 'design QA done, ready for design approval' }
    expect(designApprovalBlocker({ kind: 'ds', stageHistory: history, ...staleStatus })?.kind).toBe('design-approval-required')
  })

  it('ignores an off-chain conflict-fix line between design QA and the approval', () => {
    const history = [event('design-qa'), event('merge-conflicts', 'resolved'), event('design-approval', 'approved')]
    expect(designApprovalBlocker({ kind: 'ds', stageHistory: history, ...APPROVED_STATUS })).toBeNull()
  })
})

describe('applyDesignApproval', () => {
  let tasksDir: string
  const slug = 'ds-task'
  const AT_GATE = { slug, kind: 'ds', status: 'waiting', waitingReason: 'design QA done, ready for design approval' } as Pick<Task, 'slug' | 'kind' | 'status' | 'waitingReason'>
  const read = (name: string) => fs.readFile(path.join(tasksDir, slug, name), 'utf-8').catch(() => null)

  beforeEach(async () => {
    tasksDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-approval-'))
    await fs.mkdir(path.join(tasksDir, slug))
    await fs.writeFile(path.join(tasksDir, slug, 'STATUS'), `waiting: ${AT_GATE.waitingReason}\n`)
    await fs.writeFile(path.join(tasksDir, slug, 'TIMELINE'), '2026-10-01T10:00:00Z design-qa 4 stories compared\n')
  })

  afterEach(async () => {
    await fs.rm(tasksDir, { recursive: true, force: true })
  })

  it('approve appends the approval line and hands the task to merge', async () => {
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).toBe('approved')

    expect(await read('STATUS')).toBe('waiting: design approved, ready to merge\n')
    expect(await read('TIMELINE')).toMatch(/Z design-approval approved\n$/)
  })

  it('request-changes records the trimmed notes, the TIMELINE line, and hands off to design fixes', async () => {
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'request-changes', notes: '  Dark radius should be 8px  ' })).toBe('changes-requested')

    expect(await read('DESIGN_FEEDBACK.md')).toBe('Dark radius should be 8px\n')
    expect(await read('TIMELINE')).toMatch(/Z design-approval changes requested\n$/)
    expect(await read('STATUS')).toBe('waiting: design changes requested, triage and dispatch design-fixes\n')
  })

  it('refuses a task whose STATUS on disk is not the gate and writes nothing', async () => {
    await fs.writeFile(path.join(tasksDir, slug, 'STATUS'), 'waiting: QA passed, ready to merge\n')
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).toBe('not-at-gate')
    expect(await read('STATUS')).toBe('waiting: QA passed, ready to merge\n')
    expect(await read('TIMELINE')).not.toMatch(/design-approval/)
  })

  it('judges the gate from disk, not the caller\'s stale task: a decision that already landed refuses the next', async () => {
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).toBe('approved')
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'request-changes', notes: 'too late' })).toBe('not-at-gate')
    expect(await read('DESIGN_FEEDBACK.md')).toBeNull()
  })

  it('lets exactly one of several simultaneous decisions through, and records only that one', async () => {
    const outcomes = await Promise.all([
      applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' }),
      applyDesignApproval(tasksDir, AT_GATE, { decision: 'request-changes', notes: 'radius' }),
      applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' }),
      applyDesignApproval(tasksDir, AT_GATE, { decision: 'request-changes', notes: 'again' }),
    ])

    expect(outcomes.filter((o) => o === 'approved' || o === 'changes-requested')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'not-at-gate')).toHaveLength(3)
    expect((await read('TIMELINE'))!.match(/design-approval/g)).toHaveLength(1)
  })

  it('keeps serving later decisions after one fails', async () => {
    await fs.rm(path.join(tasksDir, slug, 'TIMELINE'))
    await fs.mkdir(path.join(tasksDir, slug, 'TIMELINE'))
    await expect(applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).rejects.toThrow()
    await fs.rmdir(path.join(tasksDir, slug, 'TIMELINE'))
    await fs.writeFile(path.join(tasksDir, slug, 'TIMELINE'), '')
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).toBe('approved')
  })

  it('refuses a dev task even when its STATUS reads like the gate', async () => {
    expect(await applyDesignApproval(tasksDir, { ...AT_GATE, kind: 'dev' }, { decision: 'approve' })).toBe('not-at-gate')
  })

  it.each([[''], ['   '], [undefined], [42]])('refuses request-changes with notes %j as blank', async (notes) => {
    expect(await applyDesignApproval(tasksDir, AT_GATE, { decision: 'request-changes', notes })).toBe('blank-notes')
    expect(await read('DESIGN_FEEDBACK.md')).toBeNull()
    expect(await read('STATUS')).toBe(`waiting: ${AT_GATE.waitingReason}\n`)
  })

  it.each([[null], [undefined], ['approve'], [{}], [{ decision: 'maybe' }]])('refuses the body %j as an invalid decision', async (body) => {
    expect(await applyDesignApproval(tasksDir, AT_GATE, body)).toBe('invalid-decision')
  })

  it('lets a write failure propagate so the route can log it and answer 500, leaving STATUS at the gate', async () => {
    await fs.rm(path.join(tasksDir, slug, 'TIMELINE'))
    await fs.mkdir(path.join(tasksDir, slug, 'TIMELINE'))
    await expect(applyDesignApproval(tasksDir, AT_GATE, { decision: 'approve' })).rejects.toThrow()
    expect(await read('STATUS')).toBe(`waiting: ${AT_GATE.waitingReason}\n`)
  })
})
