import type { Page } from '@playwright/test'
import { openWithSnapshot, type SnapshotShape } from './snapshotStub'

// Deterministic fan-out parents for the dashboard-v4 chart specs. The fixture
// parents (wave-batch-parent, pipeline-graph-large, fanout-parent) have real
// milestone declarations but only a done -m0 child on disk, so every other
// milestone state the charts draw (in review, working, in QA) is set here, in
// the served snapshot only — never by writing fixture files, which the `ui`
// project's parallel workers share.

export type MilestoneFixtureState = 'merged' | 'review' | 'working' | 'qa' | 'queued'

interface SnapshotTask extends Record<string, unknown> {
  slug: string
  milestones?: Array<Record<string, unknown> & { id: string; name: string }>
}

const CHILD_FIELDS: Record<Exclude<MilestoneFixtureState, 'queued'>, { status: string; stage: string | null; milestoneState: 'dispatched' | 'done' }> = {
  merged: { status: 'done', stage: null, milestoneState: 'done' },
  review: { status: 'working', stage: 'code-review', milestoneState: 'dispatched' },
  working: { status: 'working', stage: 'dev', milestoneState: 'dispatched' },
  qa: { status: 'working', stage: 'qa', milestoneState: 'dispatched' },
}

function findTask(snapshot: SnapshotShape, slug: string): SnapshotTask {
  const task = (snapshot.tasks as SnapshotTask[]).find((candidate) => candidate.slug === slug)
  if (!task) throw new Error(`fixture task ${slug} is not in the snapshot`)
  return task
}

// Puts milestone `id` of `parentSlug` into `state`. A dispatched state gets a
// child task (cloned from the parent's own record, so it carries every field
// the client reads) both on the milestone and in the snapshot's task list, so
// a click through to it lands on a real page.
export function setMilestoneState(snapshot: SnapshotShape, parentSlug: string, id: string, state: MilestoneFixtureState): void {
  const parent = findTask(snapshot, parentSlug)
  const milestone = parent.milestones?.find((candidate) => candidate.id === id)
  if (!milestone) throw new Error(`${parentSlug} declares no milestone ${id}`)
  const childSlug = `${parentSlug}-${id.toLowerCase()}`
  snapshot.tasks = (snapshot.tasks as SnapshotTask[]).filter((task) => task.slug !== childSlug)

  if (state === 'queued') {
    milestone.state = 'queued'
    milestone.task = null
    return
  }

  const fields = CHILD_FIELDS[state]
  const child: SnapshotTask = {
    ...parent,
    slug: childSlug,
    title: milestone.name,
    branch: `claude/${childSlug}`,
    status: fields.status,
    stage: fields.stage,
    stageHistory: [],
    projectBase: parentSlug,
    projectTitle: parent.title,
    milestones: undefined,
  }
  milestone.state = fields.milestoneState
  milestone.task = child
  snapshot.tasks.push(child)
}

export function setParentField(snapshot: SnapshotShape, parentSlug: string, fields: Record<string, unknown>): void {
  Object.assign(findTask(snapshot, parentSlug), fields)
}

// Opens `/task/<parentSlug>` on a snapshot with the given milestone states,
// canonical (so Run next wave is not gated off as a read-only instance) and
// with the live feed aborted (see snapshotStub.ts).
export async function openParent(
  page: Page,
  parentSlug: string,
  states: Record<string, MilestoneFixtureState> = {},
  extra: (snapshot: SnapshotShape) => void = () => {},
): Promise<SnapshotShape> {
  return openWithSnapshot(page, `/task/${parentSlug}`, (snapshot) => {
    snapshot.isCanonical = true
    for (const [id, state] of Object.entries(states)) setMilestoneState(snapshot, parentSlug, id, state)
    extra(snapshot)
  })
}
