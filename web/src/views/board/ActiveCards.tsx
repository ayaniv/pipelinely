import { Fragment } from 'react'
import type { Task } from '../../../../src/types'
import { groupActiveTasks } from './boardModel'
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
  onOpenDetail: (slug: string) => void
}

export function ActiveCards({ tasks, now, isTaskOffFocus, onToggleOffFocus, onOpenDetail }: ActiveCardsProps) {
  if (tasks.length === 0) {
    return <EmptyState />
  }
  return (
    <>
      {groupActiveTasks(tasks).map(({ definition, tasks: groupTasks }) => (
        <div className="active-group" data-testid={definition.testId} key={definition.testId}>
          <div className="active-group-header">
            <span className="active-group-art" style={{ backgroundImage: `url('/art/${definition.art}')` }} />
            <span className="active-group-label">{definition.label}</span>
            <span className="active-group-count">&middot; {groupTasks.length}</span>
            <span className="active-group-rule" />
          </div>
          <div className="active-group-grid">
            {groupTasks.map((task) => (
              <Fragment key={task.slug}>
                <SessionCard task={task} now={now} isOffFocus={isTaskOffFocus(task.slug)} onToggleOffFocus={onToggleOffFocus} onOpenDetail={onOpenDetail} />
                <PlanCard task={task} />
              </Fragment>
            ))}
          </div>
        </div>
      ))}
    </>
  )
}
