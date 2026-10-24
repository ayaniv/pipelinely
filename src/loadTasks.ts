import {
  attachPrMergeStates,
  attachResolvedPrNumbers,
  type PrMergeStateCache,
  type PrMergeStateLookup,
  type PrNumberCache,
  type PrNumberLookup,
} from './prLookup.js'
import { parseAllTasks } from './taskParser.js'
import type { ApprovalPrompt } from './approvalPrompt.js'
import type { Settings, Task } from './types.js'

export interface TaskLookups {
  lookUpPrNumber: PrNumberLookup
  lookUpPrMergeState: PrMergeStateLookup
  prNumberCache: PrNumberCache
  prMergeStateCache: PrMergeStateCache
}

// The one pipeline from the tasks dir to tasks with a resolved PR number and
// merge state, shared by the server's refreshTasks and the babysit CLI so the
// two cannot read a task differently. The caches are the caller's: the server
// keeps them for its 60-second window, a CLI sweep passes fresh ones so it
// never acts on a merge state an earlier merge has since changed.
export async function loadTasks(
  tasksDir: string,
  settings: Settings,
  lookups: TaskLookups,
  approvalPrompts: Map<string, ApprovalPrompt> = new Map(),
): Promise<Task[]> {
  const parsedTasks = await parseAllTasks(tasksDir, settings, approvalPrompts)
  const withPrNumbers = await attachResolvedPrNumbers(parsedTasks, lookups.lookUpPrNumber, lookups.prNumberCache)
  return attachPrMergeStates(withPrNumbers, lookups.lookUpPrMergeState, lookups.prMergeStateCache)
}
