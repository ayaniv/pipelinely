import fs from 'node:fs/promises'
import { resolveTaskDirArg } from './batchDispatch.js'
import { computeMilestones, parseMilestonesContent, parseTask } from './taskParser.js'
import { isMilestoneReadyForDev } from './nextStageCta.js'
import type { MilestoneStatus, StageEvent, Task } from './types.js'

export interface MilestoneRow {
  id: string
  name: string
  state: MilestoneStatus['state']
  isDispatchableNow: boolean
}

export type DevGuardOutcome =
  | { kind: 'dispatchable' }
  | { kind: 'milestone-parent'; milestones: MilestoneRow[] }

export interface DevGuardReport {
  exitCode: 0 | 2
  lines: string[]
}

// parseTask reads a missing dir as a `working` task (a missing STATUS defaults
// to it), so a milestone that was never dispatched must be filtered out here,
// or it would show as dispatched.
async function parseExistingTask(taskDir: string): Promise<Task | null> {
  try {
    await fs.access(taskDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return parseTask(taskDir)
}

async function readTechDesign(taskDir: string): Promise<string | null> {
  try {
    return await fs.readFile(`${taskDir}/tech-design.md`, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

// Same readiness rule the dashboard's Start Dev button applies (plan-reviewed
// parent, every needed milestone done), so the guard never calls a milestone
// dispatchable while the button is disabled.
function toRows(milestones: MilestoneStatus[], parentStageHistory: StageEvent[]): MilestoneRow[] {
  const byId = new Map(milestones.map((m) => [m.id, m]))
  return milestones.map((m) => ({
    id: m.id,
    name: m.name,
    state: m.state,
    isDispatchableNow: isMilestoneReadyForDev(m, byId, parentStageHistory),
  }))
}

// Whether `/pipelinely-dev <slug>` may go ahead. Refuses only a slug whose own
// tech-design.md declares `## Milestones` — running dev on that would treat the
// whole multi-milestone plan as one flat task, in the parent's stale worktree.
// Everything else (flat task, brand-new slug, a milestone child, a missing or
// unparseable plan) goes ahead: with no declared milestone there is nothing to
// refuse over. Throws on an unsafe slug or an unreadable file, so the CLI can
// tell "something broke" apart from "refused".
export async function checkDevTarget(tasksDir: string, slug: string): Promise<DevGuardOutcome> {
  const taskDir = resolveTaskDirArg(tasksDir, slug)
  const techDesign = await readTechDesign(taskDir)
  const declarations = techDesign ? parseMilestonesContent(techDesign) : []
  if (declarations.length === 0) return { kind: 'dispatchable' }

  const parent = await parseTask(taskDir)
  const children = await Promise.all(
    declarations.map((decl) => parseExistingTask(resolveTaskDirArg(tasksDir, `${slug}-m${decl.id.slice(1)}`))),
  )
  const dispatched = children.filter((child): child is Task => child !== null)
  return { kind: 'milestone-parent', milestones: toRows(computeMilestones(declarations, slug, dispatched), parent?.stageHistory ?? []) }
}

export function describeDevGuardOutcome(slug: string, outcome: DevGuardOutcome): DevGuardReport {
  if (outcome.kind === 'dispatchable') return { exitCode: 0, lines: [] }

  const dispatchable = outcome.milestones.filter((m) => m.isDispatchableNow)
  return {
    exitCode: 2,
    lines: [
      `Refusing: '${slug}' is a milestone parent — its tech-design.md declares ## Milestones, so dev runs per milestone, never on the parent.`,
      ...outcome.milestones.map((m) => `  ${m.id} ${m.name} — ${m.state}${m.isDispatchableNow ? ' (dispatchable now)' : ''}`),
      dispatchable.length > 0
        ? `Dispatchable now: ${dispatchable.map((m) => `/pipelinely-dev ${slug}-m${m.id.slice(1)}`).join(', ')}`
        : 'Nothing is dispatchable right now: every milestone is done, or waiting on one that is still running.',
    ],
  }
}
