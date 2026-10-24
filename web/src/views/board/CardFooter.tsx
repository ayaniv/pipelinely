import type { Stage, Task } from '../../../../src/types'
import { postAction, postStageSkill, type PostActionOptions } from '../../api/actions'
import { CtaArrowIcon, GithubIcon, ReadPlanIcon, TriageCommentsIcon } from '../../components/icons'
import { MergeBanner } from '../../components/MergeBanner'
import { useActionFlash } from '../../components/useActionFlash'
import { mergeTask, type MergeOutcome } from '../../api/mergeTask'
import { autoSubmitStore } from '../../data/autoSubmit'
import { clientState, useClientState } from '../../data/clientState'
import { navigateToTask, type OpenTask } from '../../shell/appNavigation'
import { OPEN_PR_LABEL, READ_PLAN_LABEL, TRIAGE_COMMENTS_LABEL } from '../../nextStage'
import { RESULT_TAB_ID } from '../../resultTab'
import { nextStepCtaPair, primaryCtaLabel, type CardPrimaryCta, type CardSecondaryCta } from '../../stageView'

// The design's footer: a Needs-you card's one or two buttons, chosen by
// `nextStepCtaPair` and split 50/50 when there are two. Plain text labels (not
// SVGs) so a flash's revert can't eat an icon on the way back from "✓ staged".

// The same next-step buttons render in two places: the card's footer and the
// table's Next column. Only the testids, the secondary's look and the wrapper
// differ.
export type CtaVariant = 'card' | 'row'

interface VariantMeta {
  container: string
  containerTestId: string
  primaryTestId: string
  mergeTestId: string
  secondaryTestId: string
  openPrTestId: string
  // The row shows its secondaries as text links, the card as outlined buttons with icons.
  secondaryClass: string
  hasSecondaryIcons: boolean
}

const VARIANT_META: Record<CtaVariant, VariantMeta> = {
  card: { container: 'card-footer', containerTestId: 'card-footer', primaryTestId: 'card-cta-btn', mergeTestId: 'card-merge-pr-btn', secondaryTestId: 'card-cta-secondary', openPrTestId: 'card-open-pr-btn', secondaryClass: 'btn', hasSecondaryIcons: true },
  row: { container: 'row-cta', containerTestId: 'row-cta', primaryTestId: 'row-cta-btn', mergeTestId: 'row-cta-btn', secondaryTestId: 'row-cta-link', openPrTestId: 'row-cta-link', secondaryClass: 'row-cta-link', hasSecondaryIcons: false },
}

export interface CardFooterProps extends Partial<PostActionOptions> {
  task: Task
  variant?: CtaVariant
  onOpenDetail?: OpenTask
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
  meta: VariantMeta
}

const btnClass = (isPrimary: boolean, extra = '') => `btn${isPrimary ? ' btn-primary' : ''} ${extra}`.trim()

function StageCtaButton({ task, stage, isPrimary, meta, fetchImpl, log, isAutoSubmitEnabled }: FooterDeps & { task: Task; stage: Stage; isAutoSubmitEnabled: () => boolean }) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    const result = await postStageSkill(task.slug, stage, isAutoSubmitEnabled(), { fetchImpl, log })
    showOutcome(result)
  })
  return (
    <button
      type="button"
      className={btnClass(isPrimary, flash.className)}
      data-action="stage-skill"
      data-slug={task.slug}
      data-stage={stage}
      data-testid={meta.primaryTestId}
      data-primary={String(isPrimary)}
      disabled={isPending}
      onClick={handleClick}
    >
      {flash.label ?? `${primaryCtaLabel({ kind: 'stage-skill', stage })} →`}
    </button>
  )
}

function OpenPrButton({ slug, meta, fetchImpl, log }: PostActionOptions & { slug: string; meta: VariantMeta }) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  const handleClick = () => run(async () => {
    const result = await postAction('open-pr', slug, { fetchImpl, log })
    showOutcome(result)
  })
  return (
    <button type="button" className={`${meta.secondaryClass} ${flash.className}`.trim()} data-action="open-pr" data-slug={slug} data-testid={meta.openPrTestId} disabled={isPending} onClick={handleClick}>
      {meta.hasSecondaryIcons && <GithubIcon />}
      <span>{flash.label ?? OPEN_PR_LABEL}</span>
    </button>
  )
}

