import type { Task } from '../../../../../src/types'
import { L1_TABS, type L1TabId } from '../../../pipelineStages'
import { useTaskDetailNav } from '../detailNav'

// Level 1 of a fan-out parent's drill-down: Plan | Plan Review | Dev. Plan
// and Plan Review are not a one-way gate — the review can send the plan back
// — so each carries a ROUND COUNTER rather than a checkmark.
export function L1Tabs({ task, activeTab }: { task: Task; activeTab: L1TabId }) {
  const { selectL1Tab } = useTaskDetailNav()
  return (
    <nav className="l1-tabs" data-testid="l1-tabs">
      {L1_TABS.map((tab) => {
        const rounds = task.stageHistory.filter((e) => e.stage === tab.stage).length
        return (
          <button
            key={tab.id}
            type="button"
            className={`l1-tab${activeTab === tab.id ? ' is-active' : ''}`}
            data-testid={`l1-tab-${tab.id}`}
            onClick={() => selectL1Tab(tab.id)}
          >
            {tab.label}
            {rounds > 0 && <span className="l1-round" data-testid={`l1-round-${tab.id}`}>&times;{rounds}</span>}
          </button>
        )
      })}
    </nav>
  )
}
