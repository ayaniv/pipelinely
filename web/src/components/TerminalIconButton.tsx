import { postFocus, type PostActionOptions } from '../api/actions'
import { SHORT_ERROR_FLASH_MS, useActionFlash } from './useActionFlash'
import { TerminalIcon } from './icons'

// Same POST /focus/:slug dispatch as FocusButton, rendered as an icon-only card button instead.

export interface TerminalIconButtonProps extends Partial<PostActionOptions> {
  slug: string
  status: string
  // See HandoverPill's dataAction — same outside-#root-only constraint.
  dataAction?: string
}

export function TerminalIconButton({ slug, status, dataAction, fetchImpl = fetch, log = console.error }: TerminalIconButtonProps) {
  const testId = status === 'paused' ? 'resume-btn' : 'focus-btn'
  const { flash, showOutcome, isPending, run } = useActionFlash()

  const handleClick = () => run(async () => {
    const result = await postFocus(slug, { fetchImpl, log })
    showOutcome(result, SHORT_ERROR_FLASH_MS)
  })

  return (
    <button type="button" className={`card-icon-btn ${flash.className}`.trim()} data-testid={testId} title="Open terminal" data-action={dataAction} data-slug={dataAction ? slug : undefined} disabled={isPending} onClick={handleClick}>
      {flash.label ?? <TerminalIcon />}
    </button>
  )
}
