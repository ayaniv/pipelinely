import type { ComponentType } from 'react'
import { CardsViewIcon, TableViewIcon } from '../../components/icons'
import { activeViewStore, useActiveView, type ActiveView } from '../../data/activeView'

// The two-icon segmented pill that picks the Active tab's view. The choice is
// remembered per browser (data/activeView.ts).

const OPTIONS: { view: ActiveView; label: string; Icon: ComponentType }[] = [
  { view: 'cards', label: 'Cards', Icon: CardsViewIcon },
  { view: 'table', label: 'Table', Icon: TableViewIcon },
]

export function ActiveViewSwitch() {
  const current = useActiveView()
  return (
    <div className="active-view-switch" data-testid="active-view-switch" role="group" aria-label="Active view">
      {OPTIONS.map(({ view, label, Icon }) => (
        <button
          key={view}
          type="button"
          className={`active-view-btn${current === view ? ' is-active' : ''}`}
          data-testid={`active-view-${view}`}
          aria-pressed={current === view}
          title={label}
          aria-label={label}
          onClick={() => activeViewStore.set(view)}
        >
          <Icon />
        </button>
      ))}
    </div>
  )
}
