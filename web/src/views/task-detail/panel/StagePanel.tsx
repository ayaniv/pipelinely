import type { Task } from '../../../../../src/types'
import type { StagePanelTabId } from '../../../pipelineStages'
import { CrFixesStage, CrStage, DevStage, MergeStage, QaFixesStage, QaStage, type StagePanelExtra } from './stageBodies'

export type { StagePanelExtra }

export interface StagePanelProps {
  tab: StagePanelTabId
  // null for a milestone that has not been dispatched yet.
  child: Task | null
  extra: StagePanelExtra
  // The task whose detail view is open, so a merge or mark-done of that same
  // task (and only that one) closes the view.
  openTaskSlug: string
}

// Level 2: one task's (or milestone's) stage body. The caller wraps it in
// the bordered .l2-panel card.
export function StagePanel({ tab, child, extra, openTaskSlug }: StagePanelProps) {
  const props = { child, extra, openTaskSlug }
  switch (tab) {
    case 'dev':
      return <DevStage {...props} />
    case 'cr':
      return <CrStage {...props} />
    case 'cr-fixes':
      return <CrFixesStage {...props} />
    case 'qa':
      return <QaStage {...props} />
    case 'qa-fixes':
      return <QaFixesStage {...props} />
    case 'merge':
      return <MergeStage {...props} />
  }
}
