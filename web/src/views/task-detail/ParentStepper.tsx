import type { Task } from '../../../../src/types'
import { formatWhen } from '../../format'

// A milestone-declaring task shows three columns, not eight. Its own stage
// still computes exactly as it always has and simply never advances past
// 'dev'; the other five stages happen per milestone, in the child task dirs.
// This is a rendering choice — computeStage is unchanged.
const MILESTONE_PARENT_STAGES = ['planning', 'plan-review', 'dev'] as const

type ColumnKind = 'at' | 'done' | 'unrecorded' | 'pending'

function columnKind(isAt: boolean, isDone: boolean, isUnrecorded: boolean): ColumnKind {
  if (isAt) return 'at'
  if (isDone) return 'done'
  return isUnrecorded ? 'unrecorded' : 'pending'
}

function columnState(task: Task, stage: string, atIndex: number, index: number): { className: string; when: string } {
  // The newest entry wins for a repeated stage (a review sent back and redone).
  const event = task.stageHistory.filter((candidate) => candidate.stage === stage).at(-1)
  // Only a stage TIMELINE actually recorded counts as done — inferring "done"
  // from index position alone drew a false history for a task whose worker
  // never wrote TIMELINE at all. A finished task has nothing "pending" left
  // either, but an un-reached stage on a done task is not known to have been
  // skipped: TIMELINE absence proves nothing was recorded, not that nothing
  // happened.
  const isAt = index === atIndex
  const isUnrecorded = !isAt && !event && task.status === 'done'
  switch (columnKind(isAt, !!event, isUnrecorded)) {
    case 'at':
      return { className: 'is-at', when: event ? formatWhen(event.at) : 'current' }
    case 'done':
      return { className: 'is-done', when: formatWhen(event!.at) }
    case 'unrecorded':
      return { className: 'is-unrecorded', when: 'not recorded' }
    case 'pending':
      return { className: '', when: '—' }
  }
}

export function ParentStepper({ task }: { task: Task }) {
  const atIndex = task.stage ? MILESTONE_PARENT_STAGES.findIndex((stage) => stage === task.stage) : -1
  return (
    <>
      {MILESTONE_PARENT_STAGES.map((stage, index) => {
        const { className, when } = columnState(task, stage, atIndex, index)
        return (
          <div key={stage} className={`step-col ${className}`.trim()} data-testid="step-col">
            <div className="step-name">{stage.replace(/-/g, ' ')}</div>
            <div className="step-when">{when}</div>
          </div>
        )
      })}
    </>
  )
}
