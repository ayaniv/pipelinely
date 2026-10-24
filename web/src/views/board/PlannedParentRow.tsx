import type { MouseEvent } from 'react'
import type { Task } from '../../../../src/types'
import type { OpenTask } from '../../shell/appNavigation'
import { taskUrl } from '../../shell/routes'
import { openOnPlainClick } from './rowOpenGuard'

// A plan-approved parent whose first wave has not started, listed in the
// Backlog tab (DESIGN_PROMPT §2). It has no BACKLOG.md line, so it carries
// none of a backlog row's edit / delete / run actions: the plan is the one
// place to start its first wave from, and it joins the Parent tasks section
// as soon as a milestone is dispatched.

const DEV_STAGE_ID = 'dev'

export interface PlannedParentRowProps {
  task: Task
  onOpenPlan: OpenTask
}

export function PlannedParentRow({ task, onOpenPlan }: PlannedParentRowProps) {
  const milestoneCount = task.milestones?.length ?? 0
  const handleOpenPlan = (event: MouseEvent<HTMLAnchorElement>) => openOnPlainClick(event, () => onOpenPlan(task.slug, { stage: DEV_STAGE_ID }))
  return (
    <li className="backlog-row-item" data-testid="backlog-planned-parent" data-slug={task.slug} data-project={task.repo || undefined}>
      <div className="backlog-card">
        <div className="backlog-row-main">
          <div className="backlog-row-title-line">
            {task.repo ? <span className="card-slug-project backlog-row-project" data-testid="backlog-planned-parent-project">{task.repo}</span> : null}
            <div className="backlog-row-title" data-testid="backlog-planned-parent-title">{task.title}</div>
          </div>
          <div className="backlog-row-context" data-testid="backlog-planned-parent-context">Plan approved · {milestoneCount} milestones · first wave not started</div>
        </div>
        <div className="backlog-row-actions">
          <a className="parent-open-plan" data-testid="backlog-planned-parent-open" href={taskUrl(task.slug, DEV_STAGE_ID)} onClick={handleOpenPlan}>Open plan →</a>
        </div>
      </div>
    </li>
  )
}
