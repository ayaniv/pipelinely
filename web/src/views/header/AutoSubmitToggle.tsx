import { autoSubmitStore, useAutoSubmit } from '../../data/autoSubmit'

// Remote-only: on the desktop this button is never rendered at all, so the
// header is byte-for-byte the one that shipped before this feature — nothing
// to un-hide, and no flash of a control the desktop is never meant to offer.
export function AutoSubmitToggle() {
  const { isRemoteAccess, isChoiceOn } = useAutoSubmit()
  if (!isRemoteAccess) return null
  return (
    <button
      type="button"
      className="theme-toggle"
      id="auto-submit-toggle"
      data-testid="auto-submit-toggle"
      aria-label="Auto-submit stage commands (remote access)"
      aria-pressed={isChoiceOn}
      onClick={autoSubmitStore.toggleChoice}
    >
      ⏎
    </button>
  )
}
