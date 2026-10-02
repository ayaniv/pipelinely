import { useCallback, useEffect, useRef, useState } from 'react'
import type { BacklogItem } from '../../../../src/types'
import type { PostActionOptions } from '../../api/actions'
import { backlogDispatchPayload, postBacklogDismiss, postBatchDispatch } from '../../api/backlogActions'
import { ERROR_FLASH_MS, useActionFlash } from '../../components/useActionFlash'
import { useTransientValue } from '../../components/useTransientValue'
import { BacklogBatchBar } from './BacklogBatchBar'
import { BacklogDeleteModal } from './BacklogDeleteModal'
import { BacklogEditForm } from './BacklogEditForm'
import { BacklogRow } from './BacklogRow'
import type { BacklogRowModel } from './boardModel'
import { EmptyState } from './EmptyState'

// The Backlog panel: not-yet-dispatched task ideas from BACKLOG.md.
//
// Selection is keyed by item.description, not by row index — a ticked box at
// index 2 could otherwise silently point at a different item after an
// SSE-driven refresh reshuffles the list. It lives here (component state),
// which stays mounted for the whole session, so it also survives tab
// switches.

export interface BacklogViewProps extends Partial<PostActionOptions> {
  // The rows the project filter leaves visible, each with its index in the
  // unfiltered list.
  rows: BacklogRowModel[]
  // The UNFILTERED list: a delete resolves its targets against it, since a
  // hidden-by-filter selection must never be dispatched but a row's index is
  // an index into this.
  backlog: BacklogItem[]
  isCanonical: boolean
  projectOptions: string[]
  onOpenTask: (slug: string) => void
  // A resumed item lands on In Progress.
  onResumed: () => void
}

type DeleteSource = 'row' | 'batch'

interface PendingDeletion {
  descriptions: string[]
  source: DeleteSource
}

interface DeleteFailure {
  source: DeleteSource
  description: string
  label: string
}

interface EditTarget {
  index: number
  // Snapshot taken when the form opened — the concurrency guard posted at
  // save time, not re-read from a list an SSE refresh may have reshuffled.
  original: BacklogItem
}

function without(set: ReadonlySet<string>, descriptions: string[]): ReadonlySet<string> {
  const next = new Set(set)
  for (const description of descriptions) next.delete(description)
  return next
}

