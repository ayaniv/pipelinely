import type { Stage, Task } from '../../../../../src/types'
import { postAction, postSkipStage, postStageSkill, type PostActionOptions } from '../../../api/actions'
import { CtaArrowIcon } from '../../../components/icons'
import { markTaskDone } from '../../../components/markTaskDone'
import { useActionFlash } from '../../../components/useActionFlash'
import { mergeTask } from '../../../api/mergeTask'
import { autoSubmitStore } from '../../../data/autoSubmit'
import { clientState, useClientState } from '../../../data/clientState'
import { closeTaskDetail } from '../../../shell/appNavigation'

// Every button a stage panel's footer or body carries. Each is a plain React
// handler over the typed action API (api/actions.ts) with its outcome flashed
// on the button.

const NOT_READY_TITLE = 'Not ready yet — appears once the previous stage hands off.'
const FAILURE_FLASH_MS = 5000
const CLEANUP_WARNING_FLASH_MS = 6000

type ActionDeps = Partial<PostActionOptions>

export interface StageCtaButtonProps extends ActionDeps {
  label: string
  stage: Stage
  slug: string
  isLive: boolean
  testId?: string
}

// Live when this stage is genuinely the next step; otherwise a disabled
// button that says why — one that looks live and does nothing is worse. Always
// the footer's primary.
export function StageCtaButton({ label, stage, slug, isLive, testId = 'l2-cta', fetchImpl = fetch, log = console.error }: StageCtaButtonProps) {
  const { flash, show, isPending, run } = useActionFlash()

  if (!isLive) {
    return <button type="button" className="btn" disabled data-testid={testId} title={NOT_READY_TITLE}>{label}</button>
  }

  const handleClick = () => run(async () => {
    const result = await postStageSkill(slug, stage, autoSubmitStore.isEnabled(), { fetchImpl, log })
    show(result.ok ? 'btn-ok' : 'btn-err', result.label, result.ok ? undefined : FAILURE_FLASH_MS)
  })

  return (
    <button type="button" className={`btn ${flash.className}`.trim()} data-testid={testId} disabled={isPending} onClick={handleClick}>
      {flash.label ?? (<><span>{label}</span><CtaArrowIcon /></>)}
    </button>
  )
}

export interface SkipButtonProps extends ActionDeps {
  stage: Stage
  slug: string
  isLive: boolean
}

// The qa-fixes/comment-fix escape hatch for a checklist with nothing worth
// acting on. Live under the same condition as the Fix CTA minus its
// "something selected" requirement — usable precisely when nothing is.
export function SkipButton({ stage, slug, isLive, fetchImpl = fetch, log = console.error }: SkipButtonProps) {
  const { flash, show, isPending, run } = useActionFlash()

  if (!isLive) {
    return <button type="button" className="btn" disabled data-testid="skip-cta" title={NOT_READY_TITLE}>Skip</button>
  }

  const handleClick = () => run(async () => {
    const result = await postSkipStage(slug, stage, { fetchImpl, log })
    show(result.ok ? 'btn-ok' : 'btn-err', result.label, result.ok ? undefined : FAILURE_FLASH_MS)
  })

  return (
    <button type="button" className={`btn ${flash.className}`.trim()} data-testid="skip-cta" disabled={isPending} onClick={handleClick}>
      {flash.label ?? 'Skip'}
    </button>
  )
}

export interface ActionButtonProps extends ActionDeps {
  action: string
  slug: string
  label: string
  testId?: string
  disabled?: boolean
  title?: string
}

// A bodyless POST (vscode, browse, open-pr, annotate-plan) flashed ✓ or the
// failure label.
export function ActionButton({ action, slug, label, testId, disabled, title, fetchImpl = fetch, log = console.error }: ActionButtonProps) {
  const { flash, show, isPending, run } = useActionFlash()

  const handleClick = () => run(async () => {
    const result = await postAction(action, slug, { fetchImpl, log })
    show(result.ok ? 'btn-ok' : 'btn-err', result.label)
  })

  return (
    <button type="button" className={`btn ${flash.className}`.trim()} data-testid={testId} disabled={disabled || isPending} title={title} onClick={handleClick}>
      {flash.label ?? label}
    </button>
  )
}

export interface MergeButtonProps {
  task: Task
  // The task whose detail view is open — a merge of any other task (a
  // milestone child inside a parent's drill-down) leaves the view open.
  openTaskSlug: string
}

// The in-flight flag and the persistent failure banner live in the shared
// client state (the board card's own merge footer reads the same), and this
// component re-renders whenever they change.
export function MergeButton({ task, openTaskSlug }: MergeButtonProps) {
  useClientState()
  const { isInFlight } = clientState.getMergeState(task.slug)

  const handleClick = () => {
    mergeTask(task)
      .then(({ merged, cleanupError }) => {
        // A cleanup warning is the one merged case the view stays open for,
        // so the banner gets read.
        if (merged && !cleanupError && task.slug === openTaskSlug) closeTaskDetail()
      })
      .catch((err: unknown) => console.error(`[action] merge of ${task.slug} failed`, err))
  }

  return (
    <button type="button" className="btn" data-testid="merge-pr-btn" disabled={isInFlight} onClick={handleClick}>
      <span>Merge</span><CtaArrowIcon />
    </button>
  )
}

export interface MarkDoneButtonProps extends ActionDeps {
  child: Task
  openTaskSlug: string
  // Mark done is the footer's primary when there is no PR to merge, and then
  // carries the primary CTA's arrow.
  isPrimary: boolean
}

export function MarkDoneButton({ child, openTaskSlug, isPrimary, fetchImpl = fetch, log = console.error }: MarkDoneButtonProps) {
  const { flash, show, isPending, run } = useActionFlash()

  const handleClick = () => run(async () => {
    const result = await markTaskDone(child, { fetchImpl, log })
    if (!result) return
    if (result.cleanupError) show('btn-err', result.label, CLEANUP_WARNING_FLASH_MS)
    else show(result.ok ? 'btn-ok' : 'btn-err', result.label, result.ok ? undefined : FAILURE_FLASH_MS)
    if (result.ok && child.slug === openTaskSlug) closeTaskDetail()
  })

  return (
    <button type="button" className={`btn ${flash.className}`.trim()} data-testid="mark-done-btn" disabled={isPending} onClick={handleClick}>
      {flash.label ?? (isPrimary ? (<><span>Mark done</span><CtaArrowIcon /></>) : 'Mark done')}
    </button>
  )
}
