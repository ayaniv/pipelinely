import type { Stage, Task } from '../../../../../src/types'
import { formatWhen } from '../../../format'
import { findPrNumber } from '../../../taskScope'
import { STAGE_TO_CHAIN_ID, chainStageById, type ChainStageId } from '../../../pipelineStages'

// The status pill and the recorded-outcome subtitle every stage panel opens with.

export interface PanelPill {
  label: string
  bg: string
  fg: string
}

const NOT_STARTED: PanelPill = { label: 'not started', bg: 'var(--surface2)', fg: 'var(--text2)' }
const NOTHING_SELECTED: PanelPill = { label: 'nothing selected', bg: 'var(--surface2)', fg: 'var(--text2)' }
const NO_CASES_RECORDED: PanelPill = { label: 'no cases recorded', bg: 'var(--surface2)', fg: 'var(--text2)' }
const SAGE = { bg: 'var(--sageSoft)', fg: 'var(--sageInk)' }
const AMBER = { bg: 'var(--amberSoft)', fg: 'var(--amberInk)' }
const ACCENT = { bg: 'var(--accentSoft)', fg: 'var(--accentInk)' }

// The note a stage recorded on the task's TIMELINE — "0 of 4 cases failed",
// "APPROVED", a PR number — with when. Empty when nothing is recorded.
export function stageNote(child: Task | null, stage: Stage): string {
  const event = child?.stageHistory.find((e) => e.stage === stage)
  return event ? `${event.note || 'recorded'} · ${formatWhen(event.at)}` : ''
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function selectedPill(selectedCount: number): PanelPill {
  return selectedCount ? { label: `${selectedCount} selected`, ...AMBER } : NOTHING_SELECTED
}

// Only what the real data supports — a recorded pass/fail count, a live
// selection count, a round count, or a plain not-started/in-progress/done
// read of the same signals the stage rail uses. Never demo wording.
export function panelHeaderPill(child: Task | null, stageId: ChainStageId): PanelPill {
  if (!child) return NOT_STARTED
  const { stage } = chainStageById(stageId)
  const event = child.stageHistory.find((e) => e.stage === stage)
  const isDone = child.status === 'done'

  switch (stageId) {
    case 'qa': {
      if (!child.qaCases.length) return event ? NO_CASES_RECORDED : NOT_STARTED
      const passed = child.qaCases.filter((c) => c.passed).length
      return { label: `${passed} of ${child.qaCases.length} passing`, ...(passed === child.qaCases.length ? SAGE : AMBER) }
    }
    case 'qa-fixes':
      return selectedPill(child.qaFailures.filter((f) => f.selected).length)
    case 'cr':
      if (!event) return NOT_STARTED
      return child.findings.length ? { label: plural(child.findings.length, 'finding'), ...AMBER } : { label: 'no findings', ...SAGE }
    case 'cr-fixes':
      return selectedPill(child.findings.filter((f) => f.selected).length)
    case 'planning':
    case 'plan-review': {
      const rounds = child.stageHistory.filter((e) => e.stage === stage).length
      return rounds ? { label: `round ${rounds}`, ...SAGE } : NOT_STARTED
    }
    case 'merge': {
      if (isDone) return { label: 'done', ...SAGE }
      const prNumber = findPrNumber(child)
      return prNumber ? { label: `ready · PR #${prNumber}`, ...ACCENT } : NOT_STARTED
    }
    default: {
      // dev. TIMELINE recording a stage means it was reached, not that it is
      // still running — only the stage the task is actually sitting on reads
      // "in progress".
      if (isDone) return { label: 'done', ...SAGE }
      if (!event) return NOT_STARTED
      const isCurrentStage = !!child.stage && STAGE_TO_CHAIN_ID[child.stage] === stageId
      return isCurrentStage ? { label: 'in progress', ...ACCENT } : { label: 'done', ...SAGE }
    }
  }
}
