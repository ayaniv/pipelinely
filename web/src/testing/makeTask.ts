import type { MilestoneStatus, Task } from '../../../src/types'

// Shared Task/MilestoneStatus factories for web/src tests. The four older
// per-file copies (taskScope, CardMenu, MiniStageRail, TaskDetail tests) are a
// pre-existing duplication — folding them into this one is a separate
// refactor, deliberately not bundled into the graph milestone.

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'demo-task',
    title: 'Demo task',
    mode: 'implement',
    repo: 'cockpit-ai',
    branch: 'claude/demo-task',
    worktree: null,
    devUrl: null,
    verifier: null,
    itermSessionId: null,
    tmuxSession: null,
    plan: null,
    stageHistory: [],
    stage: 'dev',
    findings: [],
    findingsParseMismatch: [],
    qaFailures: [],
    qaCases: [],
    qaCasesParseMismatch: [],
    showsOnBoard: true,
    attentionStatus: 'working',
    autoModeOverride: 'inherit',
    autoMode: true,
    status: 'working',
    updatedAt: new Date('2026-01-01'),
    completedAt: null,
    completedAtSource: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessions: [],
    ...overrides,
  } as Task
}

export function makeMilestone(overrides: Partial<MilestoneStatus> & Pick<MilestoneStatus, 'id'>): MilestoneStatus {
  return {
    name: overrides.id,
    needs: [],
    estimate: null,
    specFile: null,
    wave: 1,
    task: null,
    state: 'queued',
    ...overrides,
  }
}
