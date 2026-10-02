import { FrameSlot } from '../../components/FrameSlot'
import { useSnapshot } from '../../data/snapshot'

// Shown while this dashboard instance is not the canonical one (a worktree's
// own preview, an e2e webServer), whose dispatch actions are disabled. Waits
// for the first snapshot rather than assuming: it stays hidden
// until a snapshot says otherwise, and a banner that flashes on a canonical
// instance's first paint would be a false alarm.
export function ReadOnlyBanner() {
  const { data } = useSnapshot()
  const isReadOnly = data !== undefined && !data.isCanonical
  return (
    <FrameSlot containerId="read-only-banner-slot">
      {isReadOnly && (
        <div className="read-only-banner" id="read-only-banner" data-testid="read-only-banner">
          ⚠ Read-only — this is not the canonical dashboard instance, so dispatch actions are disabled here.
        </div>
      )}
    </FrameSlot>
  )
}
