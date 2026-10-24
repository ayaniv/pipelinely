import type { MilestoneState } from '../../../parentModel'

// A milestone's state as one of exactly three 15px shapes, told apart by shape
// and not by colour: a filled circle with a tick (done), a spinning arc on a
// ring (working — in review counts), an empty ring (idle). The ring-and-arc is
// what remains under prefers-reduced-motion, where only the spin stops.

export const MILESTONE_ICON_SIZE_PX = 15

export interface MilestoneStateIconProps {
  state: MilestoneState
  // The hover title (the svg's <title>) and the accessible name, e.g. "M1 · Workspace billing model · working".
  label: string
}

function StateShape({ state }: { state: MilestoneState }) {
  switch (state) {
    case 'done':
      return (
        <>
          <circle cx="12" cy="12" r="10" fill="var(--sage)" />
          <path data-testid="milestone-icon-tick" d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )
    case 'working':
      return (
        <>
          <circle cx="12" cy="12" r="9" fill="none" stroke="var(--accentSoft)" strokeWidth="3" />
          <path className="milestone-icon-spin" data-testid="milestone-icon-arc" d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" />
        </>
      )
    case 'idle':
      return <circle className="milestone-icon-idle-ring" cx="12" cy="12" r="9.5" />
  }
}

export function MilestoneStateIcon({ state, label }: MilestoneStateIconProps) {
  return (
    <svg
      className={`milestone-icon is-${state}`}
      data-testid="milestone-icon"
      data-state={state}
      width={MILESTONE_ICON_SIZE_PX}
      height={MILESTONE_ICON_SIZE_PX}
      viewBox="0 0 24 24"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>
      <StateShape state={state} />
    </svg>
  )
}
