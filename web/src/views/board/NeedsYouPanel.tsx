import type { NeedsYouItem } from '../../../../src/nextAction'
import type { OpenTask } from '../../shell/appNavigation'
import { NEEDS_YOU_LABELS } from './needsYouLabels'

// The decisions the sweep will not make for the developer. Each row opens the
// task, where the existing CTA performs the decision: the panel does no
// actions of its own.

export interface NeedsYouPanelProps {
  items: readonly NeedsYouItem[]
  onOpenTask: OpenTask
}

export function NeedsYouPanel({ items, onOpenTask }: NeedsYouPanelProps) {
  return (
    <div className="needs-you-panel" role="region" aria-label="Needs you" data-testid="needs-you-panel">
      {items.length === 0 && <p className="needs-you-empty" data-testid="needs-you-empty">Nothing needs a decision.</p>}
      {items.map(({ slug, reason }) => (
        <button
          key={slug}
          type="button"
          className="needs-you-item"
          data-testid="needs-you-item"
          data-slug={slug}
          data-reason={reason}
          onClick={() => onOpenTask(slug)}
        >
          <span className="needs-you-item-slug">{slug}</span>
          <span className="needs-you-item-reason">{NEEDS_YOU_LABELS[reason]}</span>
        </button>
      ))}
    </div>
  )
}
