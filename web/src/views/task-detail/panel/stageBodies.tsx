import type { ReactNode } from 'react'
import type { Stage, Task } from '../../../../../src/types'
import { computeNextStageCta } from '../../../../../src/nextStageCta'
import { FocusButton } from '../../../components/FocusButton'
import { useQaSpec } from '../../../data/taskResources'
import { clientState, useClientState } from '../../../data/clientState'
import { useTaskDetailNav } from '../detailNav'
import { findPrNumber } from '../../../taskScope'
import { FindingsChecklist, PlannedQaList, QaCaseList, QaFailuresChecklist, TriageContainer } from './Checklists'
import { MergeBanner } from '../../../components/MergeBanner'
import { ActionButton, MarkDoneButton, MergeButton, SkipButton, StageCtaButton } from './PanelButtons'
import { NotDispatchedNote, PanelBody, PanelFooter, PanelHeader, PanelNote } from './PanelLayout'
import { stageNote } from './panelHeader'
import { useTriageSelection } from './useTriageSelection'

// One body per stage tab, each header + body + footer. `child` is the task whose stage this is — null for
// a milestone that has not been dispatched yet.

export interface StagePanelExtra {
  // null for a flat task: "needs" is milestone jargon with no referent, so
  // the row is omitted rather than shown empty. A real (possibly empty)
  // array means a milestone, which keeps its own wording even when empty.
  needs: string[] | null
  stateLabel: string
  // Only an undispatched milestone: whether Start Dev may go, and the slug
  // its child will get.
  readyForDev?: boolean
  milestoneSlug?: string
}

export interface StageBodyProps {
  child: Task | null
  extra: StagePanelExtra
  openTaskSlug: string
}

const isNextStage = (child: Task, stage: Stage) => computeNextStageCta(child)?.stage === stage
const plural = (count: number) => (count === 1 ? '' : 's')

function ParseMismatchWarning({ mismatches, testId }: { mismatches: string[]; testId: string }) {
  if (!mismatches.length) return null
  return <div className="ctx-warning" data-testid={testId}>⚠ Bullet parse mismatch — {mismatches.join('; ')}</div>
}

// The one body every "not dispatched yet" tab shares: a header and a note,
// with no footer — there is nothing to act on until the milestone starts.
function UndispatchedStage({ stageId }: { stageId: 'cr' | 'cr-fixes' | 'qa' | 'qa-fixes' | 'merge' }) {
  return (
    <>
      <PanelHeader stageId={stageId} child={null} />
      <PanelBody><NotDispatchedNote /></PanelBody>
    </>
  )
}

export function DevStage({ child, extra }: StageBodyProps) {
  const dispatchRows: { label: string; value: string }[] = []
  if (extra.needs !== null) {
    dispatchRows.push({ label: 'needs', value: extra.needs.length ? extra.needs.join(', ') : 'nothing — this is a root milestone' })
  }
  dispatchRows.push({ label: 'verifier', value: child?.verifier ? child.verifier : 'none declared' })

  // A dispatched child reads its own next-stage CTA (in practice never live
  // once dispatched); an undispatched milestone reads the readiness the
  // caller computed, and stages against the slug its child will get.
  const devSlug = child?.slug ?? extra.milestoneSlug
  const isLive = child ? isNextStage(child, 'dev') : !!extra.readyForDev

  return (
    <>
      <PanelHeader stageId="dev" child={child} />
      <PanelBody>
        <div className="milestone-dispatch" data-testid="milestone-dispatch">
          <div className="milestone-dispatch-label" data-testid="milestone-dispatch-label">{extra.stateLabel}</div>
          {dispatchRows.map((row) => (
            <div key={row.label} className="milestone-dispatch-row" data-testid="milestone-dispatch-row">
              <span>{row.label}</span><span>{row.value}</span>
            </div>
          ))}
        </div>
      </PanelBody>
      <PanelFooter
        primary={<StageCtaButton label="Start Dev" stage="dev" slug={devSlug ?? ''} isLive={isLive && devSlug !== undefined} />}
        secondaries={child && (
          <>
            <FocusButton slug={child.slug} status={child.status} attentionStatus={child.attentionStatus} />
            {child.worktree && <ActionButton action="vscode" slug={child.slug} label="VS Code" testId="vscode-btn" />}
            {child.devUrl && <ActionButton action="browse" slug={child.slug} label="Browse App" testId="browse-btn" />}
          </>
        )}
      />
    </>
  )
}

export function CrStage({ child }: StageBodyProps) {
  const { selectStageTab } = useTaskDetailNav()
  if (!child) return <UndispatchedStage stageId="cr" />

  return (
    <>
      <PanelHeader stageId="cr" child={child} />
      <PanelBody>
        <ParseMismatchWarning mismatches={child.findingsParseMismatch} testId="cr-parse-mismatch-warning" />
        {child.findings.length
          ? <FindingsChecklist findings={child.findings} />
          : <PanelNote testId="cr-no-findings-note">No review findings recorded — code review either has not run yet or found nothing to flag.</PanelNote>}
      </PanelBody>
      <PanelFooter
        primary={<StageCtaButton label="Start Code Review" stage="code-review" slug={child.slug} isLive={isNextStage(child, 'code-review')} />}
        secondaries={(
          <>
            {findPrNumber(child) && <ActionButton action="open-pr" slug={child.slug} label="Open PR" testId="open-pr-btn" />}
            {child.findings.length > 0 && (
              // The only way to reach the interactive triage checklist before
              // a comment-fix round has left TIMELINE history for the chain to
              // route on.
              <button type="button" className="btn" data-testid="select-findings-btn" onClick={() => selectStageTab('cr-fixes')}>Select findings to fix</button>
            )}
          </>
        )}
      />
    </>
  )
}

