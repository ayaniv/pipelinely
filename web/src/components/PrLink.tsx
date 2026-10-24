import type { MouseEvent } from 'react'
import { postAction, type PostActionOptions } from '../api/actions'
import { GithubIcon } from './icons'
import { useActionFlash } from './useActionFlash'

// The `#<n>` link on a card's project/branch row. Nothing in this repo knows a
// project's GitHub owner, so it opens the PR through the existing open-pr
// action (`gh pr view --web`) instead of building a URL — which opens the
// browser on the machine running the dashboard, not on a phone. Renders only
// when the task has a PR.

export interface PrLinkProps extends Partial<PostActionOptions> {
  slug: string
  prNumber: string | null
}

export function PrLink({ slug, prNumber, fetchImpl = fetch, log = console.error }: PrLinkProps) {
  const { flash, showOutcome, isPending, run } = useActionFlash()
  if (!prNumber) return null

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    // The link is not a way into the card.
    event.stopPropagation()
    return run(async () => {
      const result = await postAction('open-pr', slug, { fetchImpl, log })
      showOutcome(result)
    })
  }

  return (
    <button
      type="button"
      className={`card-pr-link ${flash.className}`.trim()}
      data-testid="card-pr-link"
      data-pr={prNumber}
      title="Open the pull request"
      disabled={isPending}
      onClick={handleClick}
    >
      <GithubIcon />
      <span>{flash.label ?? `#${prNumber}`}</span>
    </button>
  )
}
