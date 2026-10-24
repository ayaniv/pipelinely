import type { Task } from '../../../../../src/types'
import { clientState, useClientState } from '../../../data/clientState'
import { useSnapshot } from '../../../data/snapshot'
import { milestoneChildSlug } from '../../../milestoneModel'
import { nextWaveAction, nextWaveButtonState, nextWaveTarget, runNextWave } from '../../../nextWave'
import { wavePanelMeta } from '../../../wavePanelMeta'
import { LazyWaveGraph } from '../graph/GraphSlot'
import { PanelNote } from './PanelLayout'

// A fan-out parent's Dev body (REQUEST-v4.md §4): a header with the stage's
// name, where its waves stand and the one Run next wave button, over the wave
// graph. It sits under the chart with neither the status pill nor the footer
// the other stages' cards carry.

// A batch records one outcome for every milestone it stages, so the first of
// the target wave's milestones with one speaks for the run. Only that wave's:
// an outcome recorded for some other milestone is not this button's.
function waveDispatchOutcome(task: Task, wave: number | undefined) {
  for (const milestone of task.milestones ?? []) {
    if (milestone.wave !== wave) continue
    const status = clientState.getDispatchStatus(milestoneChildSlug(task.slug, milestone.id))
    if (status) return status
  }
  return null
}

function RunNextWaveButton({ task }: { task: Task }) {
  const { data } = useSnapshot()
  // Re-renders the button when a wave batch starts or settles.
  useClientState()
  const action = nextWaveAction(task)
  const { isDisabled, title } = nextWaveButtonState(task.slug, action, data?.isCanonical ?? false)
  return (
    <button
      type="button"
      className="btn run-next-wave-btn"
      data-testid="run-next-wave-btn"
      data-wave={nextWaveTarget(action)}
      disabled={isDisabled}
      title={title}
      onClick={() => { void runNextWave(task) }}
    >
      <svg data-testid="run-next-wave-icon" width="10" height="10" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><path d="M7 5l12 7-12 7V5z" /></svg>
      <span>Run next wave</span>
    </button>
  )
}

export function WavePanel({ task }: { task: Task }) {
  useClientState()
  if (!(task.milestones ?? []).length) return <PanelNote testId="wave-panel-empty-note">This project has no milestones declared in its plan yet.</PanelNote>

  const outcome = waveDispatchOutcome(task, nextWaveTarget(nextWaveAction(task)))
  return (
    <div className="wave-panel" data-testid="wave-panel">
      <div className="wave-panel-header" data-testid="wave-panel-header">
        <div className="wave-panel-heading">
          <span className="wave-panel-title" data-testid="wave-panel-title">Dev</span>
          <span className="wave-panel-meta" data-testid="wave-panel-meta">{wavePanelMeta(task)}</span>
        </div>
        <RunNextWaveButton task={task} />
      </div>
      {outcome && <div className={`run-next-wave-status ${outcome.ok ? 'btn-ok' : 'btn-err'}`} data-testid="run-next-wave-status" data-ok={outcome.ok ? 'true' : 'false'} title={outcome.detail}>{outcome.label}</div>}
      <LazyWaveGraph task={task} />
    </div>
  )
}
