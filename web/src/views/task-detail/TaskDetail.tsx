import { Suspense, useEffect, useRef } from 'react'
import { useParams, useSearchParams } from 'react-router'
import type { Task } from '../../../../src/types'
import { postHandover } from '../../api/actions'
import { CardMenu } from '../../components/CardMenu'
import { CopySlugButton } from '../../components/CopySlugButton'
import { CtxMeter } from '../../components/CtxMeter'
import { DetailMetaRow } from '../../components/DetailMetaRow'
import { FocusButton } from '../../components/FocusButton'
import { FrameSlot } from '../../components/FrameSlot'
import { HandoverPill } from '../../components/HandoverPill'
import { BackArrowIcon, DesignBranchIcon } from '../../components/icons'
import { ParentLinkChip } from '../../components/ParentLinkChip'
import { clientState, useClientState } from '../../data/clientState'
import { useSnapshot } from '../../data/snapshot'
import { ctxIsHot } from '../../format'
import { RESULT_TAB_ID } from '../../resultTab'
import { closeTaskDetail, navigateToTask } from '../../shell/appNavigation'
import { detailMetaPairs, detailStatusInfo, isFanoutParent } from '../../taskScope'
import { useBodyClass } from '../../useBodyClass'
import { TaskDetailNavProvider, useTaskDetailNavState } from './detailNav'
import { GraphSlot, preloadGraphs } from './graph/GraphSlot'
import { ParentStepper } from './ParentStepper'
import { ResultTab } from './panel/ResultTab'
import { TaskDetailPanel } from './panel/TaskDetailPanel'
import { TASK_VIEW_PANEL_ID, TaskViewTabs, taskViewTabId, type TaskView } from './panel/TaskViewTabs'
import { SessionsSection } from './SessionsSection'
import { TaskAutoModeSelect } from './TaskAutoModeSelect'
import { useCloseWhenTaskGone } from './useCloseWhenTaskGone'

// The task-detail page: the frame (title, status line, ctx row, meta row,
// actions, card menu), the graph slot (stage chain, or a fan-out parent's
// milestone graph) and the panel slot (graph/GraphSlot.tsx,
// panel/TaskDetailPanel.tsx). Mounted at the 'task' shell route; renders
// nothing (letting the board show through) both before the snapshot has
// loaded and for a slug with no matching task.

// A single snapshot missing this task is not proof it's gone (see
// useCloseWhenTaskGone), so until a real navigation happens keep showing the
// last task found for THIS slug. Resets the moment the slug changes, so a
// genuine navigation to a different task never shows the previous one's stale
// data.
function useOpenTask(slug: string | undefined): { task: Task | undefined; isMissingFromSnapshot: boolean; snapshotUpdatedAt: number } {
  const { data, dataUpdatedAt } = useSnapshot()
  const foundTask = slug ? data?.tasks.find((candidate) => candidate.slug === slug) : undefined

  const lastGoodTaskRef = useRef<{ slug: string; task: Task } | null>(null)
  if (foundTask) {
    lastGoodTaskRef.current = { slug: foundTask.slug, task: foundTask }
  } else if (lastGoodTaskRef.current?.slug !== slug) {
    lastGoodTaskRef.current = null
  }
  const lastGood = lastGoodTaskRef.current
  const task = foundTask ?? (lastGood && lastGood.slug === slug ? lastGood.task : undefined)
  return { task, isMissingFromSnapshot: !foundTask && !!task, snapshotUpdatedAt: dataUpdatedAt }
}

export function TaskDetail() {
  const { slug } = useParams<{ slug: string }>()
  const { task, isMissingFromSnapshot, snapshotUpdatedAt } = useOpenTask(slug)
  useCloseWhenTaskGone(slug, isMissingFromSnapshot, snapshotUpdatedAt)
  useEffect(() => preloadGraphs(), [])

  // Keyed by slug: the tab and milestone selection belong to one task and
  // reset with it.
  return task ? <TaskDetailView key={task.slug} task={task} /> : null
}

// The header's Back pill: leaves the task entirely (a different destination
// from a milestone's own "back to milestones").
function BackPill() {
  return (
    <FrameSlot containerId="header-back-slot">
      <button type="button" className="header-pill back-pill" data-testid="detail-close" aria-label="Back" onClick={closeTaskDetail}>
        <BackArrowIcon /><span>Back</span>
      </button>
    </FrameSlot>
  )
}

