import './TaskViewTabs.css'
import { useRef } from 'react'

// The task page's top-level switch between the pipeline (graph + stage panel)
// and a research task's Result document. Shown only for a task that has a
// document, so every other task's page is unchanged. It is not the L1 tab bar:
// that one is a fan-out parent's Plan | Plan Review | Dev selector, driven by
// the task detail's nav state (detailNav.tsx), and a milestone parent shows both.

export type TaskView = 'pipeline' | 'result'

// The one panel the bar controls; the page renders it under the bar.
export const TASK_VIEW_PANEL_ID = 'task-view-panel'

// A stable per-tab id, also the panel's aria-labelledby target — the panel's
// accessible name is whichever tab is currently selected.
export const taskViewTabId = (view: TaskView): string => `task-view-tab-${view}`

const VIEW_TABS: { id: TaskView; label: string }[] = [
  { id: 'pipeline', label: 'Pipeline' },
  { id: 'result', label: 'Result' },
]

const ARROW_KEYS: readonly string[] = ['ArrowLeft', 'ArrowRight']

export function TaskViewTabs({ activeView, onSelect }: { activeView: TaskView; onSelect: (view: TaskView) => void }) {
  // Both buttons stay mounted (never conditionally rendered), so a ref set on
  // first render can still be focused after onSelect's parent-state update —
  // no need to wait for the re-render that flips which one is "active".
  const tabRefs = useRef<Record<TaskView, HTMLButtonElement | null>>({ pipeline: null, result: null })

  // Two tabs, so either arrow is "the other one". Selecting a tab with the
  // keyboard must also move focus onto it — otherwise the focused button is
  // left with tabIndex=-1 and a keyboard user is stranded off the tab order.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (!ARROW_KEYS.includes(event.key)) return
    const next = activeView === 'pipeline' ? 'result' : 'pipeline'
    onSelect(next)
    tabRefs.current[next]?.focus()
  }

  return (
    <div className="task-view-tabs" role="tablist" aria-label="Task view" data-testid="task-view-tabs">
      {VIEW_TABS.map((tab) => (
        <button
          key={tab.id}
          ref={(el) => { tabRefs.current[tab.id] = el }}
          type="button"
          role="tab"
          id={taskViewTabId(tab.id)}
          aria-selected={activeView === tab.id}
          aria-controls={TASK_VIEW_PANEL_ID}
          tabIndex={activeView === tab.id ? 0 : -1}
          className={`task-view-tab${activeView === tab.id ? ' is-active' : ''}`}
          data-testid={taskViewTabId(tab.id)}
          onClick={() => onSelect(tab.id)}
          onKeyDown={handleKeyDown}
        >
          {tab.label}
        </button>
      ))}
    </div>
  )
}
