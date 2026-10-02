import type { Task } from '../../../src/types'
import { clientState, type ClientState } from '../data/clientState'
import { eligibleWaveMilestones, milestoneChildSlug } from '../milestoneModel'
import type { PostActionOptions } from './actions'
import { postBatchDispatch } from './backlogActions'

// How long each milestone card shows the wave's dispatch outcome before
// reverting — a failure label is the one the developer needs time to read.
export const WAVE_STATUS_VISIBLE_MS = 5000

// One pending clear per child slug, each on its own timer. A newer run only
// restarts the clocks of the slugs it includes: a slug the newer run dropped
// keeps the older run's clock, so it can neither be wiped early by the newer
// run nor be left showing its outcome forever.
const pendingClears = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleStatusClear(slugs: string[], state: ClientState): void {
  for (const slug of slugs) {
    clearTimeout(pendingClears.get(slug))
    const timer = setTimeout(() => {
      state.clearDispatchStatuses([slug])
      pendingClears.delete(slug)
    }, WAVE_STATUS_VISIBLE_MS)
    pendingClears.set(slug, timer)
  }
}

export interface WaveBatchDeps extends Partial<PostActionOptions> {
  state?: ClientState
}

// One /batch-dispatch call for the whole wave — the wave half of the shared
// batch path (the backlog half is BacklogView's batch Run). Every eligible
// milestone shares one outcome: the batch stages, or it doesn't. Like every
// writeToOrchestrator caller it already inherits the canonical-instance gate,
// so a non-canonical dashboard's call gets a 403, never a real paste.
export async function runWaveBatch(parent: Task, wave: number, { fetchImpl = fetch, log = console.error, state = clientState }: WaveBatchDeps = {}): Promise<void> {
  if (state.isWaveRunning(parent.slug, wave)) return

  const eligible = eligibleWaveMilestones(parent.milestones ?? [], wave, parent.stageHistory)
  if (!eligible.length) return

  // In flight lives in the shared state, not on the button, so an SSE
  // re-render underneath a running batch can't erase it.
  state.setWaveRunning(parent.slug, wave, true)
  try {
    const slugs = eligible.map((milestone) => milestoneChildSlug(parent.slug, milestone.id))
    const outcome = await postBatchDispatch({ kind: 'wave', slugs }, { fetchImpl, log })
    state.setDispatchStatuses(slugs, { ok: outcome.ok, label: outcome.label, detail: outcome.detail })
    scheduleStatusClear(slugs, state)
  } finally {
    // finally, not a trailing statement: a throw anywhere above must not
    // strand the wave's button disabled forever.
    state.setWaveRunning(parent.slug, wave, false)
  }
}
