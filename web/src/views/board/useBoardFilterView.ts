import { useSnapshot } from '../../data/snapshot'
import { activeTasksOf, narrowByProject, partitionParents, projectOptions } from './boardModel'
import { projectFilterStore, selectionWithin, useProjectFilter, type ProjectFilterStore } from './boardFilter'

// The project filter as the board's views apply it: the snapshot, the
// projects currently on the board (what the chips offer) and the selection
// narrowed to those. The Active board, the Backlog/Done panels and the
// sidebar counts all read this one derivation, so the counts can never
// disagree with what a panel shows.
export function useBoardFilterView(store: ProjectFilterStore = projectFilterStore) {
  const { data: snapshot } = useSnapshot()
  const { selected, toggle, prune } = useProjectFilter(store)
  const activeTasks = snapshot ? activeTasksOf(snapshot.tasks) : []
  const options = snapshot ? projectOptions(activeTasks, snapshot.doneGroups, snapshot.backlog) : []
  const effectiveSelected = selectionWithin(selected, options)
  // Parents are filtered by project like any task but kept apart: they have no
  // card and no part in the Active count (see partitionParents).
  const { parents, unstartedParents, leaves } = partitionParents(narrowByProject(activeTasks, effectiveSelected, (task) => task.repo))
  return { snapshot, options, selected: effectiveSelected, visibleTasks: leaves, visibleParents: parents, visibleUnstartedParents: unstartedParents, toggle, prune }
}
