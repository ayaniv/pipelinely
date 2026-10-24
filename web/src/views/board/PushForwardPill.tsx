import { useEffect, useRef, useState } from 'react'
import type { Task } from '../../../../src/types'
import { collectNeedsYou, type DecisionContext } from '../../../../src/nextAction'
import { pushForward, type PushForwardOptions, type PushForwardOutcome } from '../../api/agentActions'
import { SparkleIcon } from '../../components/icons'
import { ERROR_FLASH_MS } from '../../components/useActionFlash'
import { useTransientValue } from '../../components/useTransientValue'
import type { Logger } from '../../log'
import { navigateToTask, type OpenTask } from '../../shell/appNavigation'
import { NeedsYouPanel } from './NeedsYouPanel'

// "Push forward": one click asks the server to run one /pipelinely-babysit sweep
// and reports only what the server says happened. idle → running → one of the
// four results → idle. `running` ends when the request settles, a real signal,
// not a timer; only a result's own display time is timed. `sent` means the
// command reached the orchestrator, not that every dispatch succeeded: that is
// the sweep's own report in the orchestrator tab and the cards' state.
//
// Beside it, a count toggle opens the needs-you list: the same pure
// collectNeedsYou, with the same recorded settings, the sweep uses, computed
// from the snapshot so it is live without a route of its own.

const RESULT_VISIBLE_MS = 5000
const IDLE_TITLE = 'Run one /pipelinely-babysit sweep: push every safe next step forward'
const FAILED_LABEL = 'failed'

type PushForwardState = 'idle' | 'running' | 'sent' | 'nothing' | 'deferred' | 'failed'

interface ShownResult {
  state: Exclude<PushForwardState, 'idle' | 'running'>
  label: string
  title: string
  planned?: number
  load1?: number
}

function resultOf(outcome: PushForwardOutcome): ShownResult {
  switch (outcome.result) {
    case 'sent':
      return { state: 'sent', label: `Sweep sent · ${outcome.planned} planned`, title: 'The sweep command reached the orchestrator', planned: outcome.planned }
    case 'nothing':
      return { state: 'nothing', label: 'Nothing to push', title: 'No task has a safe next step right now' }
    case 'deferred':
      return { state: 'deferred', label: `Held · load ${outcome.load1}`, title: 'The machine is above the load ceiling, so no sweep was started', load1: outcome.load1 }
    case 'failed':
      return { state: 'failed', label: FAILED_LABEL, title: outcome.label }
  }
}

function renderedLabel(state: PushForwardState, shown: ShownResult | null): string {
  switch (state) {
    case 'running': return 'Pushing…'
    case 'idle': return 'Babysit my tasks'
    default: return shown?.label ?? FAILED_LABEL
  }
}

export interface PushForwardPillProps {
  tasks: readonly Task[]
  decisionContext: DecisionContext
  push?: (options: PushForwardOptions) => Promise<PushForwardOutcome>
  fetchImpl?: typeof fetch
  onOpenTask?: OpenTask
  log?: Logger
}

export function PushForwardPill({
  tasks, decisionContext, push = pushForward, fetchImpl = fetch, onOpenTask = navigateToTask, log = console.error,
}: PushForwardPillProps) {
  const [isRunning, setIsRunning] = useState(false)
  const [isPanelOpen, setIsPanelOpen] = useState(false)
  const [shown, showResult] = useTransientValue<ShownResult>(RESULT_VISIBLE_MS)
  // Synchronous guard: a fast double-click can land before React re-renders
  // with isRunning, so the state alone can't be what ignores the second one.
  const isRunningRef = useRef(false)
  const containerRef = useRef<HTMLSpanElement>(null)
  const needsYou = collectNeedsYou(tasks, decisionContext)

  const state: PushForwardState = isRunning ? 'running' : shown?.state ?? 'idle'

  // The panel is a popover over the cards, so it closes on Escape or a press
  // outside it, as well as on the toggle.
  useEffect(() => {
    if (!isPanelOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsPanelOpen(false) }
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsPanelOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    document.addEventListener('mousedown', closeOnOutsidePress)
    return () => {
      document.removeEventListener('keydown', closeOnEscape)
      document.removeEventListener('mousedown', closeOnOutsidePress)
    }
  }, [isPanelOpen])

  const run = async () => {
    if (isRunningRef.current || state !== 'idle') return
    isRunningRef.current = true
    setIsRunning(true)
    try {
      const result = resultOf(await push({ fetchImpl, log }))
      showResult(result, result.state === 'failed' ? ERROR_FLASH_MS : RESULT_VISIBLE_MS)
    } catch (err) {
      log('[agent-action] pushForward threw', err)
      showResult({ state: 'failed', label: FAILED_LABEL, title: FAILED_LABEL }, ERROR_FLASH_MS)
    } finally {
      isRunningRef.current = false
      setIsRunning(false)
    }
  }

  return (
    <span className="push-forward" ref={containerRef}>
      <button
        className={`toolbar-pill push-forward-pill is-${state}`}
        type="button"
        title={shown?.title ?? IDLE_TITLE}
        aria-busy={state === 'running'}
        data-testid="push-forward-pill"
        data-state={state}
        data-planned={shown?.planned}
        data-load={shown?.load1}
        onClick={run}
      >
        <SparkleIcon />
        <span>{renderedLabel(state, shown)}</span>
      </button>
      <button
        className="push-forward-needs-you-toggle"
        type="button"
        aria-expanded={isPanelOpen}
        title="Decisions only you can make, among the tasks shown. A sweep covers every project, filtered or not."
        data-testid="push-forward-needs-you-toggle"
        data-count={needsYou.length}
        onClick={() => setIsPanelOpen((isOpen) => !isOpen)}
      >
        {needsYou.length} needs you
      </button>
      {isPanelOpen && <NeedsYouPanel items={needsYou} onOpenTask={onOpenTask} />}
    </span>
  )
}
