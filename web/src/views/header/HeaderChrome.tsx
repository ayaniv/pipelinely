import { FrameSlot } from '../../components/FrameSlot'
import { useSnapshot } from '../../data/snapshot'
import { activeTasksOf, sumScopeCost } from '../../taskScope'
import { AutoSubmitToggle } from './AutoSubmitToggle'
import { LivePill } from './LivePill'
import { OrchestratorPill } from './OrchestratorPill'
import { SpendPill } from './SpendPill'
import { ThemeToggle } from './ThemeToggle'

// The header's right-hand chrome, portaled into the #header-chrome container
// the app frame keeps for layout (the hamburger and the Back slot beside it
// are the frame's and the task detail's). Before the first snapshot lands nothing is known about the
// orchestrator or which instance this is, so the ctx pill and spend stay
// out (the ctx slot's own `:empty` rule hides the wrapper), the live pill and theme
// toggle never depended on data.
export function HeaderChrome() {
  const { data } = useSnapshot()
  return (
    <FrameSlot containerId="header-chrome">
      <div className="header-ctx-slot" id="header-ctx-slot">
        {data && <OrchestratorPill ctx={data.orchestratorContextPct ?? null} isCanonical={data.isCanonical} />}
      </div>
      <SpendPill spend={sumScopeCost(activeTasksOf(data?.tasks ?? []))} />
      <LivePill />
      <AutoSubmitToggle />
      <ThemeToggle />
    </FrameSlot>
  )
}
