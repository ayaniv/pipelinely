import type { ReactNode } from 'react'
import type { Stage, Task } from '../../../../../src/types'
import { computeNextStageCta, hasConflictingPr } from '../../../../../src/nextStageCta'
import { FocusButton } from '../../../components/FocusButton'
import { useQaSpec } from '../../../data/taskResources'
import { clientState, useClientState } from '../../../data/clientState'
import { useTaskDetailNav } from '../detailNav'
import { findPrNumber } from '../../../taskScope'
import { chainStageById, type ChainStageId } from '../../../pipelineStages'
import { CARD_CTA_LABEL } from '../../../nextStage'
import { FindingsChecklist, PlannedQaList, QaCaseList, QaFailuresChecklist, TriageContainer } from './Checklists'
import { MergeBanner } from '../../../components/MergeBanner'
import { ActionButton, MarkDoneButton, MergeButton, SkipButton, StageCtaButton } from './PanelButtons'
import { NotDispatchedNote, PanelBody, PanelFooter, PanelHeader, PanelNote } from './PanelLayout'
import { stageNote } from './panelHeader'
import { DesignApprovalGate, DesignQaReport } from './DesignGate'
import { useTriageSelection, type TriageSelection } from './useTriageSelection'

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
function UndispatchedStage({ stageId }: { stageId: 'cr' | 'cr-fixes' | 'qa' | 'qa-fixes' | 'merge' | 'design-qa' | 'design-approval' | 'adopt' }) {
  return (
    <>
      <PanelHeader stageId={stageId} child={null} />
      <PanelBody><NotDispatchedNote /></PanelBody>
    </>
  )
}

// The body of every design-system-only tab. Their real panels arrive with the
// milestones that dispatch them (design-qa, design-approval and adopt have
// theirs, below); until then the tab shows what TIMELINE recorded for the
// stage, so a ds task's chain never opens onto a blank panel.
export type DsStageId = Extract<ChainStageId, 'design-intake' | 'design-fixes'>

export function DsStageBody({ stageId, child }: { stageId: DsStageId; child: Task | null }) {
  const hasHistory = !!child && !!stageNote(child, chainStageById(stageId).stage)
  return (
    <div data-testid="ds-stage-body">
      <PanelHeader stageId={stageId} child={child} />
      {!hasHistory && (
        <PanelBody><div className="milestone-stage-empty" data-testid="milestone-stage-empty">No activity recorded for this stage yet.</div></PanelBody>
      )}
    </div>
  )
}

// Design QA's report and screenshots, plus the fresh-session CTA that runs it.
export function DesignQaStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="design-qa" />
  return (
    <>
      <PanelHeader stageId="design-qa" child={child} />
      <PanelBody><DesignQaReport task={child} /></PanelBody>
      <PanelFooter primary={<StageCtaButton label={CARD_CTA_LABEL['design-qa']!} stage="design-qa" slug={child.slug} isLive={isNextStage(child, 'design-qa')} />} />
    </>
  )
}

// The designer's gate: a human decision, so no StageCtaButton — the buttons
// post to /design-approval. Live only while the task waits at the gate.
export function DesignApprovalStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="design-approval" />
  return (
    <>
      <PanelHeader stageId="design-approval" child={child} />
      <DesignApprovalGate task={child} isLive={isNextStage(child, 'design-approval')} />
    </>
  )
}

// The follow-ups adopt will queue: one per app the plan names. A plan with no
// "## Affected apps" section says so, since an empty list reads as a bug.
function AffectedApps({ apps }: { apps: string[] }) {
  if (apps.length === 0) return <PanelNote testId="adopt-no-apps">The plan names no affected apps — adopt has nothing to queue.</PanelNote>
  return (
    <ul className="adopt-apps">
      {apps.map((app) => <li key={app} data-testid="adopt-app" data-app={app}>{app}</li>)}
    </ul>
  )
}

// The last ds stage: a fresh session queues one backlog item per affected app
// and marks the task done. CARD_CTA_LABEL has an entry for every stage the
// router can hand off to, adopt included, so the `!` below is safe.
export function AdoptStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="adopt" />
  return (
    <>
      <PanelHeader stageId="adopt" child={child} />
      <PanelBody><AffectedApps apps={child.affectedApps} /></PanelBody>
      <PanelFooter primary={<StageCtaButton label={CARD_CTA_LABEL.adopt!} stage="adopt" slug={child.slug} isLive={isNextStage(child, 'adopt')} />} />
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

// The CR tab and the cr-fixes tab show the same checklist: `isInteractive`
// is the only thing that varies, so both render through this one body.
function CrFindingsBody({ child, triage, isInteractive }: { child: Task; triage: TriageSelection; isInteractive: boolean }) {
  return (
    isInteractive
      ? <TriageContainer slug={child.slug} endpoint="triage"><FindingsChecklist findings={child.findings} selected={triage.selected} onToggle={triage.toggle} /></TriageContainer>
      : <FindingsChecklist findings={child.findings} />
  )
}

// The Fix N CR Comments + Skip pair, shared by both tabs that can act on the review.
function crFixActions(child: Task, triage: TriageSelection, isActionable: boolean) {
  return {
    primary: <StageCtaButton label={`Fix ${triage.selectedCount} CR Comment${plural(triage.selectedCount)}`} stage="comment-fix" slug={child.slug} isLive={isActionable && triage.selectedCount > 0} />,
    skip: <SkipButton stage="comment-fix" slug={child.slug} isLive={isActionable} />,
  }
}

export function CrStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="cr" />
  return <CrBody key={child.slug} child={child} />
}