function MergeButton({ task, isPrimary, meta, log, readMergeState, merge }: { task: Task; isPrimary: boolean; meta: VariantMeta; log: PostActionOptions['log']; readMergeState: typeof clientState.getMergeState; merge: (task: Task) => Promise<MergeOutcome> }) {
  // Re-read on every render; subscribing re-renders this whenever a merge
  // starts or settles.
  useClientState()
  const { isInFlight } = readMergeState(task.slug)
  const handleClick = () => {
    merge(task).catch((err: unknown) => log(`[action] merge of ${task.slug} failed`, err))
  }
  return (
    <button type="button" className={btnClass(isPrimary)} data-action="merge-pr" data-slug={task.slug} data-testid={meta.mergeTestId} data-primary={String(isPrimary)} disabled={isInFlight} onClick={handleClick}>
      <span>Merge</span>
      <CtaArrowIcon />
    </button>
  )
}

function MergeBannerRow({ slug, readMergeState }: { slug: string; readMergeState: typeof clientState.getMergeState }) {
  useClientState()
  return <MergeBanner banner={readMergeState(slug).banner} />
}

// The outlined companion button: never the footer's primary.
function SecondaryButton({ task, cta, meta, onOpenDetail }: { task: Task; cta: Exclude<CardSecondaryCta, { kind: 'open-pr' }>; meta: VariantMeta; onOpenDetail: OpenTask }) {
  const isReadPlan = cta.kind === 'read-plan'
  return (
    <button type="button" className={meta.secondaryClass} data-action={cta.kind} data-slug={task.slug} data-testid={meta.secondaryTestId} onClick={() => onOpenDetail(task.slug, { stage: cta.taskStage })}>
      {meta.hasSecondaryIcons && (isReadPlan ? <ReadPlanIcon /> : <TriageCommentsIcon />)}
      <span>{isReadPlan ? READ_PLAN_LABEL : TRIAGE_COMMENTS_LABEL}</span>
    </button>
  )
}

const openTaskResult = (slug: string) => navigateToTask(slug, { stage: RESULT_TAB_ID })

export function CardFooter({
  task,
  variant = 'card',
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
  const meta = VARIANT_META[variant]
  const isPrimary = task.attentionStatus === 'needs-you' || task.attentionStatus === 'paused'
  const { primary, secondary } = nextStepCtaPair(task)

  const renderPrimary = (cta: CardPrimaryCta) => {
    switch (cta.kind) {
      case 'stage-skill':
        return <StageCtaButton task={task} stage={cta.stage} isPrimary={isPrimary} meta={meta} fetchImpl={fetchImpl} log={log} isAutoSubmitEnabled={isAutoSubmitEnabled} />
      case 'merge':
        return <MergeButton task={task} isPrimary={isPrimary} meta={meta} log={log} readMergeState={readMergeState} merge={merge} />
      case 'open-result':
        return <ActionButton meta={meta} task={task} action="open-result" label={`${primaryCtaLabel(cta)} →`} isPrimary={isPrimary} onClick={() => onOpenResult(task.slug)} />
      case 'triage-first':
        return <ActionButton meta={meta} task={task} action="open-detail" label={`${primaryCtaLabel(cta)} →`} isPrimary={isPrimary} onClick={() => onOpenDetail(task.slug)} />
      case 'open-detail':
        // The outlined fallback: with no next step, opening the task is not the
        // thing the card is asking you to do.
        return <ActionButton meta={meta} task={task} action="open-detail" label={`${primaryCtaLabel(cta)} →`} isPrimary={false} onClick={() => onOpenDetail(task.slug)} />
    }
  }

  const renderSecondary = (cta: CardSecondaryCta) =>
    cta.kind === 'open-pr' ? <OpenPrButton slug={task.slug} meta={meta} fetchImpl={fetchImpl} log={log} /> : <SecondaryButton task={task} cta={cta} meta={meta} onOpenDetail={onOpenDetail} />

  const isMerge = primary.kind === 'merge'
  return (
    <div className={`${meta.container}${isMerge ? ` ${meta.container}-merge` : ''}`} data-testid={meta.containerTestId}>
      {isMerge && <MergeBannerRow slug={task.slug} readMergeState={readMergeState} />}
      {renderPrimary(primary)}
      {secondary && renderSecondary(secondary)}
    </div>
  )
}

function ActionButton({ task, meta, action, label, isPrimary, onClick }: { task: Task; meta: VariantMeta; action: string; label: string; isPrimary: boolean; onClick: () => void }) {
  return (
    <button type="button" className={btnClass(isPrimary)} data-action={action} data-slug={task.slug} data-testid={meta.primaryTestId} data-primary={String(isPrimary)} onClick={onClick}>
      {label}
    </button>
  )
}
