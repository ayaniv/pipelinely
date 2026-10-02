import type { Task } from '../../../../src/types'

// One shared Task fixture for the board's component tests — same shape
// CardMenu.test.tsx builds inline, hoisted here so the board's ~8 test files
// don't each carry their own copy.
export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'demo-task', title: 'Demo task', mode: 'implement', repo: 'cockpit-ai', branch: 'claude/demo-task',
    worktree: null, devUrl: null, verifier: null, qaSkipReason: null, itermSessionId: null, tmuxSession: null, plan: null,
    stageHistory: [], stage: 'dev', findings: [], findingsParseMismatch: [], qaFailures: [], qaCases: [],
    qaCasesParseMismatch: [], showsOnBoard: true, attentionStatus: 'working', autoModeOverride: 'inherit',
    autoMode: false, status: 'working', updatedAt: new Date().toISOString(), completedAt: null, completedAtSource: null,
    totalInputTokens: 0, totalOutputTokens: 0, sessions: [], ...overrides,
  } as Task
}
