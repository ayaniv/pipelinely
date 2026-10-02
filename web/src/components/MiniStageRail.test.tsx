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
    const { container } = render(<MiniStageRail task={makeTask({ stage: 'dev' })} stageIds={['planning', 'dev']} />)
    const wrappers = container.querySelectorAll('[data-testid="mini-stage-node"]')
    expect(wrappers[0].previousSibling).toBeNull()
    expect(wrappers[1].previousSibling).not.toBeNull()
  })
})