// Split out so the triage hook only runs for a real task; keyed by slug at the
// call site so its optimistic selection never carries over to another task.
function CrBody({ child }: { child: Task }) {
  const { selectStageTab } = useTaskDetailNav()
  const triage = useTriageSelection({ slug: child.slug, endpoint: 'triage', serverSelected: child.findings.map((f) => f.selected) })
  const hasFindings = child.findings.length > 0
  // Interactive only where the button that acts on the selection is usable;
  // anything else (already fixed, done, no findings) stays the read-only recap.
  const isInteractive = hasFindings && isNextStage(child, 'comment-fix')
  const fixActions = crFixActions(child, triage, isInteractive)
  const openPrButton = findPrNumber(child) && <ActionButton action="open-pr" slug={child.slug} label="Open PR" testId="open-pr-btn" />

  return (
    <>
      <PanelHeader stageId="cr" child={child} />
      <PanelBody>
        <ParseMismatchWarning mismatches={child.findingsParseMismatch} testId="cr-parse-mismatch-warning" />
        {hasFindings
          ? <CrFindingsBody child={child} triage={triage} isInteractive={isInteractive} />
          : <PanelNote testId="cr-no-findings-note">No review findings recorded — code review either has not run yet or found nothing to flag.</PanelNote>}
      </PanelBody>
      {isInteractive ? (
        <PanelFooter primary={fixActions.primary} secondaries={<>{openPrButton}{fixActions.skip}</>} />
      ) : (
        <PanelFooter
          primary={<StageCtaButton label="Start Code Review" stage="code-review" slug={child.slug} isLive={isNextStage(child, 'code-review')} />}
          secondaries={(
            <>
              {openPrButton}
              {hasFindings && (
                // Reaches the checklist while no comment-fix action is live;
                // once it is, the CR tab's own checklist is the interactive one.
                <button type="button" className="btn" data-testid="select-findings-btn" onClick={() => selectStageTab('cr-fixes')}>Select findings to fix</button>
              )}
            </>
          )}
        />
      )}
    </>
  )
}

export function CrFixesStage({ child }: StageBodyProps) {
  if (!child) return <UndispatchedStage stageId="cr-fixes" />
  return <CrFixesBody key={child.slug} child={child} />
}

function CrFixesBody({ child }: { child: Task }) {
  const triage = useTriageSelection({ slug: child.slug, endpoint: 'triage', serverSelected: child.findings.map((f) => f.selected) })
  const fixActions = crFixActions(child, triage, isNextStage(child, 'comment-fix'))

  return (
    <>
      <PanelHeader stageId="cr-fixes" child={child} />
      <PanelBody>
        <ParseMismatchWarning mismatches={child.findingsParseMismatch} testId="cr-parse-mismatch-warning" />
        {child.findings.length
          ? <CrFindingsBody child={child} triage={triage} isInteractive />
          : <PanelNote testId="cr-fixes-no-findings-note">No review findings recorded yet.</PanelNote>}
      </PanelBody>
      <PanelFooter primary={fixActions.primary} secondaries={fixActions.skip} />
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
// otherwise Mark done is, since Merge has nothing to act on. A conflicting PR
// offers Fix conflicts in Merge's place.
export function MergeStage({ child, openTaskSlug }: StageBodyProps) {
  useClientState()
  if (!child) return <UndispatchedStage stageId="merge" />

  const hasPr = !!findPrNumber(child)
  const { banner } = clientState.getMergeState(child.slug)
  // No TIMELINE entry for this stage yet is different from "not dispatched":
  // a real child exists, it just has not reached Merge.
  const hasHistory = !!stageNote(child, 'merge')
  // A conflicting PR can't merge, so the conflict fix takes Merge's place —
  // live once the task stands at a hand-off, disabled (saying why) otherwise.
  const mergePrimary = hasConflictingPr(child)
    ? <StageCtaButton label={CARD_CTA_LABEL['merge-conflicts']!} stage="merge-conflicts" slug={child.slug} isLive={isNextStage(child, 'merge-conflicts')} testId="fix-conflicts-cta" />
    : <MergeButton task={child} openTaskSlug={openTaskSlug} />

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
            primary={mergePrimary}
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
