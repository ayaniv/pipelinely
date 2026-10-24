import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MiniStageRail } from './MiniStageRail'
import type { Task } from '../../../src/types'

// The decorative-only mini stage rail (session/dev card's 16px-node row).

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 't', title: 't', mode: 'implement', repo: 'r', branch: 'b', worktree: null, devUrl: null,
    verifier: null, itermSessionId: null, tmuxSession: null, plan: null, stageHistory: [], stage: 'dev',
    findings: [], findingsParseMismatch: [], qaFailures: [], qaCases: [], qaCasesParseMismatch: [],
    showsOnBoard: true, attentionStatus: 'working', autoModeOverride: 'inherit', autoMode: true,
    status: 'working', updatedAt: new Date(), completedAt: null, completedAtSource: null,
    totalInputTokens: 0, totalOutputTokens: 0, sessions: [], ...overrides,
  } as Task
}

describe('MiniStageRail', () => {
  test('renders one node per stage id, with the current stage marked', () => {
    render(<MiniStageRail task={makeTask({ stage: 'dev' })} stageIds={['planning', 'dev', 'cr', 'qa', 'merge']} />)
    const nodes = screen.getAllByTestId('mini-stage-node')
    expect(nodes.map((n) => n.dataset.stage)).toEqual(['planning', 'dev', 'cr', 'qa', 'merge'])
    expect(nodes.map((n) => n.dataset.state)).toEqual(['done', 'current', 'todo', 'todo', 'todo'])
  })

  test('the first node has no leading connector, every other node does', () => {
    render(<MiniStageRail task={makeTask({ stage: 'dev' })} stageIds={['planning', 'dev']} />)
    expect(screen.getAllByTestId('mini-stage-connector')).toHaveLength(1)
  })

  test('draws the current node and the done nodes in the tone colour', () => {
    render(<MiniStageRail task={makeTask({ stage: 'code-review' })} stageIds={['planning', 'dev', 'cr']} tone="cr" />)
    const nodes = screen.getAllByTestId('mini-stage-node')
    const [done, current] = [nodes[0], nodes[2]]
    expect(current.getAttribute('style')).toContain('var(--crC)')
    expect(done.getAttribute('style')).toContain('var(--crC)')
  })

  test('without a tone it keeps the accent colour', () => {
    render(<MiniStageRail task={makeTask({ stage: 'dev' })} stageIds={['planning', 'dev']} />)
    expect(screen.getAllByTestId('mini-stage-node')[1].getAttribute('style')).toContain('var(--accent)')
  })

  test('labels every node under the rail when asked, the current one marked', () => {
    render(<MiniStageRail task={makeTask({ stage: 'code-review' })} stageIds={['planning', 'dev', 'cr', 'qa', 'merge']} tone="cr" showLabels />)
    const labels = screen.getAllByTestId('mini-stage-label')
    expect(labels.map((l) => l.textContent)).toEqual(['Plan', 'Dev', 'CR', 'QA', 'Merge'])
    expect(labels.map((l) => l.dataset.current)).toEqual(['false', 'false', 'true', 'false', 'false'])
  })

  test('shows no labels by default', () => {
    render(<MiniStageRail task={makeTask({ stage: 'dev' })} stageIds={['planning', 'dev']} />)
    expect(screen.queryAllByTestId('mini-stage-label')).toHaveLength(0)
  })

  test('a finished task has no current label', () => {
    render(<MiniStageRail task={makeTask({ status: 'done', stage: null, stageHistory: [] })} stageIds={['planning', 'dev']} showLabels />)
    expect(screen.getAllByTestId('mini-stage-label').every((l) => l.dataset.current === 'false')).toBe(true)
  })
})