export function BacklogView({ rows, backlog, isCanonical, projectOptions, onOpenTask, onResumed, fetchImpl = fetch, log = console.error }: BacklogViewProps) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<EditTarget | null>(null)
  const [pendingDeletion, setPendingDeletion] = useState<PendingDeletion | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  // Synchronous twin of isDeleting: a second Confirm can land before React
  // has re-rendered with the state above.
  const isDeletingRef = useRef(false)
  const [deleteFailure, showDeleteFailure] = useTransientValue<DeleteFailure>(ERROR_FLASH_MS)
  const [stagedDescriptions, showStaged] = useTransientValue<ReadonlySet<string>>(ERROR_FLASH_MS)
  const batchRun = useActionFlash(log)
  // The delete loop spans several awaits, during which an SSE push can
  // reshuffle the list — each step re-finds its item here, never in the
  // render-time closure.
  const backlogRef = useRef(backlog)
  backlogRef.current = backlog

  // Ticked, not done, and visible under the current filter. A selection the
  // filter hides is kept (it reappears ticked when the filter clears) but is
  // never counted or dispatched while hidden. Feeds the bar's count, Run and
  // Delete, so they can't disagree.
  const visibleSelectedItems = rows.filter(({ item }) => !item.done && selected.has(item.description)).map(({ item }) => item)
  const selectedCount = visibleSelectedItems.length

  const toggleSelected = (description: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(description)) next.delete(description)
    else next.add(description)
    return next
  })

  const runBatch = () => batchRun.run(async () => {
    if (visibleSelectedItems.length === 0) return
    const outcome = await postBatchDispatch({ kind: 'backlog', items: visibleSelectedItems.map(backlogDispatchPayload) }, { fetchImpl, log })
    if (!outcome.ok) {
      // A failed batch leaves the whole selection intact, so it is a
      // one-click retry once the orchestrator is back.
      batchRun.show('btn-err', outcome.detail || outcome.label, ERROR_FLASH_MS)
      return
    }
    // They went out together, so they clear together: every row's Run button
    // shows staged and its box unticks.
    const descriptions = visibleSelectedItems.map((item) => item.description)
    showStaged(new Set(descriptions))
    setSelected((current) => without(current, descriptions))
  })

  const requestDelete = (descriptions: string[], source: DeleteSource) => setPendingDeletion({ descriptions, source })
  const cancelDelete = useCallback(() => setPendingDeletion(null), [])

  // Closes the modal before its first await, so a second Confirm click or
  // Enter finds nothing pending and sends nothing.
  const confirmDelete = async () => {
    if (!pendingDeletion || isDeletingRef.current) return
    const { descriptions, source } = pendingDeletion
    isDeletingRef.current = true
    setIsDeleting(true)
    setPendingDeletion(null)

    // Ordered highest-first once, at confirm time: removing one line from
    // BACKLOG.md only shifts the indices of items after it, so descending
    // order keeps every still-pending index valid. The index itself is
    // re-resolved against the live list before each request.
    const order = descriptions
      .map((description) => ({ description, index: backlog.findIndex((item) => item.description === description) }))
      .filter((target) => target.index !== -1)
      .sort((a, b) => b.index - a.index)

    try {
      for (const { description } of order) {
        const index = backlogRef.current.findIndex((item) => item.description === description)
        // Removed elsewhere since the confirm: nothing left to delete.
        if (index === -1) continue
        const outcome = await postBacklogDismiss(index, backlogRef.current[index], { fetchImpl, log })
        if (!outcome.ok) {
          showDeleteFailure({ source, description, label: outcome.label })
          break
        }
        setSelected((current) => without(current, [description]))
      }
    } finally {
      isDeletingRef.current = false
      setIsDeleting(false)
    }
  }

  const itemsPendingDeletion = (pendingDeletion?.descriptions ?? [])
    .map((description) => backlog.find((item) => item.description === description))
    .filter((item): item is BacklogItem => item !== undefined)

  // A push can remove every pending item before the developer answers; there
  // is then nothing to confirm, so the dialog closes rather than asking about
  // zero items.
  const hasPendingItems = itemsPendingDeletion.length > 0
  useEffect(() => {
    if (pendingDeletion && !hasPendingItems) setPendingDeletion(null)
  }, [pendingDeletion, hasPendingItems])

  return (
    <>
      <BacklogBatchBar
        count={selectedCount}
        isCanonical={isCanonical}
        isRunPending={batchRun.isPending}
        isDeleting={isDeleting}
        runFlash={batchRun.flash}
        deleteFailureLabel={deleteFailure?.source === 'batch' ? deleteFailure.label : null}
        onClear={() => setSelected(new Set())}
        onDelete={() => requestDelete(visibleSelectedItems.map((item) => item.description), 'batch')}
        onRun={runBatch}
      />
      <ul className="backlog-list">
        {rows.length === 0 ? (
          <li><EmptyState /></li>
        ) : (
          rows.map(({ item, index }) => (
            <BacklogRow
              key={`${index}:${item.description}`}
              item={item}
              index={index}
              isSelected={selected.has(item.description)}
              isStaged={stagedDescriptions?.has(item.description) ?? false}
              isCanonical={isCanonical}
              isDeleting={isDeleting}
              deleteFailureLabel={deleteFailure?.source === 'row' && deleteFailure.description === item.description ? deleteFailure.label : null}
              editForm={editing?.index === index ? (
                <BacklogEditForm
                  index={index}
                  original={editing.original}
                  projectOptions={projectOptions}
                  onDone={() => setEditing(null)}
                  fetchImpl={fetchImpl}
                  log={log}
                />
              ) : null}
              onToggleSelected={() => toggleSelected(item.description)}
              onStartEdit={() => setEditing({ index, original: item })}
              onRequestDelete={() => requestDelete([item.description], 'row')}
              onOpenTask={onOpenTask}
              onResumed={onResumed}
              fetchImpl={fetchImpl}
              log={log}
            />
          ))
        )}
      </ul>
      {pendingDeletion && hasPendingItems ? <BacklogDeleteModal items={itemsPendingDeletion} onCancel={cancelDelete} onConfirm={confirmDelete} /> : null}
    </>
  )
}
