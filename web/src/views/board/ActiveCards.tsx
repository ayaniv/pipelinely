import { Fragment } from 'react'
import type { CreaturePlacement, Task } from '../../../../src/types'
import type { OpenTask } from '../../shell/appNavigation'
import { cardGridColumns, groupActiveTasks } from './boardModel'
import { ActiveGroupHeader } from './ActiveGroupHeader'
import { EmptyState } from './EmptyState'
import { PlanCard } from './PlanCard'
import { SessionCard } from './SessionCard'

// The Active panel's body: the design's two attention buckets, each a header
// plus a grid of cards. Keyed by slug throughout, so React reconciles a card
// in place rather than recreating every node whenever any task changes.

export interface ActiveCardsProps {
  tasks: Task[]
  now: number
  isTaskOffFocus: (slug: string) => boolean
  onToggleOffFocus: (slug: string) => void
  onOpenDetail: OpenTask
  creaturePlacement: CreaturePlacement
}

export function ActiveCards({ tasks, now, isTaskOffFocus, onToggleOffFocus, onOpenDetail, creaturePlacement }: ActiveCardsProps) {
  if (tasks.length === 0) {
    return <EmptyState />
  }
  return (
    <>
      {groupActiveTasks(tasks).map(({ definition, tasks: groupTasks }) => (
        <div className="active-group" data-testid={definition.testId} key={definition.testId}>
          <ActiveGroupHeader label={definition.label} count={groupTasks.length} />
          <div className="active-group-grid" style={{ gridTemplateColumns: cardGridColumns(definition.minCardPx) }}>
            {groupTasks.map((task) => (
              <Fragment key={task.slug}>
                <SessionCard task={task} now={now} isOffFocus={isTaskOffFocus(task.slug)} onToggleOffFocus={onToggleOffFocus} onOpenDetail={onOpenDetail} creaturePlacement={creaturePlacement} />
                <PlanCard task={task} />
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
