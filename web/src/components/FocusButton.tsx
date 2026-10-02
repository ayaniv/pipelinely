import { postFocus, type PostActionOptions } from '../api/actions'
import { SHORT_ERROR_FLASH_MS, useActionFlash } from './useActionFlash'

// "Resume" only swaps
// in for a paused task — the one state where reattaching is the explicit
// thing the user asked for. data-primary marks the accent button a card
// wanting attention gets.

export interface FocusButtonProps extends Partial<PostActionOptions> {
  slug: string
  status: string
  attentionStatus: string
}

export function FocusButton({ slug, status, attentionStatus, fetchImpl = fetch, log = console.error }: FocusButtonProps) {
  const isPaused = status === 'paused'
  const label = isPaused ? '↻ Resume' : '→ Terminal'
  const testId = isPaused ? 'resume-btn' : 'focus-btn'
  const isPrimary = attentionStatus === 'needs-you' || attentionStatus === 'paused'
  const { flash, showOutcome, isPending, run } = useActionFlash()

  const handleClick = () => run(async () => {
    const result = await postFocus(slug, { fetchImpl, log })
    showOutcome(result, SHORT_ERROR_FLASH_MS)
  })

  return (
    <button
      type="button"
      className={`btn${isPrimary ? ' btn-primary' : ''} ${flash.className}`.trim()}
      data-testid={testId}
      data-primary={String(isPrimary)}
      disabled={isPending}
      onClick={handleClick}
    >
      {flash.label ?? label}
    </button>
  )
}
