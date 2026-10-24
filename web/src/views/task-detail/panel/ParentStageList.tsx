import type { MilestoneStatus } from '../../../../../src/types'
import { navigateToTask } from '../../../shell/appNavigation'
import { milestoneStage, waveCardLabel } from '../../../waveModel'
import { PanelNote } from './PanelLayout'
import type { ParentMilestoneStage } from './panelTarget'

// What a fan-out parent's Code review, QA or Merge node opens: the parent
// never runs those stages itself, so the panel lists the milestones sitting in
// that stage, each linking to its own page where the stage actually happens.

const STAGE_NAME: Record<ParentMilestoneStage, string> = { cr: 'code review', qa: 'QA', merge: 'merge' }

// The Merge node counts merged milestones ("N of M merged"), so its list shows
// them too; a merged milestone is in no stage, so it is listed explicitly.
function isListed(milestone: MilestoneStatus, stage: ParentMilestoneStage): boolean {
  return milestoneStage(milestone) === stage || (stage === 'merge' && milestone.state === 'done')
}

export function ParentStageList({ stage, milestones }: { stage: ParentMilestoneStage; milestones: MilestoneStatus[] }) {
  const inStage = milestones.filter((milestone) => isListed(milestone, stage))
  if (inStage.length === 0) return <PanelNote testId="parent-stage-empty">No milestone is in {STAGE_NAME[stage]} right now.</PanelNote>
  return (
    <div className="parent-stage-list" data-testid="parent-stage-list">
      {inStage.map((milestone) => (
        <button
          key={milestone.id}
          type="button"
          className="parent-stage-row"
          data-testid="parent-stage-row"
          data-milestone-id={milestone.id}
          disabled={!milestone.task}
          onClick={() => milestone.task && navigateToTask(milestone.task.slug)}
        >
          <span className="parent-stage-row-id">{milestone.id}</span>
          <span className="parent-stage-row-name">{milestone.name}</span>
          <span className="parent-stage-row-status">{waveCardLabel(milestone)}</span>
        </button>
      ))}
    </div>
  )
}
