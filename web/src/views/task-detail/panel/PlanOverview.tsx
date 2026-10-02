import type { PlanTestGroup } from '../../../../../src/types'
import { ServerHtml } from '../../../components/ServerHtml'
import type { TechDesign } from '../../../data/taskResources'
import { PlannedQaRows } from './Checklists'
import { PanelNote } from './PanelLayout'

// The Plan tab's pinned overview: a plan's hand-written `## Summary` prose,
// then the e2e test titles that will run against the task — one group per
// declared milestone, or a single unlabelled group for a flat task's own QA
// Spec line. Shown only once the plan has loaded.

// data-plan-milestone-id, not data-milestone-id: that attribute marks a
// milestone card (specs select cards by it), and a plan-test group is not one.
function PlanTestsGroup({ group }: { group: PlanTestGroup }) {
  return (
    <div className="plan-tests-group" data-testid="plan-tests-group" data-plan-milestone-id={group.milestoneId ?? undefined}>
      <div className="detail-row-checklist-header">
        {group.milestoneId && (
          <span className="sess-note" data-testid="plan-tests-group-milestone">{group.milestoneId}{group.name ? ` — ${group.name}` : ''}</span>
        )}
        {group.specFile && <span className="sess-note" data-testid="plan-tests-group-spec">{group.specFile}</span>}
      </div>
      <div className="finding-list"><PlannedQaRows titles={group.titles} /></div>
      {group.missingSpecFiles.length > 0 && (
        <PanelNote testId="plan-tests-missing-spec">
          {group.missingSpecFiles.join(', ')} {group.hasWorktree ? 'not found in the worktree' : 'no worktree on disk to read it from'}
        </PanelNote>
      )}
    </div>
  )
}

export function PlanOverview({ design }: { design: TechDesign }) {
  return (
    <>
      <div className="plan-overview" data-testid="plan-summary">
        {design.summaryHtml
          ? <ServerHtml testId="plan-summary-body" className="markdown-body" html={design.summaryHtml} />
          : <PanelNote testId="plan-summary-missing">This plan has no <code>## Summary</code> section yet.</PanelNote>}
      </div>
      <div className="plan-overview" data-testid="plan-tests">
        {design.testGroups.length
          ? design.testGroups.map((group) => <PlanTestsGroup key={group.milestoneId ?? group.specFile ?? 'flat'} group={group} />)
          : <PanelNote testId="plan-tests-empty">This plan declares no QA spec file yet.</PanelNote>}
      </div>
    </>
  )
}
