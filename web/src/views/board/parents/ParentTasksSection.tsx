import type { CreaturePlacement, Task } from '../../../../../src/types'
import { parentOpenStore, useParentOpen } from '../../../data/parentOpen'
import type { OpenTask } from '../../../shell/appNavigation'
import { ActiveGroupHeader } from '../ActiveGroupHeader'
import { ParentRow } from './ParentRow'

// The Active tab's Parent tasks section, above Needs you in both the card and
// the table view. Hidden when no parent is in the current project filter.

const SECTION_LABEL = 'Parent tasks'

export interface ParentTasksSectionProps {
  parents: Task[]
  // runWave(parent, N): the wave runner the milestone graph's own Run wave
  // button uses (api/waveBatch.ts) — never a second copy of it.
  onRunWave: (parent: Task, wave: number) => void
  onOpenPlan: OpenTask
  creaturePlacement: CreaturePlacement
  isCanonical: boolean
}

export function ParentTasksSection({ parents, onRunWave, onOpenPlan, creaturePlacement, isCanonical }: ParentTasksSectionProps) {
  const openSlugs = useParentOpen()
  if (parents.length === 0) return null

  return (
    <div className="active-group parent-tasks-section" data-testid="parent-tasks-section">
      <ActiveGroupHeader label={SECTION_LABEL} count={parents.length} />
      <div className="parent-rows">
        {parents.map((task) => (
          <ParentRow key={task.slug} task={task} isOpen={openSlugs.has(task.slug)} onToggle={parentOpenStore.toggle} onRunWave={onRunWave} onOpenPlan={onOpenPlan} creaturePlacement={creaturePlacement} isCanonical={isCanonical} />
        ))}
      </div>
    </div>
  )
}
