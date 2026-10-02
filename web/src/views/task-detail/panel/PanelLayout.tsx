import type { ReactNode } from 'react'
import type { Task } from '../../../../../src/types'
import { chainStageById, STAGE_TO_CHAIN_ID, type ChainStageId } from '../../../pipelineStages'
import { useStageScopes } from '../../../data/taskResources'
import { panelHeaderPill, stageNote } from './panelHeader'

// The three regions every stage panel is built from, with the markup and
// classes the stylesheet targets — the computed-CSS specs (design-v2-task-detail's header/footer blocks) are
// the acceptance bar for this staying identical.

function StageScopeBlock({ stageId }: { stageId: ChainStageId }) {
  const { stage } = chainStageById(stageId)
  const scopes = useStageScopes()
  const scope = scopes?.[stage]
  // No block at all — never an empty "What this stage covers" heading — when
  // the scopes have not loaded, failed, this stage has no skill behind it
  // (merge), its skill was unreadable, or it parsed to zero steps.
  if (!scope || !scope.steps.length) return null

  return (
    <div className="stage-scope" data-testid={`stage-scope-${STAGE_TO_CHAIN_ID[stage]}`}>
      <div className="stage-scope-label">What this stage covers</div>
      <ul className="stage-scope-steps">
        {scope.steps.map((step) => <li key={step} data-testid="stage-scope-step">{step}</li>)}
      </ul>
      {scope.constraints.length > 0 && (
        <div className="stage-scope-constraints" data-testid="stage-scope-constraints">
          {scope.constraints.map((constraint) => (
            <span key={constraint} className="stage-scope-constraint" data-testid="stage-scope-constraint">{constraint}</span>
          ))}
        </div>
      )}
    </div>
  )
}

export interface PanelHeaderProps {
  stageId: ChainStageId
  // null for an undispatched milestone.
  child: Task | null
}

// The chain node's own label as a title, the stage's recorded outcome as a
// subtitle (omitted when nothing is recorded), the status pill, and — below —
// the stage's scope block.
export function PanelHeader({ stageId, child }: PanelHeaderProps) {
  const { label, stage } = chainStageById(stageId)
  const pill = panelHeaderPill(child, stageId)
  const note = stageNote(child, stage)

  return (
    <>
      <div className="l2-panel-header">
        <div className="l2-panel-header-text">
          <div className="l2-panel-title" data-testid="l2-panel-title">{label}</div>
          {note && <div className="l2-panel-subtitle" data-testid="detail-panel-meta">{note}</div>}
        </div>
        <span className="l2-panel-pill" data-testid="l2-panel-pill" style={{ background: pill.bg, color: pill.fg }}>{pill.label}</span>
      </div>
      <StageScopeBlock stageId={stageId} />
    </>
  )
}

// The body slot between header and footer. Callers omit it entirely (rather
// than pass empty children) when there is nothing to show — the merge tab
// has none of its own.
export function PanelBody({ children }: { children: ReactNode }) {
  return <div className="l2-panel-body">{children}</div>
}

// The full-bleed footer band: one primary CTA plus zero or more secondaries,
// styled entirely by which slot they sit in.
export function PanelFooter({ primary, secondaries }: { primary: ReactNode; secondaries?: ReactNode }) {
  return (
    <div className="detail-panel-footer" data-testid="detail-panel-footer">
      <div className="l2-footer-primary">{primary}</div>
      <div className="l2-footer-secondary">{secondaries}</div>
    </div>
  )
}

export function PanelNote({ testId, isMuted, children }: { testId?: string; isMuted?: boolean; children: ReactNode }) {
  return <div className={`detail-row-note${isMuted ? ' sess-note' : ''}`} data-testid={testId}>{children}</div>
}

export function NotDispatchedNote() {
  return <PanelNote testId="not-dispatched-note">Not dispatched yet — nothing to show here until it starts.</PanelNote>
}