export function CrFixesStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="cr-fixes" />
  return <CrFixesBody key={child.slug} child={child} />
}

// Split out so the triage hook only runs for a real task; keyed by slug at the
// call site so its optimistic selection never carries over to another task.
function CrFixesBody({ child }: { child: Task }) {
  const triage = useTriageSelection({ slug: child.slug, endpoint: 'triage', serverSelected: child.findings.map((f) => f.selected) })
  const isStageLive = isNextStage(child, 'comment-fix')

  return (
    <>
      <PanelHeader stageId="cr-fixes" child={child} />
      <PanelBody>
        <ParseMismatchWarning mismatches={child.findingsParseMismatch} testId="cr-parse-mismatch-warning" />
        {child.findings.length
          ? <TriageContainer slug={child.slug} endpoint="triage"><FindingsChecklist findings={child.findings} selected={triage.selected} onToggle={triage.toggle} /></TriageContainer>
          : <PanelNote testId="cr-fixes-no-findings-note">No review findings recorded yet.</PanelNote>}
      </PanelBody>
      <PanelFooter
        primary={<StageCtaButton label={`Fix ${triage.selectedCount} CR Comment${plural(triage.selectedCount)}`} stage="comment-fix" slug={child.slug} isLive={isStageLive && triage.selectedCount > 0} />}
        secondaries={<SkipButton stage="comment-fix" slug={child.slug} isLive={isStageLive} />}
      />
    </>
  )
}

export function QaStage({ child }: StageBodyProps) {
  // Only worth fetching while there is a declared spec and no real report to
  // supersede the preview, and only once the QA tab is actually on screen.
  const wantsPlannedCases = !!child && !!child.qaSpecFile && !child.qaCases.length
  const plannedTitles = useQaSpec(child?.slug ?? '', wantsPlannedCases)
  if (!child) return <UndispatchedStage stageId="qa" />

  const body: ReactNode = child.qaCases.length
    ? <QaCaseList cases={child.qaCases} />
    : child.qaSpecFile && plannedTitles?.length
      ? <PlannedQaList specFile={child.qaSpecFile} titles={plannedTitles} />
      : <PanelNote isMuted testId="qa-cases-pending-note">The editable Playwright case list arrives with the QA skill that consumes it.</PanelNote>

  return (
    <>
      <PanelHeader stageId="qa" child={child} />
      <PanelBody>
        <ParseMismatchWarning mismatches={child.qaCasesParseMismatch} testId="qa-parse-mismatch-warning" />
        {body}
      </PanelBody>
      <PanelFooter primary={<StageCtaButton label="Start QA" stage="qa" slug={child.slug} isLive={isNextStage(child, 'qa')} />} />
    </>
  )
}

export function QaFixesStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="qa-fixes" />
  return <QaFixesBody key={child.slug} child={child} />
}

function QaFixesBody({ child }: { child: Task }) {
  const triage = useTriageSelection({ slug: child.slug, endpoint: 'qa-triage', serverSelected: child.qaFailures.map((f) => f.selected) })
  const isStageLive = isNextStage(child, 'qa-fixes')

  return (
    <>
      <PanelHeader stageId="qa-fixes" child={child} />
      <PanelBody>
        {child.qaFailures.length
          ? <TriageContainer slug={child.slug} endpoint="qa-triage"><QaFailuresChecklist failures={child.qaFailures} selected={triage.selected} onToggle={triage.toggle} /></TriageContainer>
          : <PanelNote testId="qa-fixes-no-failures-note">No failing cases recorded — QA either has not run or found nothing.</PanelNote>}
      </PanelBody>
      <PanelFooter
        primary={<StageCtaButton label={`Fix ${triage.selectedCount} QA Comment${plural(triage.selectedCount)}`} stage="qa-fixes" slug={child.slug} isLive={isStageLive && triage.selectedCount > 0} />}
        secondaries={<SkipButton stage="qa-fixes" slug={child.slug} isLive={isStageLive} />}
      />
    </>
  )
}

// Merge is gated (a real preflight check) and completes the task on success,
// but deliberately has no staged CTA: the button already merges in one click,
// in-process. Failures persist in a banner rather than a button flash — a
// multi-line blocker list does not fit a label, and a flash on a button a
// re-render replaces would be lost. Merge is the primary when a PR exists;
// otherwise Mark done is, since Merge has nothing to act on.
export function MergeStage({ child, openTaskSlug }: StageBodyProps) {
  useClientState()
  if (!child) return <UndispatchedStage stageId="merge" />

  const hasPr = !!findPrNumber(child)
  const { banner } = clientState.getMergeState(child.slug)
  // No TIMELINE entry for this stage yet is different from "not dispatched":
  // a real child exists, it just has not reached Merge.
  const hasHistory = !!stageNote(child, 'merge')

  return (
    <>
      <PanelHeader stageId="merge" child={child} />
      {!hasHistory && (
        <PanelBody><div className="milestone-stage-empty" data-testid="milestone-stage-empty">No merge activity recorded for this stage yet.</div></PanelBody>
      )}
      <MergeBanner banner={banner} />
      {hasPr
        ? (
          <PanelFooter
            primary={<MergeButton task={child} openTaskSlug={openTaskSlug} />}
            secondaries={(
              <>
                <ActionButton action="open-pr" slug={child.slug} label="Open PR" testId="open-pr-btn" />
                <MarkDoneButton child={child} openTaskSlug={openTaskSlug} isPrimary={false} />
              </>
            )}
          />
        )
        : <PanelFooter primary={<MarkDoneButton child={child} openTaskSlug={openTaskSlug} isPrimary />} />}
    </>
  )
}
