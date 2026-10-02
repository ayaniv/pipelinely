import type { ActionOutcome, PostActionOptions } from '../api/actions'
import { useActionFlash } from './useActionFlash'

// What it stages a handover FOR
// (one task, or the orchestrator's own session in the header) is the
// caller's to say via `send`, so this stays one component for both — each
// caller passes the typed action from api/actions.ts, whose staging
// contract (✓ staged / reattached / server message) is the same for both.

export interface HandoverPillProps extends Partial<PostActionOptions> {
  testId: string
  send: (options: PostActionOptions) => Promise<ActionOutcome>
  // Only the board's session card sets these: the attributes are the hook its
  // specs (and anything styling off them) read the pill by.
  dataAttrs?: { action: string; slug: string }
}

export function HandoverPill({ testId, send, dataAttrs, fetchImpl = fetch, log = console.error }: HandoverPillProps) {
  const { flash, showOutcome, isPending, run } = useActionFlash()

  const handleClick = () => run(async () => {
    const result = await send({ fetchImpl, log })
    showOutcome(result)
  })

  return (
    <button type="button" className={`card-handover-pill ${flash.className}`.trim()} data-testid={testId} data-action={dataAttrs?.action} data-slug={dataAttrs?.slug} disabled={isPending} onClick={handleClick}>
      {flash.label ?? 'Handover'}
    </button>
  )
}
