import type { MouseEvent } from 'react'
import type { DoneDateGroup, Task } from '../../../../src/types'
import { ChevronRightIcon } from '../../components/icons'
import { scopeTotals, sumScopeCost, taskScope } from '../../taskScope'
import { EmptyState } from './EmptyState'

// The Done panel. Groups already arrive most-recent-date-first, and tasks
// within a group most-recent-first (groupDoneTasksByDate in taskParser.ts) —
// rendered as-is rather than re-deriving an order on the client.
//
// The design's row tail is cost + a chevron; the completion time an earlier
// row carried has no slot in it. The full timestamp is still on the task
// detail the row links to.

const UNPRICED_COST = '—'

// A plain click opens the task through the app (no page reload), so the
// remembered board tab survives and closing the detail lands back here. The
// href stays for everything the browser should own: modified clicks, middle
// click, copy-link and a no-JS load.
function isPlainPrimaryClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

function DoneRow({ task, onOpenTask }: { task: Task; onOpenTask: (slug: string) => void }) {
  const cost = scopeTotals(taskScope(task)).cost
  return (
    <div className="done-row" data-testid="done-row" data-slug={task.slug} data-repo={task.repo}>
      <a className="done-row-link" data-testid="done-row-link" href={`/task/${encodeURIComponent(task.slug)}`}
         onClick={(event) => {
          if (!isPlainPrimaryClick(event)) return
          event.preventDefault()
          onOpenTask(task.slug)
        }}>
        <span className="done-row-check" aria-hidden="true">✓</span>
        <div className="done-row-main">
          <div className="done-row-title">{task.title}</div>
          <div className="done-row-meta"><span className="done-row-project">{task.repo}</span> / {task.slug}</div>
        </div>
        <span className="done-row-cost">{cost === null ? UNPRICED_COST : `$${cost.toFixed(2)}`}</span>
        <span className="done-row-chevron" data-testid="done-row-chevron"><ChevronRightIcon /></span>
      </a>
    </div>
  )
}

export function DoneView({ groups, onOpenTask }: { groups: DoneDateGroup[]; onOpenTask: (slug: string) => void }) {
  if (groups.length === 0) return <EmptyState />
  return (
    <>
      {groups.map((group) => (
        <div className="date-group" data-testid="done-date-group" key={group.dateKey}>
          <div className="date-group-header">
            <span className="date-group-label" data-testid="done-date-label">{group.label}</span>
            <span className="date-group-total" data-testid="done-date-total">${sumScopeCost(group.tasks).toFixed(2)}</span>
          </div>
          <div className="done-rows">
            {group.tasks.map((task) => <DoneRow task={task} onOpenTask={onOpenTask} key={task.slug} />)}
          </div>
        </div>
      ))}
    </>
  )
}
