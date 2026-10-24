import fs from 'node:fs/promises'
import path from 'node:path'
import type { MergeBlocker } from './mergeGate.js'
import { DESIGN_APPROVED_MARKER, DESIGN_CHANGES_REQUESTED_MARKER, matchTableEntry } from './nextStageCta.js'
import { appendTimelineLine, parseStatusContent } from './taskParser.js'
import type { Task } from './types.js'

// The designer's gate in the ds pipeline: after design QA, a person approves
// the Storybook-vs-Figma comparison or sends it back with notes. Everything
// that decides or records that lives here, so the route and the merge gate
// read one definition.

export const DESIGN_APPROVED_NOTE = 'approved'
export const DESIGN_CHANGES_REQUESTED_NOTE = 'changes requested'
// Built from the hand-off marker so the status the route writes can never drift from what the overlay matches.
const DESIGN_CHANGES_STATUS_REASON = `design changes requested, ${DESIGN_CHANGES_REQUESTED_MARKER}`
export const DESIGN_FEEDBACK_FILE = 'DESIGN_FEEDBACK.md'

// Merge is refused for a ds task unless the designer's latest word is an
// approval AND it came after the latest design QA run (an approval of
// screenshots that a design-fixes round has since replaced approves nothing)
// AND STATUS agrees. STATUS is written after TIMELINE, so requiring it too
// means a decision whose STATUS write failed never opens the gate.
// Off-chain lines (a conflict fix) sit between them harmlessly, since only
// design-qa and design-approval lines are compared.
export function designApprovalBlocker(task: Pick<Task, 'kind' | 'stageHistory' | 'status' | 'waitingReason'>): MergeBlocker | null {
  if (task.kind !== 'ds') return null
  const lastIndexOf = (stage: 'design-qa' | 'design-approval') => task.stageHistory.map((e) => e.stage).lastIndexOf(stage)
  const lastApprovalIndex = lastIndexOf('design-approval')
  const lastApproval = task.stageHistory[lastApprovalIndex]
  const isApprovedAfterDesignQa = !!lastApproval && lastApproval.note === DESIGN_APPROVED_NOTE && lastApprovalIndex > lastIndexOf('design-qa')
  const isStatusApproved = task.status === 'waiting' && (task.waitingReason ?? '').trim().endsWith(DESIGN_APPROVED_MARKER)
  if (isApprovedAfterDesignQa && isStatusApproved) return null
  return { kind: 'design-approval-required', detail: "The designer has not approved this design yet — approve it on the task's Design approval tab before merging" }
}

export type DesignApprovalDecision =
  | { decision: 'approve' }
  | { decision: 'request-changes'; notes: unknown }

function parseDecision(body: unknown): DesignApprovalDecision | null {
  if (!body || typeof body !== 'object') return null
  const { decision, notes } = body as { decision?: unknown; notes?: unknown }
  if (decision === 'approve') return { decision }
  if (decision === 'request-changes') return { decision, notes }
  return null
}

export type DesignApprovalOutcome = 'approved' | 'changes-requested' | 'not-at-gate' | 'blank-notes' | 'invalid-decision'

// One decision at a time per task. The route's task list is only refreshed
// after the files are written, so without this two simultaneous requests both
// see the gate and both write (an approval can then overwrite a recorded
// change request). In-process only: one server owns a tasks dir.
const decisionQueueBySlug = new Map<string, Promise<unknown>>()

async function runExclusively<T>(slug: string, action: () => Promise<T>): Promise<T> {
  const previous = decisionQueueBySlug.get(slug) ?? Promise.resolve()
  const run = previous.then(action, action)
  const settled = run.catch(() => undefined)
  decisionQueueBySlug.set(slug, settled)
  try {
    return await run
  } finally {
    if (decisionQueueBySlug.get(slug) === settled) decisionQueueBySlug.delete(slug)
  }
}

// Writes the same files a worker finishing a stage would (TIMELINE, then
// STATUS last, since STATUS is the signal the dashboard and the merge gate
// react to). A failed write is not caught here: the route logs it and answers
// 500, and the merge gate also requires the approved STATUS, so a half-written
// decision never opens it.
//
// "At the gate" is judged from STATUS on disk, inside the lock, not from the
// caller's cached task: an earlier decision may have landed since it was read.
export function applyDesignApproval(
  tasksDir: string,
  task: Pick<Task, 'slug' | 'kind'>,
  body: unknown,
): Promise<DesignApprovalOutcome> {
  return runExclusively(task.slug, async () => {
    if (task.kind !== 'ds') return 'not-at-gate'
    const taskDir = path.join(tasksDir, task.slug)
    const statusOnDisk = parseStatusContent(await fs.readFile(path.join(taskDir, 'STATUS'), 'utf-8').catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return ''
      throw err
    }))
    if (matchTableEntry({ kind: 'ds', ...statusOnDisk })?.stage !== 'design-approval') return 'not-at-gate'

    const decision = parseDecision(body)
    if (!decision) return 'invalid-decision'

    if (decision.decision === 'approve') {
      await appendTimelineLine(taskDir, 'design-approval', DESIGN_APPROVED_NOTE)
      await fs.writeFile(path.join(taskDir, 'STATUS'), `waiting: ${DESIGN_APPROVED_MARKER}\n`)
      return 'approved'
    }

    const notes = typeof decision.notes === 'string' ? decision.notes.trim() : ''
    if (!notes) return 'blank-notes'
    await fs.writeFile(path.join(taskDir, DESIGN_FEEDBACK_FILE), `${notes}\n`)
    await appendTimelineLine(taskDir, 'design-approval', DESIGN_CHANGES_REQUESTED_NOTE)
    await fs.writeFile(path.join(taskDir, 'STATUS'), `waiting: ${DESIGN_CHANGES_STATUS_REASON}\n`)
    return 'changes-requested'
  })
}
