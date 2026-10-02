import type { Task } from '../../../../src/types'
import { StatGrid } from '../../components/ScopeStats'
import { MILESTONE_STATE_LABEL } from '../../milestoneModel'
import { rollupScope } from '../../taskScope'

// Milestone-count progress plus the project-wide stat rollup — the two things
// a single-state card must not show, so they live here, at the top of the one
// view whose whole job is summarizing the project. Weighted by milestone
// COUNT, not estimated hours: an estimate's value is as a calibration signal
// (how far off was the plan?), which each card's est-vs-actual line already
// serves better than folding it into a bar.

export function ProjectSummary({ task }: { task: Task }) {
  const milestones = task.milestones ?? []
  const mergedCount = milestones.filter((milestone) => milestone.state === 'done').length

  return (
    <div className="project-summary" data-testid="project-summary">
      <div className="milestone-progress" data-testid="milestone-progress">
        <span className="ms-dots">
          {milestones.map((milestone) => (
            <span key={milestone.id} className={`ms-dot ms-dot-${milestone.state}`} title={`${milestone.id}: ${milestone.name} — ${MILESTONE_STATE_LABEL[milestone.state]}`} />
          ))}
        </span>
        <span className="ms-progress-label" data-testid="milestone-progress-label">{`${mergedCount} of ${milestones.length} milestones merged`}</span>
      </div>
      <div className="card-stats"><StatGrid scope={rollupScope(task)} allowWarn /></div>
    </div>
  )
}
