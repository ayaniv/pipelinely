import { useMemo } from 'react'
import type { ActiveProjectProgress } from '../../../../src/types'
import { FrameSlot } from '../../components/FrameSlot'

// The active project's progress bar, into #global-progress. A project with
// no steps renders no bar at all rather than dividing by zero.
export function GlobalProgress({ activeProject }: { activeProject: ActiveProjectProgress | null }) {
  const isVisible = !!activeProject && activeProject.total > 0
  // Stable identity, so FrameSlot's layout effect doesn't tear the class
  // down and re-apply it on every board render.
  const classToggles = useMemo(() => ({ 'is-visible': isVisible }), [isVisible])
  return (
    <FrameSlot containerId="global-progress" classToggles={classToggles}>
      {isVisible && (
        <>
          <span className="global-progress-label" data-testid="global-progress-label">{activeProject.projectBase}</span>
          <div className="global-progress-track">
            <div className="global-progress-fill" data-testid="global-progress-fill" style={{ width: `${Math.round((activeProject.current / activeProject.total) * 100)}%` }} />
          </div>
          <span className="global-progress-ratio" data-testid="global-progress-ratio">{activeProject.current}/{activeProject.total}</span>
        </>
      )}
    </FrameSlot>
  )
}
