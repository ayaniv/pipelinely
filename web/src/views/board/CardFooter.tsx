import type { Task } from '../../../../src/types'
import { postAction, postStageSkill, type PostActionOptions } from '../../api/actions'
import { CtaArrowIcon } from '../../components/icons'
import { MergeBanner } from '../../components/MergeBanner'
import { useActionFlash } from '../../components/useActionFlash'
import { mergeTask, type MergeOutcome } from '../../api/mergeTask'
import { autoSubmitStore } from '../../data/autoSubmit'
import { clientState, useClientState } from '../../data/clientState'
import { navigateToTask } from '../../shell/appNavigation'
import { CARD_CTA_LABEL, READ_RESULT_LABEL, SEE_DETAILS_LABEL, TRIAGE_CR_COMMENTS_LABEL, isCardMergeReady } from '../../nextStage'
import { computeNextStageCta, isCrFixSelectionMissing, isReadyForResultReview } from '../../../../src/nextStageCta'
import { RESULT_TAB_ID } from '../../resultTab'
import { isFanoutParent } from '../../taskScope'

// The design's footer: ONE CTA per card.
// Plain text labels (not SVGs) so a flash's revert can't eat an icon on the
// way back from "✓ staged". Three shapes: a dispatchable next stage, the
// merge trio for a merge-ready card, and "See details" for a card with no
// single next step.

export interface CardFooterProps extends Partial<PostActionOptions> {
  task: Task
  onOpenDetail?: (slug: string) => void
  onOpenResult?: (slug: string) => void
  isAutoSubmitEnabled?: () => boolean
  // Merge state (in-flight, the persistent failure banner) and the merge
  // action are shared with the Merge tab — see data/clientState.ts and
  // api/mergeTask.ts; injectable for tests.
  readMergeState?: typeof clientState.getMergeState
  merge?: (task: Task) => Promise<MergeOutcome>
}

interface FooterDeps extends PostActionOptions {
  isPrimary: boolean
}

function StageCtaButton({ task, stage, isPrimary, fetchImpl, log, isAutoSubmitEnabled }: FooterDeps & { task: Task; stage: keyof typeof CARD_CTA_LABEL; isAutoSubmitEnabled: () => boolean }) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    const result = await postStageSkill(task.slug, stage, isAutoSubmitEnabled(), { fetchImpl, log })
    showOutcome(result)
  })
  return (
    <button
      type="button"
      className={`btn${isPrimary ? ' btn-primary' : ''} ${flash.className}`.trim()}
      data-action="stage-skill"
      data-slug={task.slug}
      data-stage={stage}
      data-testid="card-cta-btn"
      data-primary={String(isPrimary)}
      disabled={isPending}
      onClick={handleClick}
    >
      {flash.label ?? `${CARD_CTA_LABEL[stage] ?? 'Continue'} →`}
    </button>
  )
}

function OpenPrButton({ slug, fetchImpl, log }: PostActionOptions & { slug: string }) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    const result = await postAction('open-pr', slug, { fetchImpl, log })
    showOutcome(result)
  })
  return (
    <button type="button" className={`btn ${flash.className}`.trim()} data-action="open-pr" data-slug={slug} data-testid="card-open-pr-btn" disabled={isPending} onClick={handleClick}>
      {flash.label ?? 'Open PR'}
    </button>
  )
}

function MergeFooter({ task, isPrimary, fetchImpl, log, readMergeState, merge }: FooterDeps & { task: Task; readMergeState: typeof clientState.getMergeState; merge: (task: Task) => Promise<MergeOutcome> }) {
  // Re-read on every render; subscribing re-renders this whenever a merge
  // starts or settles.
  useClientState()
  const { isInFlight, banner } = readMergeState(task.slug)
  const handleClick = () => {
    merge(task).catch((err: unknown) => log(`[action] merge of ${task.slug} failed`, err))
  }
  return (
    <div className="card-footer card-footer-merge">
      <MergeBanner banner={banner} />
      <button
        type="button"
        className={`btn${isPrimary ? ' btn-primary' : ''}`}
        data-action="merge-pr"
        data-slug={task.slug}
        data-testid="card-merge-pr-btn"
        data-primary={String(isPrimary)}
        disabled={isInFlight}
        onClick={handleClick}
      >
        <span>Merge</span>
        <CtaArrowIcon />
      </button>
      <OpenPrButton slug={task.slug} fetchImpl={fetchImpl} log={log} />
    </div>
  )
}

const openTaskResult = (slug: string) => navigateToTask(slug, { stage: RESULT_TAB_ID })

export function CardFooter({
  task,
  onOpenDetail = navigateToTask,
  onOpenResult = openTaskResult,
  isAutoSubmitEnabled = autoSubmitStore.isEnabled,
  readMergeState = clientState.getMergeState,
  merge = mergeTask,
  fetchImpl = fetch,
  log = console.error,
}: CardFooterProps) {
  // The same "wants you" signal the header's terminal button uses — one
  // accent-tinted button per card, never two, whichever shape renders.
  const isPrimary = task.attentionStatus === 'needs-you' || task.attentionStatus === 'paused'
  // A milestone-declaring parent gets neither action branch: dev is
  // dispatched per milestone, and a parent's own PR is not what its
  // milestones merge through. "See details" is the one honest answer for a
  // card with no single next step.
  const isParent = isFanoutParent(task)
  const cta = isParent ? null : computeNextStageCta(task)

  const shouldTriageFirst = !!cta && isCrFixSelectionMissing(task, cta.stage)

  if (cta && !shouldTriageFirst) {
    return (
      <div className="card-footer">
        <StageCtaButton task={task} stage={cta.stage} isPrimary={isPrimary} fetchImpl={fetchImpl} log={log} isAutoSubmitEnabled={isAutoSubmitEnabled} />
      </div>
    )
  }
  // After the CTA branch and before the fallback on purpose: a waiting
  // reason that names a stage wins when both are satisfiable, and a
  // merge-ready task otherwise falls straight through to "See details".
  if (!isParent && isCardMergeReady(task)) {
    return <MergeFooter task={task} isPrimary={isPrimary} fetchImpl={fetchImpl} log={log} readMergeState={readMergeState} merge={merge} />
  }
  // Last, after every stage CTA and the merge footer: a research deliverable
  // awaiting review is only the answer when nothing in the pipeline is.
  if (!isParent && !!task.resultDoc && isReadyForResultReview(task)) {
    return (
      <div className="card-footer">
        <button
          type="button"
          className={`btn${isPrimary ? ' btn-primary' : ''}`}
          data-action="open-result"
          data-slug={task.slug}
          data-testid="card-cta-btn"
          data-primary={String(isPrimary)}
          onClick={() => onOpenResult(task.slug)}
        >
          {READ_RESULT_LABEL} →
        </button>
      </div>
    )
  }
  return (
    <div className="card-footer">
      <button
        type="button"
        className={`btn${isPrimary ? ' btn-primary' : ''}`}
        data-action="open-detail"
        data-slug={task.slug}
        data-testid="card-cta-btn"
        data-primary={String(isPrimary)}
        onClick={() => onOpenDetail(task.slug)}
      >
        {shouldTriageFirst ? TRIAGE_CR_COMMENTS_LABEL : SEE_DETAILS_LABEL} →
      </button>
    </div>
  )
}
