import type { Task } from '../../../../../src/types'
import { computeNextStageCta } from '../../../../../src/nextStageCta'
import { useTechDesign, type TechDesignState } from '../../../data/taskResources'
import { ServerHtml } from '../../../components/ServerHtml'
import { PanelBody, PanelFooter, PanelHeader, PanelNote } from './PanelLayout'
import { ActionButton, StageCtaButton } from './PanelButtons'
import { PlanOverview } from './PlanOverview'

// Plan and Plan Review show the same substance — the plan itself. The review
// revises tech-design.md in place rather than filing a parallel report, so
// there is only ever one document and the two callers (a fan-out parent's L1
// tabs, a flat task's chain nodes) cannot disagree. `stage` says which of
// the two this render is titled and footed as.

export type PlanStage = 'planning' | 'plan-review'

// Planning is the one tab with no skill of its own to start (a task's card
// only exists once planning has begun), so it has no CTA. Plan Review's skill
// is what finishing planning triggers, and it is hosted here.
const PLAN_REVIEW_CTA_LABEL = 'Start Plan Review'

function DocumentBody({ design }: { design: TechDesignState }) {
  switch (design.status) {
    case 'loading':
      return <div className="markdown-body" data-testid="tech-design-body"><PanelNote testId="tech-design-loading">Loading tech-design.md…</PanelNote></div>
    case 'ready':
      if (design.data === null) return <div className="markdown-body" data-testid="tech-design-body"><PanelNote testId="tech-design-empty">No tech-design.md in this task dir yet.</PanelNote></div>
      return <ServerHtml testId="tech-design-body" className="markdown-body" html={design.data.html} />
    case 'failed':
      // Already logged where the fetch failed; on screen a failed load reads
      // like an absent plan, as it always has.
      return <div className="markdown-body" data-testid="tech-design-body"><PanelNote testId="tech-design-empty">No tech-design.md in this task dir yet.</PanelNote></div>
  }
}

export function PlanTab({ task, stage }: { task: Task; stage: PlanStage }) {
  const design = useTechDesign(task.slug)
  const plan = design.status === 'ready' ? design.data : null
  const hasPlan = plan !== null
  const rounds = task.stageHistory.filter((e) => e.stage === stage).length
  const planPath = `$TASKS_DIR/${task.slug}/tech-design.md`
  const isReviewCtaLive = computeNextStageCta(task)?.stage === stage

  return (
    <>
      <PanelHeader stageId={stage} child={task} />
      <PanelBody>
        <div className="plan-tab-head">
          <span className="sess-note" data-testid="tech-design-source">tech-design.md{rounds ? ` · round ${rounds}` : ''}</span>
          <ActionButton
            action="annotate-plan"
            slug={task.slug}
            label="Open in Plannotator"
            testId="plannotator-btn"
            disabled={!hasPlan}
            title={hasPlan ? `Opens "/plannotator-annotate" on ${planPath} in a new session` : 'No tech-design.md yet'}
          />
        </div>
        {plan && <PlanOverview design={plan} />}
        <DocumentBody design={design} />
      </PanelBody>
      {stage === 'plan-review' && (
        <PanelFooter primary={<StageCtaButton label={PLAN_REVIEW_CTA_LABEL} stage={stage} slug={task.slug} isLive={isReviewCtaLive} testId="plan-review-cta" />} />
      )}
    </>
  )
}
