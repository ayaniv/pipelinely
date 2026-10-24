import type { MouseEvent } from 'react'
import type { NextWaveButtonState } from '../../../nextWave'
import type { WaveButton } from '../../../parentModel'

// The parent row's one action. Both variants sit in a slot that swallows the
// click, so neither a Run nor a click on the locked button ever reaches the
// row's own toggle (a disabled button's click still lands on its wrapper).

const stopRowToggle = (event: MouseEvent<HTMLElement>) => event.stopPropagation()

function PlayIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5l12 7-12 7V5z" /></svg>
  )
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

export interface ParentWaveButtonProps {
  button: Exclude<WaveButton, { kind: 'none' }>
  // From nextWaveButtonState: disabled while staging, off the canonical
  // instance, or when no milestone of the wave would be dispatched.
  runState: NextWaveButtonState
  onRun: (wave: number) => void
}

export function ParentWaveButton({ button, runState, onRun }: ParentWaveButtonProps) {
  if (button.kind === 'locked') {
    return (
      <span className="parent-wave-btn-slot" data-testid="parent-wave-btn-slot" onClick={stopRowToggle}>
        <button type="button" className="parent-wave-btn is-locked" data-testid="parent-wave-btn" data-kind="locked" disabled title={button.tooltip}>
          <LockIcon />
          <span>Wave {button.wave}</span>
        </button>
      </span>
    )
  }
  return (
    <span className="parent-wave-btn-slot" data-testid="parent-wave-btn-slot" onClick={stopRowToggle}>
      <button
        type="button"
        className="parent-wave-btn is-run"
        data-testid="parent-wave-btn"
        data-kind="run"
        disabled={runState.isDisabled}
        title={runState.title}
        onClick={() => onRun(button.wave)}
      >
        <PlayIcon />
        <span>Run wave {button.wave}</span>
      </button>
    </span>
  )
}