function TaskDetailView({ task }: { task: Task }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const { data } = useSnapshot()
  useClientState()
  const navApi = useTaskDetailNavState(task)
  // `detail-open` is what hides the board behind this page.
  useBodyClass('detail-open')

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTaskDetail()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  const isOffFocus = clientState.isOffFocus(task.slug)
  const statusInfo = detailStatusInfo(task, isOffFocus)
  const isShelved = task.status === 'shelved'
  const isFanout = isFanoutParent(task)
  const ctx = task.contextPct ?? null
  const resultDoc = task.resultDoc ?? null
  // The Result tab shares the stage chain's ?stage= param (see resultTab.ts).
  // A link to it on a task with no document falls back to the pipeline.
  const isResultViewActive = !!resultDoc && searchParams.get('stage') === RESULT_TAB_ID
  const activeView: TaskView = isResultViewActive ? 'result' : 'pipeline'
  const pipelineView = (
    <div className="detail-fanout" data-testid="detail-fanout">
      {/* Holds graph and panel back together until the graph chunk is here — see GraphSlot. */}
      <Suspense fallback={null}>
        <TaskDetailPanel task={task} nav={navApi.nav} graph={<div data-testid="detail-graph-slot"><GraphSlot task={task} /></div>} />
      </Suspense>
    </div>
  )
  const viewBody = isResultViewActive ? <ResultTab slug={task.slug} meta={resultDoc} /> : pipelineView
  const selectView = (view: TaskView) => {
    const next = new URLSearchParams(searchParams)
    if (view === 'result') next.set('stage', RESULT_TAB_ID)
    else next.delete('stage')
    setSearchParams(next, { replace: true })
  }

  return (
    <TaskDetailNavProvider value={navApi}>
      <BackPill />
      <div id="task-detail" className="detail-overlay page-column" data-testid="task-detail">
        <div className="detail-panel">
          <div className="detail-head">
            <div className="detail-head-text">
              <div className="detail-title-row">
                <div className="detail-status-line" data-testid="detail-status-line">
                  <span className={`detail-status-dot${statusInfo.isWorking ? ' is-live' : ''}`} style={{ background: statusInfo.meta.dot }} />
                  <span className="detail-status-label" style={{ color: statusInfo.meta.fg }}>{statusInfo.meta.label.toLowerCase()}</span>
                  {statusInfo.tag && (
                    <span className="detail-tag-pill" style={{ background: statusInfo.tag.bg, color: statusInfo.tag.fg }}>{statusInfo.tag.label}</span>
                  )}
                </div>
              </div>
              <h2 id="detail-title" className="detail-title">{task.title || task.slug}</h2>
              <div className="detail-slug-row" data-testid="detail-slug-row">
                <DesignBranchIcon />
                <span className="detail-slug-value">{task.slug}</span>
                <CopySlugButton slug={task.slug} />
              </div>
              <div className="detail-parent-link-row" data-testid="detail-parent-link-row">
                <ParentLinkChip projectTitle={task.projectTitle} projectBase={task.projectBase} testId="detail-parent-link" onNavigate={navigateToTask} />
              </div>
            </div>
            <div className="detail-actions">
              {!isShelved && <FocusButton slug={task.slug} status={task.status} attentionStatus={task.attentionStatus} />}
              <div data-testid="detail-auto-mode-slot">
                <TaskAutoModeSelect task={task} isGlobalAutoMode={data?.settings?.autoMode ?? false} />
              </div>
              <CardMenu task={task} isOffFocus={isOffFocus} onToggleOffFocus={() => clientState.toggleOffFocus(task.slug)} />
            </div>
          </div>
          <div className="detail-ctx-row" data-testid="detail-ctx-row">
            {ctx !== null && (
              <>
                <CtxMeter ctx={ctx} testIds={{ track: 'detail-ctx-meter', fill: 'detail-ctx-meter-fill', pct: 'detail-ctx-value' }} />
                {ctxIsHot(ctx) && task.status !== 'done' && <HandoverPill testId="detail-handover" send={(options) => postHandover(task.slug, options)} />}
              </>
            )}
          </div>
          <div className="detail-meta" data-testid="detail-meta">
            <DetailMetaRow pairs={detailMetaPairs(task)} />
          </div>
          <div data-testid="detail-sessions-slot" className="detail-sessions">
            <SessionsSection task={task} isFanout={isFanout} />
          </div>
          {!isResultViewActive && (
            <div data-testid="detail-stepper-slot" className={`detail-stepper${isFanout ? ' is-fanout' : ''}`}>
              {isFanout && <ParentStepper task={task} />}
            </div>
          )}
          {resultDoc && <TaskViewTabs activeView={activeView} onSelect={selectView} />}
          {resultDoc ? <div role="tabpanel" id={TASK_VIEW_PANEL_ID} aria-labelledby={taskViewTabId(activeView)} data-testid="task-view-panel">{viewBody}</div> : viewBody}
        </div>
      </div>
    </TaskDetailNavProvider>
  )
}
