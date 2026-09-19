import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execa } from 'execa'
import {
  parseMilestoneSlug,
  countPlanMilestones,
  countMilestonesInPlan,
  computeActiveProject,
  parseBacklogContent,
  parseBacklog,
  applyBacklogEdit,
  applyBacklogRemoval,
  getMergeCommitDate,
  dateGroupLabel,
  groupDoneTasksByDate,
  isOrphaned,
  parseTask,
  parseStatusContent,
  parseTaskMdContent,
  parseTimelineContent,
  buildSessions,
  newestSnapshot,
  LIVE_SESSION_WINDOW_MS,
  parseVerdict,
  parseQaResult,
  computeStage,
  parseFindings,
  findFindingsParseMismatch,
  findQaCasesParseMismatch,
  applyTriageSelection,
  parseQaFailures,
  applyQaTriageSelection,
  parseQaCases,
  parseMilestonesContent,
  computeMilestones,
  parseQaSpecFile,
  parseQaCaseTitles,
  parseAllTasks,
  shouldShowOnBoard,
  computeAttentionStatus,
  applyBacklogShelveEntry,
  findResumableBacklogSlug,
  worktreesDir,
  buildDeadSessionMessage,
  computeNextStageCta,
  isMilestoneReadyForDev,
  composeStageCommand,
  STAGE_SKILL,
  SKIP_STAGE,
  STAGES,
  NEXT_STAGE_BY_WAITING_REASON,
  parsePrNumberFromReviewRef,
  findPrNumber,
  parseSettingsContent,
  readSettings,
  parseAutoModeOverride,
  computeEffectiveAutoMode,
  computeAutoDispatch,
  DEFAULT_SETTINGS,
  MANUAL_ONLY_STAGES,
  parseOrchestratorMetrics,
  isBacklogProject,
  formatBacklogItemLine,
  applyBacklogProjectBackfill,
  parseSummarySection,
  stripSummarySection,
} from './taskParser.js'
import type { MilestoneDecl, MilestoneStatus, StageEvent, Task } from './types.js'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    slug: 'task',
    title: '',
    mode: '',
    repo: '',
    branch: '',
    worktree: null,
    devUrl: null,
    verifier: null,
    stageHistory: [],
    stage: null,
    itermSessionId: null,
    tmuxSession: null,
    plan: null,
    autoModeOverride: 'inherit',
    autoMode: false,
    status: 'working',
    updatedAt: new Date(),
    completedAt: null,
    completedAtSource: null,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    sessions: [],
    findings: [],
    findingsParseMismatch: [],
    qaFailures: [],
    qaCases: [],
    qaCasesParseMismatch: [],
    showsOnBoard: true,
    attentionStatus: 'idle',
    ...overrides,
  }
}

describe('parseStatusContent', () => {
  it('parses the bare review status', () => {
    expect(parseStatusContent('review')).toEqual({ status: 'review' })
  })

  it('parses review with a PR reference after the colon', () => {
    expect(parseStatusContent('review: https://github.com/o/r/pull/214'))
      .toEqual({ status: 'review', reviewRef: 'https://github.com/o/r/pull/214' })
  })

  it('tolerates trailing whitespace and a newline from echo', () => {
    expect(parseStatusContent('review: #214\n')).toEqual({ status: 'review', reviewRef: '#214' })
  })

  it('leaves the existing statuses untouched', () => {
    expect(parseStatusContent('done')).toEqual({ status: 'done' })
    expect(parseStatusContent('waiting: needs API key'))
      .toEqual({ status: 'waiting', waitingReason: 'needs API key' })
    expect(parseStatusContent('handover: session #2 — continuing'))
      .toEqual({ status: 'handover', handoverSession: 2 })
    expect(parseStatusContent('working')).toEqual({ status: 'working' })
  })

  it('falls back to working for anything unrecognised', () => {
    expect(parseStatusContent('reviewing the thing')).toEqual({ status: 'working' })
  })

  it('parses paused with a reason after the colon', () => {
    expect(parseStatusContent('paused: stepping away to review another task'))
      .toEqual({ status: 'paused', pausedReason: 'stepping away to review another task' })
  })

  it('tolerates trailing whitespace and a newline from echo for paused', () => {
    expect(parseStatusContent('paused: back after lunch\n'))
      .toEqual({ status: 'paused', pausedReason: 'back after lunch' })
  })

  it('parses done with a note after the colon', () => {
    expect(parseStatusContent('done: fix merged as PR #51; remaining edge cases picked up by fix-tmux-dead-session-race'))
      .toEqual({ status: 'done', doneNote: 'fix merged as PR #51; remaining edge cases picked up by fix-tmux-dead-session-race' })
  })

  it('tolerates trailing whitespace and a newline from echo for done', () => {
    expect(parseStatusContent('done: shipped\n'))
      .toEqual({ status: 'done', doneNote: 'shipped' })
  })
})

describe('parseTaskMdContent', () => {
  const REUSED = `# Sydney checkbox stuck disabled

## Workspace
- Repo: overlap
- Branch: fix/sydney-checkbox-stuck
- Mode: investigate

## ⚠️ NEW REQUEST (2026-08-04)
- Repo: overlap
- Branch: fix/sydney-checkbox-round-2
- Mode: implement
`

  it('takes the last Mode/Repo/Branch so a reused task dir reflects the new request', () => {
    const parsed = parseTaskMdContent(REUSED)
    expect(parsed.mode).toBe('implement')
    expect(parsed.branch).toBe('fix/sydney-checkbox-round-2')
    expect(parsed.repo).toBe('overlap')
  })

  it('keeps the title as the first non-empty line, not the last heading', () => {
    expect(parseTaskMdContent(REUSED).title).toBe('Sydney checkbox stuck disabled')
  })

  it('still reads a single-section TASK.md correctly', () => {
    const parsed = parseTaskMdContent('# T\n\n- Repo: overlap\n- Branch: feat/x\n- Mode: implement\n')
    expect(parsed).toEqual({ title: 'T', mode: 'implement', repo: 'overlap', branch: 'feat/x' })
  })

  it('returns empty fields when TASK.md declares none of them', () => {
    expect(parseTaskMdContent('# Just a title\n')).toEqual({ title: 'Just a title', mode: '', repo: '', branch: '' })
  })
})

describe('parseTimelineContent', () => {
  it('parses a timestamp, stage, and note per line', () => {
    expect(parseTimelineContent('2026-08-02T14:40:03Z plan-review approved with 2 notes\n')).toEqual([
      { stage: 'plan-review', at: '2026-08-02T14:40:03Z', note: 'approved with 2 notes' },
    ])
  })

  it('parses a line with no note', () => {
    expect(parseTimelineContent('2026-08-02T14:02:11Z planning')).toEqual([
      { stage: 'planning', at: '2026-08-02T14:02:11Z', note: null },
    ])
  })

  it('keeps entries in file order so the last line is the current stage', () => {
    const raw = [
      '2026-08-02T14:02:11Z planning',
      '2026-08-02T14:40:03Z plan-review',
      '2026-08-03T09:18:44Z dev PR #214',
    ].join('\n')
    expect(parseTimelineContent(raw).map((e) => e.stage)).toEqual(['planning', 'plan-review', 'dev'])
  })

  it('skips blank lines, malformed lines, and unknown stage names', () => {
    const raw = [
      '',
      'not a timeline line at all',
      '2026-08-03T09:18:44Z deploying',
      '2026-08-03T10:24:00Z qa 2 of 9 failed',
      '   ',
    ].join('\n')
    expect(parseTimelineContent(raw)).toEqual([
      { stage: 'qa', at: '2026-08-03T10:24:00Z', note: '2 of 9 failed' },
    ])
  })

  it('returns an empty array for an empty file', () => {
    expect(parseTimelineContent('')).toEqual([])
  })
})

describe('parseVerdict', () => {
  it('reads CHANGES REQUIRED anywhere in the report', () => {
    expect(parseVerdict('# Review\n\n## Verdict: CHANGES REQUIRED\n\n3 must-fix')).toBe('changes-required')
  })

  it('reads APPROVED', () => {
    expect(parseVerdict('# Review\n\nVerdict: APPROVED — ship it')).toBe('approved')
  })

  it('prefers changes-required when both words appear', () => {
    expect(parseVerdict('Approved the approach, but: CHANGES REQUIRED')).toBe('changes-required')
  })

  it('is null when the report states no verdict', () => {
    expect(parseVerdict('# Review\n\nSome notes with no verdict line.')).toBeNull()
  })
})

describe('parsePrNumberFromReviewRef', () => {
  it('reads the number out of a PR URL', () => {
    expect(parsePrNumberFromReviewRef('https://github.com/acme/widgets/pull/19')).toBe('19')
  })

  it('accepts a bare number', () => {
    expect(parsePrNumberFromReviewRef('19')).toBe('19')
  })

  it('is null for undefined', () => {
    expect(parsePrNumberFromReviewRef(undefined)).toBeNull()
  })

  it('is null for text that is neither a PR URL nor a bare number', () => {
    expect(parsePrNumberFromReviewRef('needs a PR still')).toBeNull()
  })
})

describe('findPrNumber', () => {
  it('reads a "#N" reference out of the dev stage\'s TIMELINE note — the actual, currently-used source', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [
        { stage: 'planning' as const, at: '2026-08-10T09:00:00Z', note: 'wrote plan' },
        { stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' },
      ],
    }
    expect(findPrNumber(task)).toBe('42')
  })

  it('reads a full PR URL out of the dev stage\'s note', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [
        { stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'opened https://github.com/acme/widgets/pull/42' },
      ],
    }
    expect(findPrNumber(task)).toBe('42')
  })

  it('prefers reviewRef when both are present, for backward compatibility with the legacy convention', () => {
    const task = {
      reviewRef: '99',
      stageHistory: [{ stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' }],
    }
    expect(findPrNumber(task)).toBe('99')
  })

  it('uses the LATEST dev round\'s note when dev ran more than once', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [
        { stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' },
        { stage: 'qa' as const, at: '2026-08-10T13:00:00Z', note: '1 of 3 cases failed' },
        { stage: 'dev' as const, at: '2026-08-10T14:00:00Z', note: 'fixes pushed to PR #42' },
      ],
    }
    expect(findPrNumber(task)).toBe('42')
  })

  it('falls back to the server-resolved prNumber when neither reviewRef nor any dev note names a PR', () => {
    const task = {
      reviewRef: undefined,
      prNumber: '108',
      stageHistory: [{ stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR opened: no number recorded' }],
    }
    expect(findPrNumber(task)).toBe('108')
  })

  it('prefers a PR named in the TIMELINE over the server-resolved prNumber', () => {
    const task = {
      reviewRef: undefined,
      prNumber: '108',
      stageHistory: [{ stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' }],
    }
    expect(findPrNumber(task)).toBe('42')
  })

  it('is null when neither reviewRef nor any dev note mentions a PR', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [{ stage: 'planning' as const, at: '2026-08-10T09:00:00Z', note: 'wrote plan' }],
    }
    expect(findPrNumber(task)).toBeNull()
  })

  it('falls back to an earlier dev note\'s PR reference when a later dev note is just more work on the same PR', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [
        { stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' },
        { stage: 'qa' as const, at: '2026-08-10T13:00:00Z', note: '1 of 3 cases failed' },
        { stage: 'dev' as const, at: '2026-08-10T14:00:00Z', note: 'rebased on master, pushed fixes' },
      ],
    }
    expect(findPrNumber(task)).toBe('42')
  })

  it('prefers a later dev round\'s own PR reference when it opened a different PR', () => {
    const task = {
      reviewRef: undefined,
      stageHistory: [
        { stage: 'dev' as const, at: '2026-08-10T12:00:00Z', note: 'PR #42 open' },
        { stage: 'qa' as const, at: '2026-08-10T13:00:00Z', note: '3 of 3 cases failed' },
        { stage: 'dev' as const, at: '2026-08-10T14:00:00Z', note: 're-dispatched, opened PR #77' },
      ],
    }
    expect(findPrNumber(task)).toBe('77')
  })
})

describe('parseQaResult', () => {
  it('reads an explicit failed count', () => {
    expect(parseQaResult('# QA\n\n2 of 9 cases failed')).toEqual({ failed: 2 })
  })

  it('reads a clean run as zero failures', () => {
    expect(parseQaResult('# QA\n\n0 of 9 cases failed')).toEqual({ failed: 0 })
    expect(parseQaResult('# QA\n\nAll 9 cases passed')).toEqual({ failed: 0 })
  })

  it('is null when the report has no recognisable result line', () => {
    expect(parseQaResult('# QA\n\nRan the thing.')).toBeNull()
  })
})

const FULL_REVIEW = `## Code Review: claude/some-branch

**Summary:** Something short.

---

### Must Fix (3)
Bugs, architectural violations, or things a reviewer would block on.
- [Category] Description of the issue — \`path/to/file.tsx:42\`
- [Category] Another issue — \`path/to/other.ts:88\`
- [Category] A third — \`path/to/third.ts:12\`

### Should Fix (2)
Worth addressing before merge, not hard blockers.
- [Category] A should-fix item — \`path/to/file.tsx:91\`
- [Category] Another should-fix — \`path/to/file.tsx:105\`

### Suggestions (1)
Minor polish — low effort, nice to have.
- [Category] A suggestion — \`path/to/file.tsx:200\`

### Strengths
...

---

### Pre-Merge Checklist
...

---

**Verdict: CHANGES REQUIRED**
`

describe('parseFindings', () => {
  it('parses must, should, and suggestion findings', () => {
    const findings = parseFindings(FULL_REVIEW)
    expect(findings).toHaveLength(6)
    expect(findings.filter((f) => f.severity === 'must')).toHaveLength(3)
    expect(findings.filter((f) => f.severity === 'should')).toHaveLength(2)
    expect(findings.filter((f) => f.severity === 'suggestion')).toHaveLength(1)
    expect(findings.some((f) => f.description.includes('suggestion'))).toBe(true)
  })

  it('emits must, should, then suggestion findings, in file order', () => {
    const findings = parseFindings(FULL_REVIEW)
    expect(findings.map((f) => f.location)).toEqual([
      'path/to/file.tsx:42',
      'path/to/other.ts:88',
      'path/to/third.ts:12',
      'path/to/file.tsx:91',
      'path/to/file.tsx:105',
      'path/to/file.tsx:200',
    ])
  })

  it('parses category, description, and location out of a bullet', () => {
    const [first] = parseFindings(FULL_REVIEW)
    expect(first).toEqual({
      severity: 'must',
      category: 'Category',
      description: 'Description of the issue',
      location: 'path/to/file.tsx:42',
    })
  })

  it('produces no should-findings when the section is omitted entirely', () => {
    const raw = `### Must Fix (1)\n- [Category] Only issue — \`a.ts:1\`\n\n### Strengths\n...\n`
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe('must')
  })

  it('skips a malformed bullet line rather than throwing', () => {
    const raw = `### Must Fix (2)\n- [Category] Well-formed — \`a.ts:1\`\n- this line has no bracket or backtick location\n`
    expect(() => parseFindings(raw)).not.toThrow()
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].location).toBe('a.ts:1')
  })

  it('stops scanning at an h2 boundary, not just another h3 or a "---" divider', () => {
    const raw = `### Must Fix (1)\n- [Category] Real issue — \`a.ts:1\`\n\n## Summary\n- [Category] Should not be picked up — \`b.ts:2\`\n`
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].location).toBe('a.ts:1')
  })

  it('returns an empty array for a report with no findings sections', () => {
    expect(parseFindings('## Code Review: x\n\n**Verdict: APPROVED**\n')).toEqual([])
  })

  it('parses a bullet citing two locations, joining them into one location string', () => {
    const raw =
      '### Must Fix (1)\n' +
      '- [Duplication] Duplicated logic in two places — ' +
      '`public/index.html:2516` and `public/index.html:2732`\n'
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0]).toEqual({
      severity: 'must',
      category: 'Duplication',
      description: 'Duplicated logic in two places',
      location: 'public/index.html:2516, public/index.html:2732',
    })
  })

  it('parses a bullet citing three comma/and-separated locations', () => {
    const raw =
      '### Should Fix (1)\n' +
      '- [Category] Repeated in three spots — `a.ts:1`, `b.ts:2`, and `c.ts:3`\n'
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].location).toBe('a.ts:1, b.ts:2, c.ts:3')
  })

  // Bug 1 (fix-qa-cr-bullet-format-gap): a worker session has twice now
  // written a trailing location without backticks — the parser used to
  // require them and silently dropped the whole bullet. It should now
  // tolerate the bare form too.
  it('parses a bullet with a bare, non-backtick-quoted location', () => {
    const raw = '### Must Fix (1)\n- [Category] Missing backticks around the path — path/to/file.ts:42\n'
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].location).toBe('path/to/file.ts:42')
  })

  it('parses a bare tail citing two comma-separated locations', () => {
    const raw = '### Must Fix (1)\n- [Category] Duplicated in two spots — a.ts:1, b.ts:2\n'
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findings[0].location).toBe('a.ts:1, b.ts:2')
  })

  it('rejects a bullet tail that merely follows an em dash but is not location-shaped', () => {
    const raw = '### Must Fix (1)\n- [Category] Some finding — not a real path at all\n'
    expect(parseFindings(raw)).toEqual([])
  })

  it('rejects a bare tail when only one of several segments looks like a location', () => {
    const raw = '### Must Fix (1)\n- [Category] Partially bogus tail — a.ts:1, not a path\n'
    expect(parseFindings(raw)).toEqual([])
  })
})

describe('findFindingsParseMismatch', () => {
  it('reports nothing when every bullet in every declared section parsed', () => {
    expect(findFindingsParseMismatch(FULL_REVIEW, parseFindings(FULL_REVIEW))).toEqual([])
  })

  it('reports a mismatch when a section heading count disagrees with what actually parsed', () => {
    const raw =
      '### Must Fix (2)\n' +
      '- [Category] Well-formed — `a.ts:1`\n' +
      '- this line matches FINDING_BULLET_RE\'s shape for nothing at all\n'
    const findings = parseFindings(raw)
    expect(findings).toHaveLength(1)
    expect(findFindingsParseMismatch(raw, findings)).toEqual(['Must Fix: header says 2, parsed 1'])
  })

  it('reports one mismatch per disagreeing severity section', () => {
    const raw =
      '### Must Fix (1)\n- not a bullet at all\n\n' +
      '### Should Fix (2)\n- [Category] Well-formed — `a.ts:1`\n- also not a bullet\n'
    const findings = parseFindings(raw)
    expect(findFindingsParseMismatch(raw, findings)).toEqual([
      'Must Fix: header says 1, parsed 0',
      'Should Fix: header says 2, parsed 1',
    ])
  })

  it('does not flag a section heading with no declared "(N)" count', () => {
    const raw = '### Must Fix\n- [Category] No count on the heading — `a.ts:1`\n'
    expect(findFindingsParseMismatch(raw, parseFindings(raw))).toEqual([])
  })
})

describe('applyTriageSelection', () => {
  const findings = [
    { severity: 'must' as const, category: 'A', description: 'a', location: 'a.ts:1' },
    { severity: 'must' as const, category: 'B', description: 'b', location: 'b.ts:2' },
    { severity: 'should' as const, category: 'C', description: 'c', location: 'c.ts:3' },
    { severity: 'suggestion' as const, category: 'D', description: 'd', location: 'd.ts:4' },
  ]

  it('defaults to all must selected, no should/suggestion selected when TRIAGE.json is absent', () => {
    expect(applyTriageSelection(findings, null)).toEqual([
      { ...findings[0], selected: true },
      { ...findings[1], selected: true },
      { ...findings[2], selected: false },
      { ...findings[3], selected: false },
    ])
  })

  it('an explicit empty array means nothing is selected, even must findings', () => {
    expect(applyTriageSelection(findings, [])).toEqual([
      { ...findings[0], selected: false },
      { ...findings[1], selected: false },
      { ...findings[2], selected: false },
      { ...findings[3], selected: false },
    ])
  })

  it('an explicit array selects exactly those indices regardless of severity', () => {
    expect(applyTriageSelection(findings, [1, 2, 3])).toEqual([
      { ...findings[0], selected: false },
      { ...findings[1], selected: true },
      { ...findings[2], selected: true },
      { ...findings[3], selected: true },
    ])
  })
})

const FULL_QA_REPORT = `# QA Report

Browser pass against the dev URL.

**2 of 9 cases failed**

### Failing Cases (2)
- [Case 3] Empty city selection doesn't show inline validation — \`case-3\`
- [Case 7] Removing a city twice quickly duplicates the toast — \`case-7\`

### Passing Cases (7)
- [Case 1] Filter resets correctly — \`case-1\`
- [Case 2] Sort order stable across reloads — \`case-2\`
`

// A "## Summary" (h2) section trailing a "### Failing Cases" (h3) one — the
// real-world shape a QA_REPORT.md is likely to have (top-level h2 sections,
// h3 subsections within). Regression fixture for a bug where the section
// scanner only stopped at another "### " or "---", so it kept reading
// through an h2 boundary and picked up unrelated bullets past it.
const QA_REPORT_WITH_H2_BOUNDARY = `# QA Report

### Failing Cases (1)
- [Case 3] Empty city selection doesn't show inline validation — \`case-3\`

## Summary
- [Case 1] Should not be picked up — this is prose under a different section — \`case-1\`
`

describe('parseQaFailures', () => {
  it('parses label, description, and location out of a bullet', () => {
    const failures = parseQaFailures(FULL_QA_REPORT)
    expect(failures).toHaveLength(2)
    expect(failures[0]).toEqual({
      label: 'Case 3',
      description: "Empty city selection doesn't show inline validation",
      location: 'case-3',
    })
  })

  it('emits failures in file order', () => {
    const failures = parseQaFailures(FULL_QA_REPORT)
    expect(failures.map((f) => f.location)).toEqual(['case-3', 'case-7'])
  })

  it('does not pick up bullets from other sections (e.g. Passing Cases)', () => {
    const failures = parseQaFailures(FULL_QA_REPORT)
    expect(failures).toHaveLength(2)
    expect(failures.map((f) => f.location)).not.toContain('case-1')
    expect(failures.map((f) => f.location)).not.toContain('case-2')
  })

  it('stops scanning at an h2 boundary, not just another h3 or a "---" divider', () => {
    const failures = parseQaFailures(QA_REPORT_WITH_H2_BOUNDARY)
    expect(failures).toHaveLength(1)
    expect(failures[0].location).toBe('case-3')
  })

  it('skips a malformed bullet line rather than throwing', () => {
    const raw = `### Failing Cases (2)\n- [Case 1] Well-formed — \`case-1\`\n- this line has no bracket or backtick location\n`
    expect(() => parseQaFailures(raw)).not.toThrow()
    const failures = parseQaFailures(raw)
    expect(failures).toHaveLength(1)
    expect(failures[0].location).toBe('case-1')
  })

  it('returns an empty array for a report with no Failing Cases section', () => {
    expect(parseQaFailures('# QA Report\n\n**all 9 cases passed**\n')).toEqual([])
  })
})

const ALL_PASSED_QA_REPORT = `# QA Report

**all 2 cases passed**

### Passing Cases (2)
- [Case 1] Filter resets correctly — \`case-1\`
- [Case 2] Sort order stable across reloads — \`case-2\`
`

describe('parseQaCases', () => {
  it('parses both Failing and Passing sections, tagging each with passed', () => {
    const cases = parseQaCases(FULL_QA_REPORT)
    expect(cases).toEqual([
      { label: 'Case 3', description: "Empty city selection doesn't show inline validation", location: 'case-3', passed: false },
      { label: 'Case 7', description: 'Removing a city twice quickly duplicates the toast', location: 'case-7', passed: false },
      { label: 'Case 1', description: 'Filter resets correctly', location: 'case-1', passed: true },
      { label: 'Case 2', description: 'Sort order stable across reloads', location: 'case-2', passed: true },
    ])
  })

  it('marks every case passed when there is no Failing Cases section', () => {
    const cases = parseQaCases(ALL_PASSED_QA_REPORT)
    expect(cases).toHaveLength(2)
    expect(cases.every(c => c.passed)).toBe(true)
  })

  it('stops scanning at an h2 boundary, not just another h3 or a "---" divider', () => {
    const cases = parseQaCases(QA_REPORT_WITH_H2_BOUNDARY)
    expect(cases).toHaveLength(1)
    expect(cases[0]).toEqual({ label: 'Case 3', description: "Empty city selection doesn't show inline validation", location: 'case-3', passed: false })
  })

  it('skips a malformed bullet line rather than throwing', () => {
    const raw = `### Passing Cases (2)\n- [Case 1] Well-formed — \`case-1\`\n- this line has no bracket or backtick location\n`
    expect(() => parseQaCases(raw)).not.toThrow()
    const cases = parseQaCases(raw)
    expect(cases).toHaveLength(1)
    expect(cases[0].location).toBe('case-1')
  })

  it('returns an empty array for a report with neither section', () => {
    expect(parseQaCases('# QA Report\n\nSomething went wrong before any section was written.\n')).toEqual([])
  })

  // Bug 1 (fix-qa-cr-bullet-format-gap): pipelinely-dashboard-redesign-m0's
  // real QA_REPORT.md has a "### Passing Cases (28)" section where every
  // single bullet's trailing location is bare, not backtick-quoted — qaCases
  // came back [] despite the header correctly reporting all 28 passed.
  it('parses a bullet with a bare, non-backtick-quoted location, populating qaCases on a passing report', () => {
    const raw = '**all 1 cases passed**\n\n### Passing Cases (1)\n- [Case 1] Works as expected — e2e/foo.spec.ts:12\n'
    const cases = parseQaCases(raw)
    expect(cases).toEqual([
      { label: 'Case 1', description: 'Works as expected', location: 'e2e/foo.spec.ts:12', passed: true },
    ])
  })

  // Found while verifying the leniency fix against that same real
  // QA_REPORT.md: two of its bullets have an em dash INSIDE the description
  // itself ("The state filter is gone — project is the only filter
  // dimension"), which a naive "split on the first em dash" would have
  // mistaken for the description/location boundary.
  it('treats the LAST em dash in the line as the location separator, not the first', () => {
    const raw =
      '### Passing Cases (1)\n' +
      '- [Filter] The state filter is gone — project is the only filter dimension — e2e/foo.spec.ts:309\n'
    const cases = parseQaCases(raw)
    expect(cases).toEqual([{
      label: 'Filter',
      description: 'The state filter is gone — project is the only filter dimension',
      location: 'e2e/foo.spec.ts:309',
      passed: true,
    }])
  })
})

describe('findQaCasesParseMismatch', () => {
  it('reports nothing when every bullet in every declared section parsed', () => {
    // Not FULL_QA_REPORT — its own "Passing Cases (7)" header is
    // deliberately abbreviated to 2 listed bullets for parseQaFailures'
    // "ignores the Passing section" tests above, so it would report a
    // (correct, but irrelevant here) mismatch of its own.
    expect(findQaCasesParseMismatch(ALL_PASSED_QA_REPORT, parseQaCases(ALL_PASSED_QA_REPORT))).toEqual([])
  })

  it('reports a mismatch per section when a header count disagrees with what actually parsed', () => {
    const raw =
      '### Failing Cases (2)\n- [Case 1] Well-formed — `case-1`\n- not a bullet\n\n' +
      '### Passing Cases (1)\n- [Case 2] Well-formed — `case-2`\n'
    const cases = parseQaCases(raw)
    expect(findQaCasesParseMismatch(raw, cases)).toEqual(['Failing Cases: header says 2, parsed 1'])
  })
})

describe('applyQaTriageSelection', () => {
  const failures = [
    { label: 'Case 3', description: 'a', location: 'case-3' },
    { label: 'Case 7', description: 'b', location: 'case-7' },
  ]

  it('defaults to all cases selected when QA_TRIAGE.json is absent — no must/should tiering for QA failures', () => {
    expect(applyQaTriageSelection(failures, null)).toEqual([
      { ...failures[0], selected: true },
      { ...failures[1], selected: true },
    ])
  })

  it('an explicit empty array means nothing is selected', () => {
    expect(applyQaTriageSelection(failures, [])).toEqual([
      { ...failures[0], selected: false },
      { ...failures[1], selected: false },
    ])
  })

  it('an explicit array selects exactly those indices', () => {
    expect(applyQaTriageSelection(failures, [1])).toEqual([
      { ...failures[0], selected: false },
      { ...failures[1], selected: true },
    ])
  })
})

describe('computeStage', () => {
  const base = {
    status: 'working' as const,
    mode: '' as const,
    stageHistory: [],
    hasTechDesign: false,
    reviewVerdict: null,
    qaResult: null,
  }

  it('trusts the last TIMELINE entry over any inference', () => {
    expect(computeStage({
      ...base,
      stageHistory: [
        { stage: 'dev', at: '2026-08-03T09:00:00Z', note: null },
        { stage: 'qa', at: '2026-08-03T10:00:00Z', note: null },
      ],
      hasTechDesign: true,
      mode: 'investigate',
    })).toBe('qa')
  })

  it('has no stage for a done task — those cards live on the Done tab', () => {
    expect(computeStage({ ...base, status: 'done' })).toBeNull()
  })

  it('a handover task keeps its real stage — it is still continuing, not finished', () => {
    expect(computeStage({
      ...base,
      status: 'handover',
      stageHistory: [{ stage: 'dev', at: '2026-08-03T09:00:00Z', note: null }],
    })).toBe('dev')
  })

  it('is comment-fix when the review asked for changes', () => {
    expect(computeStage({ ...base, status: 'review', reviewVerdict: 'changes-required' })).toBe('comment-fix')
  })

  it('is qa when the review approved', () => {
    expect(computeStage({ ...base, status: 'review', reviewVerdict: 'approved' })).toBe('qa')
  })

  it('a clean QA result advances a TIMELINE pinned at qa to merge', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'qa', at: '2026-08-03T10:00:00Z', note: null }],
      qaResult: { failed: 0 },
    })).toBe('merge')
  })

  it('a failed QA result advances a TIMELINE pinned at qa to qa-fixes', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'qa', at: '2026-08-03T10:00:00Z', note: null }],
      qaResult: { failed: 2 },
    })).toBe('qa-fixes')
  })

  it('does not refine ahead of a dispatched QA that has not reported back yet', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'qa', at: '2026-08-03T10:00:00Z', note: null }],
      qaResult: null,
    })).toBe('qa')
  })

  it('does not drag a qa-fixes task back to qa-fixes-via-merge on a stale clean qaResult', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'qa-fixes', at: '2026-08-03T11:00:00Z', note: null }],
      qaResult: { failed: 0 },
    })).toBe('qa-fixes')
  })

  it('leaves a TIMELINE already at merge unchanged by a clean qaResult', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'merge', at: '2026-08-03T12:00:00Z', note: null }],
      qaResult: { failed: 0 },
    })).toBe('merge')
  })

  it('does not let a qaResult refine any non-qa stage', () => {
    expect(computeStage({
      ...base,
      stageHistory: [{ stage: 'dev', at: '2026-08-03T09:00:00Z', note: null }],
      qaResult: { failed: 0 },
    })).toBe('dev')
  })

  it('the done gate still wins over a qa-refining qaResult', () => {
    expect(computeStage({
      ...base,
      status: 'done',
      stageHistory: [{ stage: 'qa', at: '2026-08-03T10:00:00Z', note: null }],
      qaResult: { failed: 0 },
    })).toBeNull()
  })

  it('is qa-fixes when QA found failures', () => {
    expect(computeStage({ ...base, qaResult: { failed: 2 } })).toBe('qa-fixes')
  })

  it('is merge when QA came back clean', () => {
    expect(computeStage({ ...base, qaResult: { failed: 0 } })).toBe('merge')
  })

  it('is code-review when STATUS is review and no verdict exists yet', () => {
    expect(computeStage({ ...base, status: 'review' })).toBe('code-review')
  })

  it('is planning for an investigate task with no design doc yet', () => {
    expect(computeStage({ ...base, mode: 'investigate' })).toBe('planning')
  })

  it('is plan-review once the design doc exists', () => {
    expect(computeStage({ ...base, mode: 'investigate', hasTechDesign: true })).toBe('plan-review')
  })

  it('is dev for a plain implement task', () => {
    expect(computeStage({ ...base, mode: 'implement' })).toBe('dev')
  })

  it('is dev for a task dir with none of the new files — every pre-existing task', () => {
    expect(computeStage(base)).toBe('dev')
  })

  it('is dev for a waiting task with no other signal', () => {
    expect(computeStage({ ...base, status: 'waiting' })).toBe('dev')
  })
})

// Real heading lines copied from ~/Dev/overlap/plan.md.
const OVERLAP_PLAN = `# overlap: configurable world-clock, sharing, and meeting scheduler (A–E)

## Milestones (deployable; dependency-ordered)

### M0 — Rename + Vercel (blocks all; do first)
Rename dir etc.

### M1 — Config foundation + app scaffolding (blocks M2/M3/M4)
Config foundation details.

### M2 — Edit locations (B) — parallel, needs M1
Edit locations details.

### M3 — Share (C) — parallel, needs M1
Share details.

### M4 — Schedule (D) — parallel, needs M1
Schedule details.

### M5 — Responsive (E) — parallel, needs only M0
Responsive details.
`

describe('parseMilestoneSlug', () => {
  it('extracts projectBase and milestone number', () => {
    expect(parseMilestoneSlug('overlap-m2')).toEqual({ projectBase: 'overlap', milestoneNumber: 2 })
  })

  it('handles milestone 0', () => {
    expect(parseMilestoneSlug('overlap-m0')).toEqual({ projectBase: 'overlap', milestoneNumber: 0 })
  })

  it('keeps hyphens inside a multi-word project base', () => {
    expect(parseMilestoneSlug('my-cool-project-m3')).toEqual({
      projectBase: 'my-cool-project',
      milestoneNumber: 3,
    })
  })

  it('returns null for slugs without a trailing -m<N>', () => {
    expect(parseMilestoneSlug('cockpit-branch-icon')).toBeNull()
    expect(parseMilestoneSlug('time-spinner-plan')).toBeNull()
  })

  it('returns null when the milestone segment has no digits', () => {
    expect(parseMilestoneSlug('overlap-m')).toBeNull()
  })
})

describe('countPlanMilestones', () => {
  it('counts M0-M5 headings in the real overlap plan.md format', () => {
    expect(countPlanMilestones(OVERLAP_PLAN)).toBe(6)
  })

  it('recognizes alternate heading markup', () => {
    const raw = ['## M0 intro', '### M1: config', '- **M2** edit'].join('\n')
    expect(countPlanMilestones(raw)).toBe(3)
  })

  it('dedupes a milestone number mentioned in more than one heading', () => {
    const raw = ['### M0 — first mention', '### M0 — heading repeated'].join('\n')
    expect(countPlanMilestones(raw)).toBe(1)
  })

  it('returns 0 for an empty file', () => {
    expect(countPlanMilestones('')).toBe(0)
  })

  it('returns 0 for garbled content with no milestone headings', () => {
    expect(countPlanMilestones('this is just\nsome unrelated notes\nno headings here')).toBe(0)
  })
})

describe('countMilestonesInPlan', () => {
  let tmpDir: string
  let originalReposDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-plan-test-'))
    originalReposDir = process.env.REPOS_DIR
    process.env.REPOS_DIR = tmpDir
  })

  afterEach(async () => {
    if (originalReposDir === undefined) delete process.env.REPOS_DIR
    else process.env.REPOS_DIR = originalReposDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('counts milestones from a real plan.md', async () => {
    const repoDir = path.join(tmpDir, 'overlap')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, 'plan.md'), OVERLAP_PLAN)
    expect(await countMilestonesInPlan('overlap')).toBe(6)
  })

  it('returns null when plan.md is missing', async () => {
    const repoDir = path.join(tmpDir, 'no-plan-repo')
    await fs.mkdir(repoDir, { recursive: true })
    expect(await countMilestonesInPlan('no-plan-repo')).toBeNull()
  })

  it('returns null when the repo directory itself does not exist', async () => {
    expect(await countMilestonesInPlan('does-not-exist')).toBeNull()
  })

  it('returns 0 (not a crash) for a garbled plan.md', async () => {
    const repoDir = path.join(tmpDir, 'garbled')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, 'plan.md'), 'not a plan file, just prose.')
    expect(await countMilestonesInPlan('garbled')).toBe(0)
  })
})

describe('parseOrchestratorMetrics', () => {
  let tmpDir: string
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-orch-metrics-test-'))
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    consoleErrorSpy.mockRestore()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads a valid contextPct from ORCHESTRATOR_METRICS', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), JSON.stringify({ contextPct: 82 }))
    expect(await parseOrchestratorMetrics(tmpDir)).toBe(82)
  })

  it('returns null, silently, when the file is missing', async () => {
    expect(await parseOrchestratorMetrics(tmpDir)).toBeNull()
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('returns null and logs when the file is malformed JSON', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), 'not json')
    expect(await parseOrchestratorMetrics(tmpDir)).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null and logs when the JSON parses to a bare `null` (not an object)', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), 'null')
    expect(await parseOrchestratorMetrics(tmpDir)).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null and logs when contextPct is above the valid range', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), JSON.stringify({ contextPct: 101 }))
    expect(await parseOrchestratorMetrics(tmpDir)).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('returns null and logs when contextPct is negative', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), JSON.stringify({ contextPct: -1 }))
    expect(await parseOrchestratorMetrics(tmpDir)).toBeNull()
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
  })

  it('accepts the lower boundary of the valid range', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), JSON.stringify({ contextPct: 0 }))
    expect(await parseOrchestratorMetrics(tmpDir)).toBe(0)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })

  it('accepts the upper boundary of the valid range', async () => {
    await fs.writeFile(path.join(tmpDir, 'ORCHESTRATOR_METRICS'), JSON.stringify({ contextPct: 100 }))
    expect(await parseOrchestratorMetrics(tmpDir)).toBe(100)
    expect(consoleErrorSpy).not.toHaveBeenCalled()
  })
})

describe('milestone slug + plan.md combine into current/total (happy path)', () => {
  let tmpDir: string
  let originalReposDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-plan-test-'))
    originalReposDir = process.env.REPOS_DIR
    process.env.REPOS_DIR = tmpDir
    const repoDir = path.join(tmpDir, 'overlap')
    await fs.mkdir(repoDir, { recursive: true })
    await fs.writeFile(path.join(repoDir, 'plan.md'), OVERLAP_PLAN)
  })

  afterEach(async () => {
    if (originalReposDir === undefined) delete process.env.REPOS_DIR
    else process.env.REPOS_DIR = originalReposDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('overlap-m2 -> current 3 / total 6', async () => {
    const slugInfo = parseMilestoneSlug('overlap-m2')
    expect(slugInfo).not.toBeNull()
    const total = await countMilestonesInPlan(slugInfo!.projectBase)
    const current = slugInfo!.milestoneNumber + 1
    expect(current).toBe(3)
    expect(total).toBe(6)
  })
})

describe('computeActiveProject', () => {
  it('returns null when there are no milestone tasks', () => {
    expect(computeActiveProject([makeTask({ slug: 'cockpit-branch-icon' })])).toBeNull()
  })

  it('returns null when the only milestone task is done', () => {
    const tasks = [
      makeTask({
        slug: 'overlap-m2',
        status: 'done',
        projectBase: 'overlap',
        milestoneCurrent: 3,
        milestoneTotal: 6,
      }),
    ]
    expect(computeActiveProject(tasks)).toBeNull()
  })

  it('picks the single active milestone task', () => {
    const tasks = [
      makeTask({
        slug: 'overlap-m2',
        status: 'working',
        projectBase: 'overlap',
        milestoneCurrent: 3,
        milestoneTotal: 6,
      }),
    ]
    expect(computeActiveProject(tasks)).toEqual({ projectBase: 'overlap', current: 3, total: 6 })
  })

  it('ignores milestone tasks with no resolvable total (unreadable plan.md)', () => {
    const tasks = [
      makeTask({ slug: 'overlap-m2', status: 'working', projectBase: 'overlap', milestoneCurrent: 3 }),
    ]
    expect(computeActiveProject(tasks)).toBeNull()
  })

  it('still counts a paused milestone task as active — paused, not finished', () => {
    const tasks = [
      makeTask({
        slug: 'overlap-m2',
        status: 'paused',
        projectBase: 'overlap',
        milestoneCurrent: 3,
        milestoneTotal: 6,
      }),
    ]
    expect(computeActiveProject(tasks)).toEqual({ projectBase: 'overlap', current: 3, total: 6 })
  })

  it('picks the most recently updated project when several are active', () => {
    const older = makeTask({
      slug: 'foo-m1',
      status: 'working',
      projectBase: 'foo',
      milestoneCurrent: 2,
      milestoneTotal: 4,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    })
    const newer = makeTask({
      slug: 'bar-m0',
      status: 'waiting',
      projectBase: 'bar',
      milestoneCurrent: 1,
      milestoneTotal: 3,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    })
    expect(computeActiveProject([older, newer])).toEqual({ projectBase: 'bar', current: 1, total: 3 })
  })
})

describe('parseBacklogContent', () => {
  it('parses a description and trailing date', () => {
    const raw = '- [ ] Add dark mode toggle (2026-07-10)'
    expect(parseBacklogContent(raw)).toEqual([
      { description: 'Add dark mode toggle', date: '2026-07-10', context: null, shelvedSlug: null, project: null, done: false },
    ])
  })

  it('captures an indented context line under an item', () => {
    const raw = [
      '- [ ] Investigate flaky CI (2026-07-11)',
      '  seen twice this week on the taskParser suite',
    ].join('\n')
    expect(parseBacklogContent(raw)).toEqual([
      {
        description: 'Investigate flaky CI',
        date: '2026-07-11',
        context: 'seen twice this week on the taskParser suite',
        shelvedSlug: null,
        project: null,
        done: false,
      },
    ])
  })

  it('marks checked items done', () => {
    const raw = '- [x] Already promoted idea (2026-07-01)'
    expect(parseBacklogContent(raw)[0].done).toBe(true)
  })

  it('handles an item with no date', () => {
    const raw = '- [ ] Just an idea, no date'
    expect(parseBacklogContent(raw)).toEqual([
      { description: 'Just an idea, no date', date: null, context: null, shelvedSlug: null, project: null, done: false },
    ])
  })

  it('parses multiple items and ignores non-checklist lines', () => {
    const raw = [
      '# Backlog',
      '',
      'Some intro prose.',
      '',
      '- [ ] First idea (2026-07-01)',
      '- [ ] Second idea (2026-07-02)',
    ].join('\n')
    const items = parseBacklogContent(raw)
    expect(items).toHaveLength(2)
    expect(items.map((i) => i.description)).toEqual(['First idea', 'Second idea'])
  })

  it('returns an empty array for an empty or header-only file', () => {
    expect(parseBacklogContent('')).toEqual([])
    expect(parseBacklogContent('# Backlog\n\nNothing here yet.')).toEqual([])
  })
})

describe('parseBacklogContent — the project prefix', () => {
  it('lifts a bracketed single-token prefix as the project', () => {
    const raw = '- [ ] [cockpit-ai] Add dark mode toggle (2026-07-10)'
    expect(parseBacklogContent(raw)).toEqual([
      { description: 'Add dark mode toggle', date: '2026-07-10', context: null, shelvedSlug: null, project: 'cockpit-ai', done: false },
    ])
  })

  it('leaves an untagged line with project: null', () => {
    const raw = '- [ ] Add dark mode toggle (2026-07-10)'
    expect(parseBacklogContent(raw)[0].project).toBeNull()
  })

  it('parses a tag alongside context and a shelved marker', () => {
    const raw = [
      '- [ ] [overlap] Parked work (2026-08-28)',
      '  some context',
      '  shelved: parked-task',
    ].join('\n')
    expect(parseBacklogContent(raw)).toEqual([
      { description: 'Parked work', date: '2026-08-28', context: 'some context', shelvedSlug: 'parked-task', project: 'overlap', done: false },
    ])
  })

  it('keeps a bracketed phrase with spaces as prose, not a project', () => {
    const items = parseBacklogContent('- [ ] [needs design input] rethink the stepper (2026-07-10)')
    expect(items[0].project).toBeNull()
    expect(items[0].description).toBe('[needs design input] rethink the stepper')
  })

  it('keeps a bracketed "org/repo" token as prose, not a project', () => {
    const items = parseBacklogContent('- [ ] [org/repo] foo (2026-07-10)')
    expect(items[0].project).toBeNull()
    expect(items[0].description).toBe('[org/repo] foo')
  })

  it('a bare "[p]" with nothing after it (not even a space) stays prose', () => {
    const items = parseBacklogContent('- [ ] [p]')
    expect(items[0].project).toBeNull()
    expect(items[0].description).toBe('[p]')
  })

  it('"[p] (date)" with nothing between the bracket and the date yields project p and an empty description', () => {
    const items = parseBacklogContent('- [ ] [p] (2026-07-10)')
    // The prefix regex requires at least one char of `rest` after the bracket
    // (`\s+(.*)$` matches an empty string), so "[p] " followed immediately by
    // the date still lifts the project, leaving an empty description.
    expect(items[0].project).toBe('p')
    expect(items[0].description).toBe('')
    expect(items[0].date).toBe('2026-07-10')
  })

  it('real-shape regression: an untagged line with inline parens before the date parses the same, now with project: null', () => {
    const raw = '- [ ] Fix `pasteIntoSession`\'s bug (`src/focusTab.ts`) (2026-09-06)'
    const items = parseBacklogContent(raw)
    expect(items).toHaveLength(1)
    expect(items[0].project).toBeNull()
    expect(items[0].date).toBe('2026-09-06')
    expect(items[0].description).toBe('Fix `pasteIntoSession`\'s bug (`src/focusTab.ts`)')
  })
})

describe('isBacklogProject', () => {
  it('accepts a single bare token', () => {
    expect(isBacklogProject('cockpit-ai')).toBe(true)
    expect(isBacklogProject('overlap_api.v2')).toBe(true)
  })

  it('rejects a token with spaces or slashes', () => {
    expect(isBacklogProject('needs design input')).toBe(false)
    expect(isBacklogProject('org/repo')).toBe(false)
  })
})

describe('formatBacklogItemLine', () => {
  it('formats a tagged line that round-trips through parseBacklogContent', () => {
    const result = formatBacklogItemLine(false, 'cockpit-ai', 'Some idea', '2026-08-05')
    expect(result).toEqual({ ok: true, line: '- [ ] [cockpit-ai] Some idea (2026-08-05)' })
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.line)).toEqual([
      { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: 'cockpit-ai', done: false },
    ])
  })

  it('formats an untagged line when project is null', () => {
    const result = formatBacklogItemLine(false, null, 'Some idea', '2026-08-05')
    expect(result).toEqual({ ok: true, line: '- [ ] Some idea (2026-08-05)' })
  })

  it('formats a done (checked) line', () => {
    const result = formatBacklogItemLine(true, null, 'Some idea', null)
    expect(result).toEqual({ ok: true, line: '- [x] Some idea' })
  })

  it('refuses a project with spaces', () => {
    expect(formatBacklogItemLine(false, 'not a slug', 'desc', null)).toEqual({ ok: false, error: 'invalid-project' })
  })

  it('refuses a project containing a slash', () => {
    expect(formatBacklogItemLine(false, 'org/repo', 'desc', null)).toEqual({ ok: false, error: 'invalid-project' })
  })

  it('refuses an untagged description starting with a bracketed word (project-collision)', () => {
    expect(formatBacklogItemLine(false, null, '[WIP] foo', null)).toEqual({ ok: false, error: 'project-collision' })
  })

  it('does not collide when a tagged description itself starts with a bracketed word', () => {
    const result = formatBacklogItemLine(false, 'cockpit-ai', '[WIP] foo', null)
    expect(result).toEqual({ ok: true, line: '- [ ] [cockpit-ai] [WIP] foo' })
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.line)[0]).toEqual(
      { description: '[WIP] foo', date: null, context: null, shelvedSlug: null, project: 'cockpit-ai', done: false },
    )
  })
})

describe('applyBacklogEdit', () => {
  it('rewrites the description, date, and context of the item at the given index', () => {
    const raw = [
      '# Backlog',
      '',
      '- [ ] First idea (2026-07-01)',
      '- [ ] Second idea (2026-07-02)',
      '  some context',
    ].join('\n')
    const original = { description: 'Second idea', date: '2026-07-02', context: 'some context', shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 1, original, {
      description: 'Second idea, revised',
      date: '2026-07-03',
      context: 'updated context',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'First idea', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false },
      { description: 'Second idea, revised', date: '2026-07-03', context: 'updated context', shelvedSlug: null, project: null, done: false },
    ])
  })

  it('can clear an existing date and context', () => {
    const raw = [
      '- [ ] Has both (2026-07-01)',
      '  with context',
    ].join('\n')
    const original = { description: 'Has both', date: '2026-07-01', context: 'with context', shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Has neither', date: null, context: null, project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'Has neither', date: null, context: null, shelvedSlug: null, project: null, done: false },
    ])
  })

  it('can add a context line to an item that had none', () => {
    const raw = '- [ ] No context yet (2026-07-01)'
    const original = { description: 'No context yet', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, {
      description: 'No context yet',
      date: '2026-07-01',
      context: 'now it has some',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'No context yet', date: '2026-07-01', context: 'now it has some', shelvedSlug: null, project: null, done: false },
    ])
  })

  it('leaves other lines untouched', () => {
    const raw = [
      '# Backlog',
      '',
      '- [ ] First idea (2026-07-01)',
      '- [ ] Second idea (2026-07-02)',
    ].join('\n')
    const original = { description: 'First idea', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'First idea, edited', date: '2026-07-01', context: null, project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[1]).toEqual({
      description: 'Second idea', date: '2026-07-02', context: null, shelvedSlug: null, project: null, done: false,
    })
  })

  it('returns out-of-range for a negative or too-large index', () => {
    const raw = '- [ ] Only item (2026-07-01)'
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const updates = { description: 'x', date: null, context: null, project: null }
    expect(applyBacklogEdit(raw, 1, original, updates)).toEqual({ ok: false, error: 'out-of-range' })
    expect(applyBacklogEdit(raw, -1, original, updates)).toEqual({ ok: false, error: 'out-of-range' })
    expect(applyBacklogEdit('', 0, original, updates)).toEqual({ ok: false, error: 'out-of-range' })
  })

  it('returns conflict when the item at the index no longer matches the original snapshot', () => {
    const raw = '- [ ] Changed underneath you (2026-07-01)'
    const stale = { description: 'What the client last saw', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, stale, { description: 'x', date: null, context: null, project: null })
    expect(result).toEqual({ ok: false, error: 'conflict' })
  })

  it('collapses embedded newlines in description and context to a single line each', () => {
    const raw = '- [ ] Only item (2026-07-01)'
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, {
      description: 'First line\nSecond line',
      date: '2026-07-01',
      context: 'Context line one\nContext line two',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    // The written file must not contain a raw newline within the item's block
    // (i.e. no orphan continuation lines) — every line belongs to a
    // recognizable checklist item or an indented context line.
    expect(result.content).toEqual(
      '- [ ] First line Second line (2026-07-01)\n  Context line one Context line two',
    )

    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'First line Second line', date: '2026-07-01', context: 'Context line one Context line two', shelvedSlug: null, project: null, done: false },
    ])
  })

  it('does not let a context line starting with "- [ ] " be parsed back as a second backlog item', () => {
    const raw = '- [ ] Only item (2026-07-01)'
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, {
      description: 'Only item',
      date: '2026-07-01',
      context: 'Normal context\n- [ ] Sneaky phantom item',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')

    const reparsed = parseBacklogContent(result.content)
    expect(reparsed).toHaveLength(1)
    expect(reparsed[0]).toEqual({
      description: 'Only item',
      date: '2026-07-01',
      context: 'Normal context - [ ] Sneaky phantom item',
      shelvedSlug: null,
      project: null,
      done: false,
    })
  })
})

describe('applyBacklogEdit — project', () => {
  it('sets a project on a previously untagged item', () => {
    const raw = '- [ ] Some idea (2026-08-05)'
    const original = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Some idea', date: '2026-08-05', context: null, project: 'cockpit-ai' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].project).toBe('cockpit-ai')
  })

  it('changes an existing project', () => {
    const raw = '- [ ] [cockpit-ai] Some idea (2026-08-05)'
    const original = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: 'cockpit-ai', done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Some idea', date: '2026-08-05', context: null, project: 'overlap' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].project).toBe('overlap')
  })

  it('clears an existing project', () => {
    const raw = '- [ ] [cockpit-ai] Some idea (2026-08-05)'
    const original = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: 'cockpit-ai', done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Some idea', date: '2026-08-05', context: null, project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].project).toBeNull()
  })

  it('passes an invalid-project refusal through, writing nothing', () => {
    const raw = '- [ ] Some idea (2026-08-05)'
    const original = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Some idea', date: '2026-08-05', context: null, project: 'not a slug' })
    expect(result).toEqual({ ok: false, error: 'invalid-project' })
  })

  it('passes a project-collision refusal through, writing nothing', () => {
    const raw = '- [ ] Some idea (2026-08-05)'
    const original = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: '[WIP] foo', date: null, context: null, project: null })
    expect(result).toEqual({ ok: false, error: 'project-collision' })
  })

  it('a retag conflicts against a stale original that has the wrong project', () => {
    const raw = '- [ ] [cockpit-ai] Some idea (2026-08-05)'
    const stale = { description: 'Some idea', date: '2026-08-05', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(raw, 0, stale, { description: 'Some idea', date: '2026-08-05', context: null, project: 'overlap' })
    expect(result).toEqual({ ok: false, error: 'conflict' })
  })

  it('an untouched shelved: marker survives a retag', () => {
    const raw = ['- [ ] [cockpit-ai] Parked work (2026-08-28)', '  shelved: parked-task'].join('\n')
    const original = { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: 'cockpit-ai', done: false }
    const result = applyBacklogEdit(raw, 0, original, { description: 'Parked work', date: '2026-08-28', context: null, project: 'overlap' })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0]).toEqual(
      { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: 'overlap', done: false },
    )
  })
})

describe('applyBacklogRemoval', () => {
  it('removes the checklist line and its context line for the item at the given index', () => {
    const raw = [
      '# Backlog',
      '',
      '- [ ] First idea (2026-07-01)',
      '- [ ] Second idea (2026-07-02)',
      '  some context',
      '- [ ] Third idea (2026-07-03)',
    ].join('\n')
    const original = { description: 'Second idea', date: '2026-07-02', context: 'some context', shelvedSlug: null, project: null, done: false }
    const result = applyBacklogRemoval(raw, 1, original)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'First idea', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false },
      { description: 'Third idea', date: '2026-07-03', context: null, shelvedSlug: null, project: null, done: false },
    ])
  })

  it('removes an item with no context line, leaving surrounding lines untouched', () => {
    const raw = [
      '# Backlog',
      '- [ ] Only item (2026-07-01)',
      '- [ ] Keep me (2026-07-02)',
    ].join('\n')
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogRemoval(raw, 0, original)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.content).toEqual(['# Backlog', '- [ ] Keep me (2026-07-02)'].join('\n'))
  })

  it('removes the only item, leaving an empty backlog', () => {
    const raw = '- [ ] Only item (2026-07-01)'
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogRemoval(raw, 0, original)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([])
  })

  it('returns out-of-range for a negative or too-large index', () => {
    const raw = '- [ ] Only item (2026-07-01)'
    const original = { description: 'Only item', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    expect(applyBacklogRemoval(raw, 1, original)).toEqual({ ok: false, error: 'out-of-range' })
    expect(applyBacklogRemoval(raw, -1, original)).toEqual({ ok: false, error: 'out-of-range' })
    expect(applyBacklogRemoval('', 0, original)).toEqual({ ok: false, error: 'out-of-range' })
  })

  it('returns conflict when the item at the index no longer matches the original snapshot', () => {
    const raw = '- [ ] Changed underneath you (2026-07-01)'
    const stale = { description: 'What the client last saw', date: '2026-07-01', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogRemoval(raw, 0, stale)
    expect(result).toEqual({ ok: false, error: 'conflict' })
  })
})

describe('parseBacklog', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-backlog-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads and parses BACKLOG.md from the tasks dir', async () => {
    await fs.writeFile(path.join(tmpDir, 'BACKLOG.md'), '- [ ] Try new idea (2026-07-15)')
    expect(await parseBacklog(tmpDir)).toEqual([
      { description: 'Try new idea', date: '2026-07-15', context: null, shelvedSlug: null, project: null, done: false },
    ])
  })

  it('returns an empty array when BACKLOG.md does not exist', async () => {
    expect(await parseBacklog(tmpDir)).toEqual([])
  })
})

describe('getMergeCommitDate', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-merge-date-test-'))
    await execa('git', ['init', '-q', tmpDir])
    await execa('git', ['-C', tmpDir, 'config', 'user.email', 'test@example.com'])
    await execa('git', ['-C', tmpDir, 'config', 'user.name', 'Test'])
    await fs.writeFile(path.join(tmpDir, 'README.md'), 'hello')
    await execa('git', ['-C', tmpDir, 'add', '.'])
    await execa('git', ['-C', tmpDir, 'commit', '-q', '-m', 'init'])
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('finds the date of a commit matching "Merge <branch>: ..."', async () => {
    await execa('git', ['-C', tmpDir, 'commit', '-q', '--allow-empty', '-m', 'Merge claude/foo: did the thing'])
    const date = await getMergeCommitDate(tmpDir, 'claude/foo')
    expect(date).not.toBeNull()
    expect(date!.getTime()).toBeGreaterThan(0)
  })

  it('finds the date of a commit matching "Merge <branch> into master"', async () => {
    await execa('git', ['-C', tmpDir, 'commit', '-q', '--allow-empty', '-m', 'Merge claude/foo into master'])
    const date = await getMergeCommitDate(tmpDir, 'claude/foo')
    expect(date).not.toBeNull()
  })

  it('returns null when no commit mentions the branch', async () => {
    expect(await getMergeCommitDate(tmpDir, 'claude/never-merged')).toBeNull()
  })

  it('returns null for an empty branch name', async () => {
    expect(await getMergeCommitDate(tmpDir, '')).toBeNull()
  })

  it('returns null when the repo directory does not exist', async () => {
    expect(await getMergeCommitDate(path.join(tmpDir, 'does-not-exist'), 'claude/foo')).toBeNull()
  })
})

describe('dateGroupLabel', () => {
  const now = new Date('2026-07-21T15:00:00')

  it('labels the current calendar date "Today"', () => {
    expect(dateGroupLabel('2026-07-21', now)).toBe('Today')
  })

  it('labels the day before "Yesterday"', () => {
    expect(dateGroupLabel('2026-07-20', now)).toBe('Yesterday')
  })

  it('formats an older same-year date without a year', () => {
    expect(dateGroupLabel('2026-07-18', now)).toBe('Sat, Jul 18')
  })

  it('formats an older date from a previous year with the year', () => {
    expect(dateGroupLabel('2025-12-25', now)).toBe('Thu, Dec 25, 2025')
  })

  it('labels the unknown bucket "Unknown date"', () => {
    expect(dateGroupLabel('unknown', now)).toBe('Unknown date')
  })
})

describe('groupDoneTasksByDate', () => {
  const now = new Date('2026-07-21T15:00:00')

  it('groups a task completed today under "Today"', () => {
    const tasks = [
      makeTask({ slug: 'a', status: 'done', completedAt: '2026-07-21T09:00:00' }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ dateKey: '2026-07-21', label: 'Today' })
    expect(groups[0].tasks.map(t => t.slug)).toEqual(['a'])
  })

  it('puts tasks with no reliable completion date in a trailing "unknown" bucket', () => {
    const tasks = [
      makeTask({ slug: 'today-task', status: 'done', completedAt: '2026-07-21T09:00:00' }),
      makeTask({ slug: 'no-date-task', status: 'done', completedAt: null }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups).toHaveLength(2)
    expect(groups[groups.length - 1]).toMatchObject({ dateKey: 'unknown', label: 'Unknown date' })
    expect(groups[groups.length - 1].tasks.map(t => t.slug)).toEqual(['no-date-task'])
  })

  it('splits tasks on either side of a midnight boundary into separate date groups', () => {
    const tasks = [
      makeTask({ slug: 'late-night', status: 'done', completedAt: '2026-07-20T23:58:00' }),
      makeTask({ slug: 'just-after-midnight', status: 'done', completedAt: '2026-07-21T00:02:00' }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups).toHaveLength(2)
    expect(groups[0]).toMatchObject({ dateKey: '2026-07-21' })
    expect(groups[0].tasks.map(t => t.slug)).toEqual(['just-after-midnight'])
    expect(groups[1]).toMatchObject({ dateKey: '2026-07-20' })
    expect(groups[1].tasks.map(t => t.slug)).toEqual(['late-night'])
  })

  it('orders groups most-recent-date first, and tasks within a group most-recent first', () => {
    const tasks = [
      makeTask({ slug: 'oldest', status: 'done', completedAt: '2026-07-19T10:00:00' }),
      makeTask({ slug: 'today-early', status: 'done', completedAt: '2026-07-21T08:00:00' }),
      makeTask({ slug: 'today-late', status: 'done', completedAt: '2026-07-21T14:00:00' }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups.map(g => g.dateKey)).toEqual(['2026-07-21', '2026-07-19'])
    expect(groups[0].tasks.map(t => t.slug)).toEqual(['today-late', 'today-early'])
  })

  it('excludes tasks that are not done', () => {
    const tasks = [
      makeTask({ slug: 'active', status: 'working', completedAt: null }),
      makeTask({ slug: 'finished', status: 'done', completedAt: '2026-07-21T08:00:00' }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups).toHaveLength(1)
    expect(groups[0].tasks.map(t => t.slug)).toEqual(['finished'])
  })

  it('excludes handover tasks — still continuing in a new session, not finished', () => {
    const tasks = [
      makeTask({ slug: 'continuing', status: 'handover', completedAt: null }),
      makeTask({ slug: 'finished', status: 'done', completedAt: '2026-07-21T08:00:00' }),
    ]
    const groups = groupDoneTasksByDate(tasks, now)
    expect(groups).toHaveLength(1)
    expect(groups[0].tasks.map(t => t.slug)).toEqual(['finished'])
  })

  it('returns an empty array when there are no done tasks', () => {
    expect(groupDoneTasksByDate([], now)).toEqual([])
  })
})

describe('isOrphaned', () => {
  it('is false when the iTerm tab is still live', () => {
    expect(isOrphaned('working', 'iterm-1', new Set(['iterm-1']), 'worker-foo', new Set())).toBe(false)
  })

  it('is false when the iTerm tab is gone but its tmux session is live', () => {
    expect(isOrphaned('working', 'iterm-1', new Set(), 'worker-foo', new Set(['worker-foo']))).toBe(false)
  })

  it('is true when both the iTerm tab and the tmux session are gone', () => {
    expect(isOrphaned('working', 'iterm-1', new Set(), 'worker-foo', new Set())).toBe(true)
  })

  it('is true when the iTerm tab is gone and there is no tmux session on record (pre-existing task dirs)', () => {
    expect(isOrphaned('working', 'iterm-1', new Set(), null, new Set())).toBe(true)
  })

  it('is false when status is not "working"', () => {
    expect(isOrphaned('done', 'iterm-1', new Set(), null, new Set())).toBe(false)
  })

  it('is false when there was never an iTerm session recorded', () => {
    expect(isOrphaned('working', null, new Set(), null, new Set())).toBe(false)
  })
})

// The two session files the dashboard's → Terminal button depends on:
// ITERM_SESSION (focus path) and TMUX_SESSION (reattach path). Absent files
// must read as null rather than '' — a task dir predating the tmux work has no
// TMUX_SESSION at all, and an empty-string session name would match nothing
// while still looking "set" to callers.
describe('parseTask session files', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-session-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Every case needs a task dir with a STATUS file; only the session files vary.
  async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, 'some-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'working')
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content)
    }
    return dir
  }

  it('reads ITERM_SESSION, trimming the trailing newline echo leaves behind', async () => {
    const task = await parseTask(await makeTaskDir({ ITERM_SESSION: 'w0t1p0:ABC-123\n' }))
    expect(task?.itermSessionId).toBe('w0t1p0:ABC-123')
  })

  it('reads TMUX_SESSION, trimming the trailing newline echo leaves behind', async () => {
    const task = await parseTask(await makeTaskDir({ TMUX_SESSION: 'worker-some-task\n' }))
    expect(task?.tmuxSession).toBe('worker-some-task')
  })

  it('returns null for both when neither file exists (pre-tmux task dirs)', async () => {
    const task = await parseTask(await makeTaskDir({}))
    expect(task?.itermSessionId).toBeNull()
    expect(task?.tmuxSession).toBeNull()
  })

  it('returns null for a whitespace-only ITERM_SESSION', async () => {
    const task = await parseTask(await makeTaskDir({ ITERM_SESSION: '  \n' }))
    expect(task?.itermSessionId).toBeNull()
  })

  it('returns null for a whitespace-only TMUX_SESSION', async () => {
    const task = await parseTask(await makeTaskDir({ TMUX_SESSION: '  \n' }))
    expect(task?.tmuxSession).toBeNull()
  })

  it('reads both files independently when both are present', async () => {
    const task = await parseTask(await makeTaskDir({
      ITERM_SESSION: 'w0t1p0:ABC-123\n',
      TMUX_SESSION: 'worker-some-task-s2\n',
    }))
    expect(task?.itermSessionId).toBe('w0t1p0:ABC-123')
    expect(task?.tmuxSession).toBe('worker-some-task-s2')
  })
})

describe('parseTask completedAt', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-completedat-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeTaskDir(status: string): Promise<string> {
    const dir = path.join(tmpDir, 'some-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), status)
    return dir
  }

  it('resolves no completion date for a handover task — it is still continuing', async () => {
    const task = await parseTask(await makeTaskDir('handover: session #2 — continuing in new tab'))
    expect(task?.completedAt).toBeNull()
    expect(task?.completedAtSource).toBeNull()
  })
})

describe('parseTask completedAt — merge-commit lookup caching', () => {
  let tmpDir: string
  let originalReposDir: string | undefined

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pipelinely-merge-cache-test-'))
    originalReposDir = process.env.REPOS_DIR
    process.env.REPOS_DIR = path.join(tmpDir, 'repos')
  })

  afterEach(async () => {
    if (originalReposDir === undefined) delete process.env.REPOS_DIR
    else process.env.REPOS_DIR = originalReposDir
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeDoneTaskDir(slug: string, repo: string, branch: string): Promise<string> {
    const dir = path.join(tmpDir, slug)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'done')
    await fs.writeFile(path.join(dir, 'TASK.md'), `# T\n\n- Repo: ${repo}\n- Branch: ${branch}\n`)
    return dir
  }

  async function makeRepo(repo: string): Promise<string> {
    const repoDir = path.join(tmpDir, 'repos', repo)
    await fs.mkdir(repoDir, { recursive: true })
    await execa('git', ['init', '-q', repoDir])
    await execa('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com'])
    await execa('git', ['-C', repoDir, 'config', 'user.name', 'Test'])
    await fs.writeFile(path.join(repoDir, 'README.md'), 'hello')
    await execa('git', ['-C', repoDir, 'add', '.'])
    await execa('git', ['-C', repoDir, 'commit', '-q', '-m', 'init'])
    return repoDir
  }

  // A squash-merged-via-GitHub-PR branch never gets a "Merge <branch>"
  // commit, so this is the common case for a done task — and it's the one
  // that used to re-spawn `git log` on every refresh forever, since only
  // hits were cached. Adding the matching commit *between* the two
  // parseTask calls proves the miss was actually cached: an uncached lookup
  // would pick it up on the second call and flip the source to
  // 'merge-commit', but a cached miss keeps returning the stale
  // 'status-mtime' result instead.
  it('caches a merge-commit miss — a later matching commit is not picked up', async () => {
    const repo = 'merge-cache-miss-repo'
    const branch = 'claude/merge-cache-miss-branch'
    await makeRepo(repo)
    const dir = await makeDoneTaskDir('merge-cache-miss-task', repo, branch)

    const first = await parseTask(dir)
    expect(first?.completedAtSource).toBe('status-mtime')

    await execa('git', ['-C', path.join(tmpDir, 'repos', repo), 'commit', '-q', '--allow-empty', '-m', `Merge ${branch}: did the thing`])

    const second = await parseTask(dir)
    expect(second?.completedAtSource).toBe('status-mtime')
  })

  it('still resolves a real merge-commit date when one already exists', async () => {
    const repo = 'merge-cache-hit-repo'
    const branch = 'claude/merge-cache-hit-branch'
    const repoDir = await makeRepo(repo)
    await execa('git', ['-C', repoDir, 'commit', '-q', '--allow-empty', '-m', `Merge ${branch}: did the thing`])
    const dir = await makeDoneTaskDir('merge-cache-hit-task', repo, branch)

    const task = await parseTask(dir)
    expect(task?.completedAtSource).toBe('merge-commit')
  })
})

describe('parseTask VERIFY', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-verify-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, 'some-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'working')
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content)
    }
    return dir
  }

  it('reads the verifier command', async () => {
    const task = await parseTask(await makeTaskDir({ VERIFY: 'npm test -- cities\n' }))
    expect(task?.verifier).toBe('npm test -- cities')
  })

  it('reads a non-command verifier target', async () => {
    const task = await parseTask(await makeTaskDir({ VERIFY: 'matches mocks/sydney.png' }))
    expect(task?.verifier).toBe('matches mocks/sydney.png')
  })

  it('takes only the first line when the file has trailing notes', async () => {
    const task = await parseTask(await makeTaskDir({ VERIFY: 'npm test -- cities\nadded by planning\n' }))
    expect(task?.verifier).toBe('npm test -- cities')
  })

  it('is null when VERIFY is absent — the task has no verifier', async () => {
    const task = await parseTask(await makeTaskDir({}))
    expect(task?.verifier).toBeNull()
  })

  it('is null when VERIFY is blank', async () => {
    const task = await parseTask(await makeTaskDir({ VERIFY: '   \n' }))
    expect(task?.verifier).toBeNull()
  })
})

describe('parseTask findings + TRIAGE.json', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-findings-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, 'some-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'working')
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content)
    }
    return dir
  }

  const REVIEW = `### Must Fix (1)\n- [Category] Fix this — \`a.ts:1\`\n\n### Should Fix (1)\n- [Category] Consider this — \`b.ts:2\`\n\n**Verdict: CHANGES REQUIRED**\n`

  it('defaults to must-selected/should-unselected when TRIAGE.json is absent', async () => {
    const task = await parseTask(await makeTaskDir({ 'task-pr-review.md': REVIEW }))
    expect(task?.findings).toEqual([
      { severity: 'must', category: 'Category', description: 'Fix this', location: 'a.ts:1', selected: true },
      { severity: 'should', category: 'Category', description: 'Consider this', location: 'b.ts:2', selected: false },
    ])
  })

  it('merges the persisted selection from TRIAGE.json', async () => {
    const task = await parseTask(await makeTaskDir({
      'task-pr-review.md': REVIEW,
      'TRIAGE.json': JSON.stringify({ selected: [1] }),
    }))
    expect(task?.findings.map((f) => f.selected)).toEqual([false, true])
  })

  it('is an empty array when there is no review yet', async () => {
    const task = await parseTask(await makeTaskDir({}))
    expect(task?.findings).toEqual([])
  })

  it('is an empty array when TRIAGE.json is malformed', async () => {
    const task = await parseTask(await makeTaskDir({
      'task-pr-review.md': REVIEW,
      'TRIAGE.json': '{ not json',
    }))
    // Malformed TRIAGE.json falls back to null selection (default), not a crash.
    expect(task?.findings.map((f) => f.selected)).toEqual([true, false])
  })
})

describe('buildSessions', () => {
  const snap = (contextPct: number, inputTokens: number, outputTokens: number) =>
    JSON.stringify({ contextPct, inputTokens, outputTokens })

  it('orders snapshots oldest first with the live session last', () => {
    const sessions = buildSessions(
      [{ n: 2, raw: snap(87, 200, 20) }, { n: 1, raw: snap(91, 100, 10) }],
      { contextPct: 44, inputTokens: 50, outputTokens: 5 },
    )
    expect(sessions.map((s) => s.n)).toEqual([1, 2, 3])
    expect(sessions.map((s) => s.contextPct)).toEqual([91, 87, 44])
    expect(sessions.at(-1)?.current).toBe(true)
    expect(sessions.slice(0, -1).every((s) => !s.current)).toBe(true)
  })

  it('returns just the live session when there have been no handovers', () => {
    expect(buildSessions([], { contextPct: 19, inputTokens: 30, outputTokens: 1 })).toEqual([
      { n: 1, contextPct: 19, inputTokens: 30, outputTokens: 1, current: true,
        stage: null, sessionId: null, startedAt: null, updatedAt: null },
    ])
  })

  it('returns an empty array when there is no METRICS file and no snapshots', () => {
    expect(buildSessions([], null)).toEqual([])
  })

  it('keeps completed sessions when the live METRICS file is missing', () => {
    const sessions = buildSessions([{ n: 1, raw: snap(91, 100, 10) }], null)
    expect(sessions).toEqual([
      { n: 1, contextPct: 91, inputTokens: 100, outputTokens: 10, current: false,
        stage: null, sessionId: null, startedAt: null, updatedAt: null },
    ])
  })

  it('skips malformed snapshot JSON rather than throwing', () => {
    const sessions = buildSessions([{ n: 1, raw: '{ not json' }, { n: 2, raw: snap(80, 10, 1) }], null)
    expect(sessions.map((s) => s.n)).toEqual([2])
  })

  it('reads a null contextPct when the snapshot omits it', () => {
    const sessions = buildSessions([{ n: 1, raw: JSON.stringify({ inputTokens: 5, outputTokens: 1 }) }], null)
    expect(sessions[0].contextPct).toBeNull()
  })

  const NOW = Date.parse('2026-08-08T12:00:00Z')
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  const perSessionFile = (id: string, fields: Record<string, unknown>) => ({
    file: `METRICS-${id}.json`,
    raw: JSON.stringify({ sessionId: id, ...fields }),
  })

  it('orders per-session files by startedAt, and none of them clobber each other', () => {
    const sessions = buildSessions([], null, [
      perSessionFile('bbb', { stage: 'qa', contextPct: 44, inputTokens: 50, outputTokens: 5,
        startedAt: ago(3_600_000), updatedAt: ago(1_800_000) }),
      perSessionFile('aaa', { stage: 'dev', contextPct: 88, inputTokens: 900, outputTokens: 90,
        startedAt: ago(7_200_000), updatedAt: ago(5_400_000) }),
    ], NOW)

    expect(sessions.map((s) => s.sessionId)).toEqual(['aaa', 'bbb'])
    expect(sessions.map((s) => s.stage)).toEqual(['dev', 'qa'])
    expect(sessions.map((s) => s.n)).toEqual([1, 2])
    expect(sessions.map((s) => s.inputTokens)).toEqual([900, 50])
  })

  it('records a null stage for a session started without COCKPIT_STAGE', () => {
    const sessions = buildSessions([], null, [
      perSessionFile('aaa', { contextPct: 10, inputTokens: 1, outputTokens: 1, startedAt: ago(60_000), updatedAt: ago(60_000) }),
    ], NOW)
    expect(sessions[0].stage).toBeNull()
  })

  it('ignores a stage value that is not one of the eight pipeline stages', () => {
    const sessions = buildSessions([], null, [
      perSessionFile('aaa', { stage: 'brainstorming', startedAt: ago(60_000), updatedAt: ago(60_000) }),
    ], NOW)
    expect(sessions[0].stage).toBeNull()
  })

  it('marks the newest-updated session live only inside the staleness window', () => {
    const fresh = buildSessions([], null, [
      perSessionFile('old', { startedAt: ago(7_200_000), updatedAt: ago(3_600_000) }),
      perSessionFile('new', { startedAt: ago(600_000), updatedAt: ago(60_000) }),
    ], NOW)
    expect(fresh.map((s) => s.current)).toEqual([false, true])

    const stale = buildSessions([], null, [
      perSessionFile('old', { startedAt: ago(7_200_000), updatedAt: ago(3_600_000) }),
      perSessionFile('new', { startedAt: ago(600_000), updatedAt: ago(LIVE_SESSION_WINDOW_MS + 1000) }),
    ], NOW)
    expect(stale.every((s) => !s.current)).toBe(true)
  })

  it('parses legacy handover snapshots and per-session files side by side', () => {
    const sessions = buildSessions(
      [{ n: 1, raw: snap(91, 100, 10) }],
      null,
      [perSessionFile('1d1b2f14-72ff-48a3', { stage: 'qa', contextPct: 44, inputTokens: 50, outputTokens: 5,
        startedAt: ago(600_000), updatedAt: ago(60_000) })],
      NOW,
    )
    expect(sessions.map((s) => s.n)).toEqual([1, 2])
    expect(sessions[0].sessionId).toBeNull()          // legacy handover snapshot
    expect(sessions[1].sessionId).toBe('1d1b2f14-72ff-48a3')
    expect(sessions[1].stage).toBe('qa')
  })

  it('drops the legacy METRICS file once per-session files exist, so nothing is double counted', () => {
    const sessions = buildSessions(
      [],
      { contextPct: 44, inputTokens: 50, outputTokens: 5 },  // the duplicate both writers emit
      [perSessionFile('aaa', { contextPct: 44, inputTokens: 50, outputTokens: 5,
        startedAt: ago(600_000), updatedAt: ago(60_000) })],
      NOW,
    )
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('aaa')
  })

  it('falls back to the filename when the JSON omits sessionId', () => {
    const sessions = buildSessions([], null, [
      { file: 'METRICS-abc-def.json', raw: JSON.stringify({ inputTokens: 1, outputTokens: 1 }) },
    ], NOW)
    expect(sessions[0].sessionId).toBe('abc-def')
  })

  it('skips a half-written per-session file rather than throwing', () => {
    const sessions = buildSessions([], null, [
      { file: 'METRICS-aaa.json', raw: '{ not json' },
      perSessionFile('bbb', { inputTokens: 2, outputTokens: 1, startedAt: ago(60_000), updatedAt: ago(60_000) }),
    ], NOW)
    expect(sessions.map((s) => s.sessionId)).toEqual(['bbb'])
  })
})

describe('newestSnapshot', () => {
  it('returns the legacy METRICS content when there are no per-session files', () => {
    const current = { contextPct: 44, model: 'claude-opus-5', inputTokens: 5, outputTokens: 1 }
    expect(newestSnapshot(current, [])).toEqual(current)
  })

  it('returns null when there is nothing at all', () => {
    expect(newestSnapshot(null, [])).toBeNull()
  })

  it('prefers the newest-updated per-session file over the legacy METRICS file', () => {
    const out = newestSnapshot({ contextPct: 1, model: 'stale', inputTokens: 0, outputTokens: 0 }, [
      { file: 'METRICS-a.json', raw: JSON.stringify({ contextPct: 20, model: 'older', updatedAt: '2026-08-08T10:00:00Z' }) },
      { file: 'METRICS-b.json', raw: JSON.stringify({ contextPct: 70, model: 'newer', updatedAt: '2026-08-08T11:00:00Z' }) },
    ])
    expect(out?.contextPct).toBe(70)
    expect(out?.model).toBe('newer')
  })

  it('skips malformed per-session files when picking the newest', () => {
    const out = newestSnapshot(null, [
      { file: 'METRICS-a.json', raw: '{ not json' },
      { file: 'METRICS-b.json', raw: JSON.stringify({ contextPct: 33, updatedAt: '2026-08-08T11:00:00Z' }) },
    ])
    expect(out?.contextPct).toBe(33)
  })
})

describe('parseTask METRICS totals', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-metrics-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // Every case needs a task dir with a STATUS file; only the METRICS files vary.
  async function makeTaskDir(files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, 'some-task')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'working')
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content)
    }
    return dir
  }

  it('sums the live METRICS file with all METRICS-N.json snapshots', async () => {
    const task = await parseTask(await makeTaskDir({
      METRICS: JSON.stringify({ contextPct: 44, inputTokens: 50, outputTokens: 5 }),
      'METRICS-1.json': JSON.stringify({ contextPct: 91, inputTokens: 100, outputTokens: 10 }),
      'METRICS-2.json': JSON.stringify({ contextPct: 87, inputTokens: 200, outputTokens: 20 }),
    }))
    expect(task?.totalInputTokens).toBe(50 + 100 + 200)
    expect(task?.totalOutputTokens).toBe(5 + 10 + 20)
    expect(task?.sessions.map((s) => s.n)).toEqual([1, 2, 3])
    expect(task?.sessions.at(-1)?.current).toBe(true)
  })

  it('sums only the snapshots when there is no live METRICS file', async () => {
    const task = await parseTask(await makeTaskDir({
      'METRICS-1.json': JSON.stringify({ contextPct: 91, inputTokens: 100, outputTokens: 10 }),
    }))
    expect(task?.totalInputTokens).toBe(100)
    expect(task?.totalOutputTokens).toBe(10)
  })

  const perSession = (fields: Record<string, unknown>) => JSON.stringify(fields)

  it('reads per-session files and sums them', async () => {
    const task = await parseTask(await makeTaskDir({
      'METRICS-1d1b2f14-72ff.json': perSession({
        sessionId: '1d1b2f14-72ff', stage: 'dev', contextPct: 88, model: 'claude-opus-5',
        inputTokens: 900, outputTokens: 90,
        startedAt: '2026-08-08T09:00:00Z', updatedAt: '2026-08-08T10:00:00Z',
      }),
      'METRICS-9a3c1e00-4411.json': perSession({
        sessionId: '9a3c1e00-4411', stage: 'qa', contextPct: 12, model: 'claude-opus-5',
        inputTokens: 50, outputTokens: 5,
        startedAt: '2026-08-08T11:00:00Z', updatedAt: '2026-08-08T11:30:00Z',
      }),
    }))
    expect(task?.totalInputTokens).toBe(950)
    expect(task?.totalOutputTokens).toBe(95)
    expect(task?.sessions.map((s) => s.stage)).toEqual(['dev', 'qa'])
  })

  it('takes contextPct and model from the newest-updated session', async () => {
    const task = await parseTask(await makeTaskDir({
      'METRICS-aaa-111.json': perSession({ contextPct: 88, model: 'older', updatedAt: '2026-08-08T10:00:00Z' }),
      'METRICS-bbb-222.json': perSession({ contextPct: 12, model: 'newer', updatedAt: '2026-08-08T11:30:00Z' }),
    }))
    expect(task?.contextPct).toBe(12)
    expect(task?.model).toBe('newer')
  })

  it('does not double count the legacy METRICS file alongside a per-session file', async () => {
    // Both writers emit METRICS and the session's own file in the same breath.
    const body = { contextPct: 44, inputTokens: 50, outputTokens: 5, updatedAt: '2026-08-08T11:30:00Z' }
    const task = await parseTask(await makeTaskDir({
      METRICS: JSON.stringify(body),
      'METRICS-aaa-111.json': perSession({ sessionId: 'aaa-111', ...body }),
    }))
    expect(task?.totalInputTokens).toBe(50)
    expect(task?.sessions).toHaveLength(1)
  })

  it('keeps legacy handover snapshots alongside per-session files', async () => {
    const task = await parseTask(await makeTaskDir({
      'METRICS-1.json': JSON.stringify({ contextPct: 91, inputTokens: 100, outputTokens: 10 }),
      'METRICS-aaa-111.json': perSession({ sessionId: 'aaa-111', inputTokens: 50, outputTokens: 5, updatedAt: '2026-08-08T11:30:00Z' }),
    }))
    expect(task?.totalInputTokens).toBe(150)
    expect(task?.sessions.map((s) => s.sessionId)).toEqual([null, 'aaa-111'])
  })
})

describe('parseMilestonesContent', () => {
  const WELL_FORMED = `# Overlap sharing

## Milestones
- M0: Rename + Vercel — needs: none — est: 2h
- M1: Config foundation — needs: M0 — est: 4h
- M4: Schedule — needs: M2, M3 — est: 5h

## Dependencies & Risks
- M9: not a milestone, this is a different section
`

  it('parses a well-formed section', () => {
    expect(parseMilestonesContent(WELL_FORMED)).toEqual([
      { id: 'M0', name: 'Rename + Vercel', needs: [], estimate: '2h', specFile: null },
      { id: 'M1', name: 'Config foundation', needs: ['M0'], estimate: '4h', specFile: null },
      { id: 'M4', name: 'Schedule', needs: ['M2', 'M3'], estimate: '5h', specFile: null },
    ])
  })

  it('stops at the next heading, whatever its level', () => {
    expect(parseMilestonesContent(WELL_FORMED).map((m) => m.id)).not.toContain('M9')
  })

  it('accepts the ### heading level the shipped template uses', () => {
    const raw = '### Milestones\n- M0: Only one — needs: none — est: 1h\n'
    expect(parseMilestonesContent(raw)).toEqual([
      { id: 'M0', name: 'Only one', needs: [], estimate: '1h', specFile: null },
    ])
  })

  it('treats a missing needs: the same as needs: none', () => {
    expect(parseMilestonesContent('## Milestones\n- M0: Bare — est: 2h\n')[0].needs).toEqual([])
  })

  it('reads a missing estimate as null', () => {
    expect(parseMilestonesContent('## Milestones\n- M0: Bare — needs: none\n')[0].estimate).toBeNull()
  })

  it('accepts needs: and est: in either order', () => {
    expect(parseMilestonesContent('## Milestones\n- M1: Swapped — est: 3h — needs: M0\n')).toEqual([
      { id: 'M1', name: 'Swapped', needs: ['M0'], estimate: '3h', specFile: null },
    ])
  })

  it('parses a spec: field alongside needs:/est:, in any position', () => {
    const raw = '## Milestones\n- M0: Tokens — needs: none — est: 1h — spec: e2e/brand.spec.ts\n'
    expect(parseMilestonesContent(raw)[0].specFile).toBe('e2e/brand.spec.ts')
  })

  it('reads a missing spec: as null', () => {
    expect(parseMilestonesContent('## Milestones\n- M0: Bare — needs: none\n')[0].specFile).toBeNull()
  })

  it('upper-cases dependency ids so m0 and M0 are the same milestone', () => {
    expect(parseMilestonesContent('## Milestones\n- m1: Lower — needs: m0\n')).toEqual([
      { id: 'M1', name: 'Lower', needs: ['M0'], estimate: null, specFile: null },
    ])
  })

  it('skips lines that are not milestone bullets rather than throwing', () => {
    const raw = `## Milestones
Split the UI Description into a deliverable milestones
- not a milestone at all
- MX: letters are not a milestone number
- M0: Real one — needs: none — est: 2h
`
    expect(parseMilestonesContent(raw)).toEqual([
      { id: 'M0', name: 'Real one', needs: [], estimate: '2h', specFile: null },
    ])
  })

  it('keeps the first declaration when an id is repeated', () => {
    const raw = '## Milestones\n- M0: First — est: 1h\n- M0: Second — est: 9h\n'
    expect(parseMilestonesContent(raw)).toEqual([
      { id: 'M0', name: 'First', needs: [], estimate: '1h', specFile: null },
    ])
  })

  it('returns an empty array when there is no Milestones section', () => {
    expect(parseMilestonesContent('# Just a doc\n\n## Components\n- a thing\n')).toEqual([])
  })

  it('returns an empty array for an empty document', () => {
    expect(parseMilestonesContent('')).toEqual([])
  })

  it('ignores a Milestones heading and bullets inside a fenced code block', () => {
    // The real-world case: a plan doc that documents this very format (like
    // the milestone fan-out plan itself) illustrates "## Milestones" inside
    // a ```markdown example. That example must not be read as this task's
    // own declarations once such a doc is copied into tech-design.md.
    const raw = `# Some plan

Here is the format:

\`\`\`markdown
## Milestones
- M0: Example only — needs: none — est: 2h
\`\`\`

## Milestones
- M7: The real one — needs: none — est: 3h
`
    expect(parseMilestonesContent(raw)).toEqual([
      { id: 'M7', name: 'The real one', needs: [], estimate: '3h', specFile: null },
    ])
  })

  it('resumes normal parsing after a fenced code block closes', () => {
    const raw = `## Milestones
\`\`\`
- M0: Inside a fence, not a real bullet
\`\`\`
- M1: After the fence — needs: none — est: 1h
`
    expect(parseMilestonesContent(raw)).toEqual([
      { id: 'M1', name: 'After the fence', needs: [], estimate: '1h', specFile: null },
    ])
  })

  it('tolerates an unclosed fence rather than hanging or throwing', () => {
    const raw = '## Milestones\n```\n- M0: Never closes\n'
    expect(parseMilestonesContent(raw)).toEqual([])
  })
})

describe('parseSummarySection', () => {
  it('reads a ## Summary heading', () => {
    const raw = '# Plan\n\n## Summary\nWhat this plan does and why.\n\n## Design\nDetails.\n'
    expect(parseSummarySection(raw)).toBe('What this plan does and why.')
  })

  it('reads the ### heading level too', () => {
    const raw = '# Plan\n\n### Summary\nShort brief.\n'
    expect(parseSummarySection(raw)).toBe('Short brief.')
  })

  it('stops at the next heading, whatever its level', () => {
    const raw = '## Summary\nFirst paragraph.\n\nSecond paragraph.\n#### Not part of it\nOther content.\n'
    expect(parseSummarySection(raw)).toBe('First paragraph.\n\nSecond paragraph.')
  })

  it('returns null when there is no Summary section', () => {
    expect(parseSummarySection('# Plan\n\n## Approach\nNo summary here.\n')).toBeNull()
  })

  it('returns null for an empty section', () => {
    expect(parseSummarySection('## Summary\n\n## Design\nDetails.\n')).toBeNull()
  })

  it('ignores a ## Summary heading inside a fenced code block', () => {
    const raw = '# Plan\n\n```markdown\n## Summary\nExample only.\n```\n\n## Design\nDetails.\n'
    expect(parseSummarySection(raw)).toBeNull()
  })
})

describe('stripSummarySection', () => {
  it('removes the heading and its body', () => {
    const raw = '# Plan\n\n## Summary\nWhat this plan does.\n\n## Design\nDetails.\n'
    expect(stripSummarySection(raw)).toBe('# Plan\n\n## Design\nDetails.\n')
  })

  it('is a no-op when there is no Summary section', () => {
    const raw = '# Plan\n\n## Design\nDetails.\n'
    expect(stripSummarySection(raw)).toBe(raw)
  })
})

describe('parseQaSpecFile', () => {
  it('reads a single backtick-quoted path off the QA Spec line', () => {
    const raw = '# Some plan\n\n**QA Spec:** `e2e/pipelinely-brand.spec.ts`\n'
    expect(parseQaSpecFile(raw)).toBe('e2e/pipelinely-brand.spec.ts')
  })

  it('joins multiple comma/and-separated paths into one string', () => {
    const raw = '**QA Spec:** `e2e/a.spec.ts`, `e2e/b.spec.ts`, and `e2e/c.spec.ts`\n'
    expect(parseQaSpecFile(raw)).toBe('e2e/a.spec.ts, e2e/b.spec.ts, e2e/c.spec.ts')
  })

  it('is null when the doc has no QA Spec line', () => {
    expect(parseQaSpecFile('# Just a doc\n\nNo spec line here.\n')).toBeNull()
  })

  it('is null for an empty document', () => {
    expect(parseQaSpecFile('')).toBeNull()
  })
})

describe('parseQaCaseTitles', () => {
  it('extracts every test() title in file order', () => {
    const raw = `
import { test, expect } from '@playwright/test'
test.describe('pipelinely rebrand', () => {
  test('the browser tab title and the header wordmark both read pipelinely.cc', async ({ page }) => {})
  test("a waiting-task count prefixes the title", async ({ page }) => {})
})
`
    expect(parseQaCaseTitles(raw)).toEqual([
      'the browser tab title and the header wordmark both read pipelinely.cc',
      'a waiting-task count prefixes the title',
    ])
  })

  it('includes test.only and test.skip titles', () => {
    const raw = `test.only('focused case', () => {})\ntest.skip('skipped case', () => {})\n`
    expect(parseQaCaseTitles(raw)).toEqual(['focused case', 'skipped case'])
  })

  it('returns an empty array when the file has no test() calls', () => {
    expect(parseQaCaseTitles('test.describe("wrapper", () => {})\n')).toEqual([])
  })
})

describe('computeMilestones', () => {
  const decl = (id: string, needs: string[] = []): MilestoneDecl =>
    ({ id, name: `${id} thing`, needs, estimate: null, specFile: null })

  // A Task is a wide interface and only three fields matter here, so build
  // the rest once rather than in every case.
  const task = (slug: string, status: Task['status']): Task => ({
    slug, title: slug, mode: '', repo: 'overlap', branch: '', worktree: null,
    devUrl: null, verifier: null, itermSessionId: null, tmuxSession: null,
    plan: null, stageHistory: [], stage: null, findings: [], findingsParseMismatch: [],
    qaFailures: [], qaCases: [], qaCasesParseMismatch: [],
    status, updatedAt: new Date(0), completedAt: null, completedAtSource: null,
    totalInputTokens: 0, totalOutputTokens: 0, sessions: [],
    showsOnBoard: true, attentionStatus: 'idle',
    autoModeOverride: 'inherit', autoMode: false,
  })

  it('puts every root milestone in wave 1', () => {
    const out = computeMilestones([decl('M0'), decl('M5')], 'overlap', [])
    expect(out.map((m) => m.wave)).toEqual([1, 1])
  })

  it('layers a simple chain one wave per link', () => {
    const out = computeMilestones(
      [decl('M0'), decl('M1', ['M0']), decl('M2', ['M1'])], 'overlap', [])
    expect(out.map((m) => m.wave)).toEqual([1, 2, 3])
  })

  it('puts a fan-out sharing one dependency in the same wave', () => {
    const out = computeMilestones(
      [decl('M0'), decl('M1', ['M0']), decl('M2', ['M1']), decl('M3', ['M1'])], 'overlap', [])
    expect(out.map((m) => `${m.id}:${m.wave}`)).toEqual(['M0:1', 'M1:2', 'M2:3', 'M3:3'])
  })

  it('puts a diamond convergence after the LATER blocker, not the earlier one', () => {
    // M4 needs M2 (wave 3) and M3 (wave 2) — longest path must win.
    const out = computeMilestones([
      decl('M0'), decl('M1', ['M0']), decl('M2', ['M1']),
      decl('M3', ['M0']), decl('M4', ['M2', 'M3']),
    ], 'overlap', [])
    const wave = (id: string) => out.find((m) => m.id === id)!.wave
    expect(wave('M2')).toBe(3)
    expect(wave('M3')).toBe(2)
    expect(wave('M4')).toBe(4)
  })

  it('marks a milestone with no dispatched child as queued', () => {
    const out = computeMilestones([decl('M0')], 'overlap', [])
    expect(out[0].state).toBe('queued')
    expect(out[0].task).toBeNull()
  })

  it('marks a milestone with a live child as dispatched and attaches it', () => {
    const child = task('overlap-m0', 'working')
    const out = computeMilestones([decl('M0')], 'overlap', [child])
    expect(out[0].state).toBe('dispatched')
    expect(out[0].task?.slug).toBe('overlap-m0')
  })

  it('marks a milestone whose child is done as done', () => {
    const out = computeMilestones([decl('M0')], 'overlap', [task('overlap-m0', 'done')])
    expect(out[0].state).toBe('done')
  })

  it('does not match a child belonging to a different parent', () => {
    const out = computeMilestones([decl('M0')], 'overlap', [task('other-overlap-m0', 'working')])
    expect(out[0].state).toBe('queued')
  })

  it('skips a needs: id nothing declares rather than throwing', () => {
    const out = computeMilestones([decl('M1', ['M9'])], 'overlap', [])
    expect(out[0].wave).toBe(1)
    expect(out[0].needs).toEqual(['M9']) // the declaration is preserved verbatim
  })

  it('does not hang on a dependency cycle', () => {
    const out = computeMilestones([decl('M0', ['M1']), decl('M1', ['M0'])], 'overlap', [])
    expect(out).toHaveLength(2)
    expect(out.every((m) => m.wave >= 1)).toBe(true)
  })

  it('returns an empty array for no declarations', () => {
    expect(computeMilestones([], 'overlap', [])).toEqual([])
  })
})

describe('parseTask milestones', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-milestones-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  async function makeTaskDir(name: string, files: Record<string, string>): Promise<string> {
    const dir = path.join(tmpDir, name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'STATUS'), 'working')
    for (const [file, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, file), content)
    }
    return dir
  }

  const TECH_DESIGN = `# Overlap sharing

## Milestones
- M0: Rename — needs: none — est: 2h
- M1: Config — needs: M0 — est: 4h
`

  it('reads the declared milestones off tech-design.md', async () => {
    const task = await parseTask(await makeTaskDir('overlap', { 'tech-design.md': TECH_DESIGN }))
    expect(task?.milestones?.map((m) => `${m.id}:${m.wave}:${m.state}`)).toEqual([
      'M0:1:queued', 'M1:2:queued',
    ])
  })

  it("reads a flat task's own QA Spec line into qaSpecFile", async () => {
    const task = await parseTask(await makeTaskDir('flat-task', {
      'tech-design.md': '# A plan\n\n**QA Spec:** `e2e/flat-task.spec.ts`\n',
    }))
    expect(task?.qaSpecFile).toBe('e2e/flat-task.spec.ts')
  })

  it('leaves qaSpecFile null for a flat task with no QA Spec line', async () => {
    const task = await parseTask(await makeTaskDir('flat-task-2', { 'tech-design.md': '# A plan\n' }))
    expect(task?.qaSpecFile).toBeNull()
  })

  it('leaves milestones undefined when there is no tech-design.md — the pre-existing task dir case', async () => {
    const task = await parseTask(await makeTaskDir('legacy', {}))
    expect(task?.milestones).toBeUndefined()
    // and nothing else about the task changed: still the flat pipeline
    expect(task?.stage).toBe('dev')
  })

  it('leaves milestones undefined when tech-design.md declares no Milestones section', async () => {
    const task = await parseTask(await makeTaskDir('planned', {
      'tech-design.md': '# A plan\n\n## Components\n- a thing\n',
    }))
    expect(task?.milestones).toBeUndefined()
  })

  it('still resolves stage plan-review from a tech-design.md with no milestones', async () => {
    // hasTechDesign now comes from reading the file rather than fs.access —
    // this is the assertion that the swap did not change computeStage's input.
    const task = await parseTask(await makeTaskDir('planned', { 'tech-design.md': '# A plan\n' }))
    expect(task?.stage).toBe('plan-review')
  })

  it('treats an empty tech-design.md as present, exactly as fs.access did', async () => {
    const task = await parseTask(await makeTaskDir('planned', { 'tech-design.md': '' }))
    expect(task?.stage).toBe('plan-review')
    expect(task?.milestones).toBeUndefined()
  })

  it('stitches dispatched children onto the parent in parseAllTasks', async () => {
    await makeTaskDir('overlap', { 'tech-design.md': TECH_DESIGN })
    await makeTaskDir('overlap-m0', {})
    await fs.writeFile(path.join(tmpDir, 'overlap-m0', 'STATUS'), 'done')

    const tasks = await parseAllTasks(tmpDir)
    const parent = tasks.find((t) => t.slug === 'overlap')
    expect(parent?.milestones?.map((m) => m.state)).toEqual(['done', 'queued'])
    expect(parent?.milestones?.[0].task?.slug).toBe('overlap-m0')
    // The child is still a task in its own right — once dispatched it also
    // renders as its own ordinary top-level card (Task 9), not something
    // this second pass hides.
    expect(tasks.some((t) => t.slug === 'overlap-m0')).toBe(true)
  })

  it("stitches the parent's title onto a dispatched child as projectTitle", async () => {
    await makeTaskDir('overlap', { 'tech-design.md': TECH_DESIGN })
    await fs.writeFile(path.join(tmpDir, 'overlap', 'TASK.md'), '# Overlap · meeting scheduler\n')
    await makeTaskDir('overlap-m0', {})

    const tasks = await parseAllTasks(tmpDir)
    const child = tasks.find((t) => t.slug === 'overlap-m0')
    expect(child?.projectTitle).toBe('Overlap · meeting scheduler')
  })

  it("stitches the parent's declared spec: field onto a dispatched child as qaSpecFile", async () => {
    const techDesignWithSpec = `# Overlap sharing

## Milestones
- M0: Rename — needs: none — est: 2h — spec: e2e/rename.spec.ts
- M1: Config — needs: M0 — est: 4h
`
    await makeTaskDir('overlap', { 'tech-design.md': techDesignWithSpec })
    await makeTaskDir('overlap-m0', {})
    await makeTaskDir('overlap-m1', {})

    const tasks = await parseAllTasks(tmpDir)
    expect(tasks.find((t) => t.slug === 'overlap-m0')?.qaSpecFile).toBe('e2e/rename.spec.ts')
    expect(tasks.find((t) => t.slug === 'overlap-m1')?.qaSpecFile).toBeNull()
  })

  // Bug 2 (fix-qa-cr-bullet-format-gap): a milestone child has no
  // tech-design.md of its own, so parseTask on its own directory used to
  // leave qaSpecFile null unconditionally — only parseAllTasks's second
  // pass (once the whole task list, parent included, is visible) ever
  // resolved it. These exercise parseTask standalone, on just the child's
  // own directory, to confirm the fallback reads the parent's tech-design.md
  // directly rather than depending on that second pass.
  it("resolves qaSpecFile from the parent's tech-design.md when parsed standalone (not via parseAllTasks)", async () => {
    const techDesignWithSpec = `# Overlap sharing

## Milestones
- M0: Rename — needs: none — est: 2h — spec: e2e/rename.spec.ts
- M1: Config — needs: M0 — est: 4h
`
    await makeTaskDir('overlap', { 'tech-design.md': techDesignWithSpec })
    const childDir = await makeTaskDir('overlap-m0', {})

    const task = await parseTask(childDir)
    expect(task?.qaSpecFile).toBe('e2e/rename.spec.ts')
  })

  it('leaves qaSpecFile null when the milestone child has no spec of its own to resolve, standalone or not', async () => {
    await makeTaskDir('overlap', { 'tech-design.md': TECH_DESIGN }) // M0/M1, neither declares spec:
    const childDir = await makeTaskDir('overlap-m0', {})

    const task = await parseTask(childDir)
    expect(task?.qaSpecFile).toBeNull()
  })

  it('leaves qaSpecFile null for a milestone child whose parent has no tech-design.md at all', async () => {
    const childDir = await makeTaskDir('overlap-m0', {})
    const task = await parseTask(childDir)
    expect(task?.qaSpecFile).toBeNull()
  })

  it('leaves projectTitle undefined for a plain task and for a parent itself', async () => {
    await makeTaskDir('overlap', { 'tech-design.md': TECH_DESIGN })
    await makeTaskDir('overlap-m0', {})
    await makeTaskDir('unrelated', {})

    const tasks = await parseAllTasks(tmpDir)
    expect(tasks.find((t) => t.slug === 'overlap')?.projectTitle).toBeUndefined()
    expect(tasks.find((t) => t.slug === 'unrelated')?.projectTitle).toBeUndefined()
  })
})

describe('shouldShowOnBoard', () => {
  function ms(id: string, state: MilestoneStatus['state'], needs: string[] = []): MilestoneStatus {
    return { id, name: id, needs, estimate: null, specFile: null, wave: 1, state, task: null }
  }

  it('always shows a plain task with no declared milestones', () => {
    expect(shouldShowOnBoard({ slug: 'plain', milestones: undefined } as Task)).toBe(true)
  })

  it('shows a milestone-declaring parent while any milestone is still queued', () => {
    const task = { slug: 'overlap', milestones: [ms('M0', 'done'), ms('M1', 'queued')] } as Task
    expect(shouldShowOnBoard(task)).toBe(true)
  })

  it('hides a milestone-declaring parent once nothing remains queued', () => {
    const task = { slug: 'overlap', milestones: [ms('M0', 'done'), ms('M1', 'dispatched')] } as Task
    expect(shouldShowOnBoard(task)).toBe(false)
  })

  it('always shows a milestone child regardless of its own state, or whether it declares milestones itself', () => {
    expect(shouldShowOnBoard({ slug: 'overlap-m0', milestones: undefined } as Task)).toBe(true)
  })
})

describe('computeAttentionStatus', () => {
  function ms(id: string, state: MilestoneStatus['state'], needs: string[] = []): MilestoneStatus {
    return { id, name: id, needs, estimate: null, specFile: null, wave: 1, state, task: null }
  }

  function baseTask(overrides: Partial<Task> = {}): Task {
    return {
      slug: 'a', status: 'working', itermSessionId: null, qaFailures: [], findings: [],
      milestones: undefined, ...overrides,
    } as Task
  }

  it('is "needs-you" when status is waiting, even if the session is live', () => {
    const task = baseTask({ status: 'waiting', itermSessionId: 'sess-1' })
    expect(computeAttentionStatus(task, new Set(['sess-1']))).toBe('needs-you')
  })

  it('is "needs-you" when status is waiting and no session is live', () => {
    const task = baseTask({ status: 'waiting', itermSessionId: 'sess-1' })
    expect(computeAttentionStatus(task, new Set())).toBe('needs-you')
  })

  it('is "working" when a live session exists, even with an unresolved QA/CR checklist', () => {
    const task = baseTask({
      status: 'working',
      itermSessionId: 'sess-1',
      qaFailures: [{ selected: true } as any],
    })
    expect(computeAttentionStatus(task, new Set(['sess-1']))).toBe('working')
  })

  it('is not "needs-you" for a done task carrying stale findings/QA failures from before it shipped', () => {
    const task = baseTask({
      status: 'done',
      qaFailures: [{ selected: true } as any],
      findings: [{ selected: true } as any],
    })
    expect(computeAttentionStatus(task, null)).toBe('idle')
  })

  it('is "needs-you" when there is an unresolved QA or CR checklist', () => {
    const task = baseTask({ status: 'working', qaFailures: [{ selected: true } as any] })
    expect(computeAttentionStatus(task, null)).toBe('needs-you')
  })

  it("is \"needs-you\" for a planning card whose queued milestone's deps are all done", () => {
    const task = baseTask({
      status: 'working',
      milestones: [ms('M0', 'done'), ms('M1', 'queued', ['M0'])],
    })
    expect(computeAttentionStatus(task, null)).toBe('needs-you')
  })

  it('is "idle" for the same shape when the queued milestone is still blocked', () => {
    const task = baseTask({
      status: 'working',
      milestones: [ms('M0', 'queued'), ms('M1', 'queued', ['M0'])],
    })
    expect(computeAttentionStatus(task, null)).toBe('idle')
  })

  it('is "idle" for a plain dispatched task with no live session and nothing pending', () => {
    expect(computeAttentionStatus(baseTask(), null)).toBe('idle')
  })

  it('is "paused" when status is paused, even if the session is live', () => {
    const task = baseTask({ status: 'paused', itermSessionId: 'sess-1' })
    expect(computeAttentionStatus(task, new Set(['sess-1']))).toBe('paused')
  })

  it('is "paused" when status is paused and no session is live', () => {
    const task = baseTask({ status: 'paused', itermSessionId: 'sess-1' })
    expect(computeAttentionStatus(task, new Set())).toBe('paused')
  })
})

describe('computeNextStageCta', () => {
  function waitingTask(waitingReason: string): Pick<Task, 'status' | 'waitingReason'> {
    return { status: 'waiting', waitingReason }
  }

  it('offers plan-review once planning wrote "plan ready for review"', () => {
    expect(computeNextStageCta(waitingTask('plan ready for review'))).toEqual({ stage: 'plan-review' })
  })

  it('offers dev once plan review wrote "plan reviewed, ready for dev"', () => {
    expect(computeNextStageCta(waitingTask('plan reviewed, ready for dev'))).toEqual({ stage: 'dev' })
  })

  it('offers code-review once dev wrote "PR open, ready for CR"', () => {
    expect(computeNextStageCta(waitingTask('PR open, ready for CR'))).toEqual({ stage: 'code-review' })
  })

  it('offers comment-fix once CR wrote "triage and dispatch cr-fixes"', () => {
    expect(computeNextStageCta(waitingTask('CR found 1 must-fix comments, triage and dispatch cr-fixes'))).toEqual({ stage: 'comment-fix' })
  })

  it('offers qa once CR wrote "CR approved, ready for QA"', () => {
    expect(computeNextStageCta(waitingTask('CR approved, ready for QA'))).toEqual({ stage: 'qa' })
  })

  it('offers qa once cr-fixes wrote "comments addressed, ready for QA"', () => {
    expect(computeNextStageCta(waitingTask('comments addressed, ready for QA'))).toEqual({ stage: 'qa' })
  })

  it('offers qa-fixes once QA wrote "triage and dispatch qa-fixes"', () => {
    expect(computeNextStageCta(waitingTask('QA found 2 issues, triage and dispatch qa-fixes'))).toEqual({ stage: 'qa-fixes' })
  })

  it('offers qa again once qa-fixes wrote "fixes pushed, ready to re-run QA"', () => {
    expect(computeNextStageCta(waitingTask('fixes pushed, ready to re-run QA'))).toEqual({ stage: 'qa' })
  })

  it('offers nothing once QA wrote "QA passed, ready to merge" — merge is never staged', () => {
    expect(computeNextStageCta(waitingTask('QA passed, ready to merge'))).toBeNull()
  })

  it('offers nothing when status is not waiting', () => {
    expect(computeNextStageCta({ status: 'working', waitingReason: undefined })).toBeNull()
  })

  it('offers nothing when the waiting reason matches none of the known markers (task.stage staleness case)', () => {
    expect(computeNextStageCta(waitingTask('need clarification on which repo to touch'))).toBeNull()
  })
})

describe('parseSettingsContent', () => {
  it('parses a valid settings file', () => {
    expect(parseSettingsContent('{"autoMode": true}')).toEqual({ autoMode: true })
    expect(parseSettingsContent('{"autoMode": false}')).toEqual({ autoMode: false })
  })

  it('falls back to DEFAULT_SETTINGS (auto off) for null (absent file)', () => {
    expect(parseSettingsContent(null)).toEqual(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.autoMode).toBe(false)
  })

  it('falls back to DEFAULT_SETTINGS for malformed JSON', () => {
    expect(parseSettingsContent('{not json')).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to DEFAULT_SETTINGS for JSON that is not an object', () => {
    expect(parseSettingsContent('true')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettingsContent('[1,2,3]')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettingsContent('"auto"')).toEqual(DEFAULT_SETTINGS)
  })

  it('falls back to DEFAULT_SETTINGS when autoMode is present but not a boolean', () => {
    expect(parseSettingsContent('{"autoMode": "true"}')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettingsContent('{"autoMode": 1}')).toEqual(DEFAULT_SETTINGS)
    expect(parseSettingsContent('{}')).toEqual(DEFAULT_SETTINGS)
  })
})

describe('readSettings', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cockpit-settings-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('reads and parses SETTINGS.json from the tasks dir', async () => {
    await fs.writeFile(path.join(tmpDir, 'SETTINGS.json'), '{"autoMode": true}')
    expect(await readSettings(tmpDir)).toEqual({ autoMode: true })
  })

  it('returns DEFAULT_SETTINGS when SETTINGS.json is absent', async () => {
    expect(await readSettings(tmpDir)).toEqual(DEFAULT_SETTINGS)
  })
})

describe('parseAutoModeOverride', () => {
  it('parses "auto" and "manual", case- and whitespace-insensitive', () => {
    expect(parseAutoModeOverride('auto')).toBe('auto')
    expect(parseAutoModeOverride('  auto  \n')).toBe('auto')
    expect(parseAutoModeOverride('AUTO')).toBe('auto')
    expect(parseAutoModeOverride('manual')).toBe('manual')
    expect(parseAutoModeOverride('  Manual\n')).toBe('manual')
    expect(parseAutoModeOverride('MANUAL')).toBe('manual')
  })

  it('is "inherit" for null, empty, or junk', () => {
    expect(parseAutoModeOverride(null)).toBe('inherit')
    expect(parseAutoModeOverride('')).toBe('inherit')
    expect(parseAutoModeOverride('   ')).toBe('inherit')
    expect(parseAutoModeOverride('yes')).toBe('inherit')
    expect(parseAutoModeOverride('inherit')).toBe('inherit')
  })
})

describe('computeEffectiveAutoMode', () => {
  it('override "auto" always wins', () => {
    expect(computeEffectiveAutoMode('auto', true)).toBe(true)
    expect(computeEffectiveAutoMode('auto', false)).toBe(true)
  })

  it('override "manual" always wins', () => {
    expect(computeEffectiveAutoMode('manual', true)).toBe(false)
    expect(computeEffectiveAutoMode('manual', false)).toBe(false)
  })

  it('override "inherit" follows the global default', () => {
    expect(computeEffectiveAutoMode('inherit', true)).toBe(true)
    expect(computeEffectiveAutoMode('inherit', false)).toBe(false)
  })
})

describe('MANUAL_ONLY_STAGES', () => {
  it('is exactly comment-fix and qa-fixes — the two triage stops', () => {
    expect([...MANUAL_ONLY_STAGES].sort()).toEqual(['comment-fix', 'qa-fixes'])
  })
})

describe('computeAutoDispatch', () => {
  function waitingTask(waitingReason: string): Pick<Task, 'status' | 'waitingReason'> {
    return { status: 'waiting', waitingReason }
  }

  it('drives every marker in NEXT_STAGE_BY_WAITING_REASON, plus the merge phrase which has no entry', () => {
    // Pins the table length so a ninth marker added later without an explicit
    // decision fails this test rather than silently defaulting to auto.
    expect(NEXT_STAGE_BY_WAITING_REASON.length).toBe(8)

    const cases: { marker: string; eligible: boolean }[] = [
      { marker: 'plan ready for review', eligible: true },
      { marker: 'plan reviewed, ready for dev', eligible: true },
      { marker: 'PR open, ready for CR', eligible: true },
      { marker: 'triage and dispatch cr-fixes', eligible: false },
      { marker: 'CR approved, ready for QA', eligible: true },
      { marker: 'comments addressed, ready for QA', eligible: true },
      { marker: 'triage and dispatch qa-fixes', eligible: false },
      { marker: 'fixes pushed, ready to re-run QA', eligible: true },
    ]
    expect(cases.length).toBe(NEXT_STAGE_BY_WAITING_REASON.length)

    for (const { marker, eligible } of cases) {
      const result = computeAutoDispatch(waitingTask(marker))
      if (eligible) {
        const expectedStage = NEXT_STAGE_BY_WAITING_REASON.find((m) => m.marker === marker)!.stage
        expect(result, `expected ${marker} to be auto-eligible`).toEqual({ stage: expectedStage, key: `${expectedStage}:${marker}` })
      } else {
        expect(result, `expected ${marker} to be manual-only`).toBeNull()
      }
    }
  })

  it('is null for the merge phrase, which has no NEXT_STAGE_BY_WAITING_REASON entry', () => {
    expect(computeAutoDispatch(waitingTask('QA passed, ready to merge'))).toBeNull()
  })

  it('is null when status is not waiting', () => {
    expect(computeAutoDispatch({ status: 'working', waitingReason: 'plan ready for review' })).toBeNull()
  })

  it('is null when waitingReason is empty', () => {
    expect(computeAutoDispatch({ status: 'waiting', waitingReason: '' })).toBeNull()
  })

  it('keys on the matched marker, not the raw status line — a decorated line keys the same as the bare marker', () => {
    const bare = computeAutoDispatch(waitingTask('PR open, ready for CR'))
    const decorated = computeAutoDispatch(waitingTask('round 2 — PR open, ready for CR (#41)'))
    expect(bare).not.toBeNull()
    expect(decorated).not.toBeNull()
    expect(decorated!.key).toBe(bare!.key)
  })
})

describe('isMilestoneReadyForDev', () => {
  function decl(id: string, needs: string[] = []): Pick<MilestoneStatus, 'needs' | 'state'> & { id: string } {
    return { id, needs, state: 'queued' }
  }

  const planReviewedHistory: StageEvent[] = [{ stage: 'plan-review', at: '2026-08-10T10:00:00Z', note: null }]
  const noPlanReviewHistory: StageEvent[] = [{ stage: 'planning', at: '2026-08-10T09:00:00Z', note: null }]

  it('is false when the milestone is not queued', () => {
    const m = { ...decl('M0'), state: 'dispatched' as const }
    const byId = new Map([['M0', m as MilestoneStatus]])
    expect(isMilestoneReadyForDev(m, byId, planReviewedHistory)).toBe(false)
  })

  it('is false when queued but the parent never reached plan-review', () => {
    const m = decl('M0')
    const byId = new Map([['M0', m as MilestoneStatus]])
    expect(isMilestoneReadyForDev(m, byId, noPlanReviewHistory)).toBe(false)
  })

  it('is false when queued, plan-review done, but a declared dependency is not done', () => {
    const m0 = { ...decl('M0'), state: 'queued' as const }
    const m1 = decl('M1', ['M0'])
    const byId = new Map([['M0', m0 as MilestoneStatus], ['M1', m1 as MilestoneStatus]])
    expect(isMilestoneReadyForDev(m1, byId, planReviewedHistory)).toBe(false)
  })

  it('is true when queued, plan-review done, and every declared dependency is done', () => {
    const m0 = { ...decl('M0'), state: 'done' as const }
    const m1 = decl('M1', ['M0'])
    const byId = new Map([['M0', m0 as MilestoneStatus], ['M1', m1 as MilestoneStatus]])
    expect(isMilestoneReadyForDev(m1, byId, planReviewedHistory)).toBe(true)
  })

  it('is true for a root milestone (empty needs) once plan-review is done', () => {
    const m0 = decl('M0')
    const byId = new Map([['M0', m0 as MilestoneStatus]])
    expect(isMilestoneReadyForDev(m0, byId, planReviewedHistory)).toBe(true)
  })
})

describe('composeStageCommand', () => {
  it('appends the slug when one is given', () => {
    expect(composeStageCommand('dev', 'my-task')).toBe('/pipelinely-dev my-task')
    expect(composeStageCommand('plan-review', 'my-task')).toBe('/pipelinely-plan-review my-task')
    expect(composeStageCommand('qa', 'my-task')).toBe('/pipelinely-qa my-task')
    expect(composeStageCommand('cr', 'my-task')).toBe('/pipelinely-cr my-task')
  })

  it('omits the slug entirely for the no-arg qa-fixes/cr-fixes form', () => {
    expect(composeStageCommand('qa-fixes', null)).toBe('/pipelinely-qa-fixes')
    expect(composeStageCommand('cr-fixes', null)).toBe('/pipelinely-cr-fixes')
  })
})

describe('STAGE_SKILL', () => {
  // merge has a real skill (pipelinely-merge) since pipelinely-merge-skill, but
  // deliberately no staged CTA/entry here — the Merge button already does
  // the merge in-process, one click, and a staged CTA would be a third path
  // to the same action (decision 2). This assertion stays unchanged.
  it('routes every stage except planning and merge, so a future stage cannot silently fall through unrouted', () => {
    const routed = STAGES.filter((s) => s !== 'planning' && s !== 'merge')
    for (const stage of routed) {
      expect(STAGE_SKILL[stage], `expected STAGE_SKILL to route ${stage}`).toBeDefined()
    }
    expect(STAGE_SKILL.planning).toBeUndefined()
    expect(STAGE_SKILL.merge).toBeUndefined()
  })
})

describe('SKIP_STAGE', () => {
  it('is scoped to exactly qa-fixes and comment-fix — nothing else has a "nothing to fix" dead end', () => {
    expect(Object.keys(SKIP_STAGE).sort()).toEqual(['comment-fix', 'qa-fixes'])
  })

  it('comment-fix\'s nextWaitingReason is a real marker computeNextStageCta already recognizes, landing on qa', () => {
    const waitingTask = { status: 'waiting' as const, waitingReason: SKIP_STAGE['comment-fix']!.nextWaitingReason }
    expect(computeNextStageCta(waitingTask)).toEqual({ stage: 'qa' })
  })

  // qa-fixes' own nextWaitingReason deliberately has no
  // NEXT_STAGE_BY_WAITING_REASON entry — same as a real clean QA pass —
  // since merge is never staged. Confirms skipping doesn't accidentally
  // revive a CTA merge was never supposed to have.
  it('qa-fixes\' nextWaitingReason offers no CTA, matching a real clean QA pass', () => {
    const waitingTask = { status: 'waiting' as const, waitingReason: SKIP_STAGE['qa-fixes']!.nextWaitingReason }
    expect(computeNextStageCta(waitingTask)).toBeNull()
  })
})

// public/index.html has no bundler, so it can't import taskParser.ts — its
// computeNextStageCta and the stage-chain node lists are hand-maintained
// mirrors of NEXT_STAGE_BY_WAITING_REASON and STAGES respectively (both
// files' own comments say so). A future edit to the stage graph that
// touches only one copy would otherwise desync the server-computed stage
// from what the dashboard renders as the "live" CTA, silently — this
// extracts both client-side array literals straight out of the real
// public/index.html source (regex, not eval, so a malformed literal fails
// the extraction loudly rather than silently matching nothing) and
// compares them structurally against the real server-side exports.
describe('client/server stage tables stay in lockstep', () => {
  async function readIndexHtml(): Promise<string> {
    return fs.readFile(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf-8')
  }

  function extractBlock(html: string, constName: string): string {
    const match = html.match(new RegExp(`const ${constName} = \\[([\\s\\S]*?)\\n {4}\\]`))
    if (!match) throw new Error(`could not find "const ${constName} = [...]" in public/index.html`)
    return match[1]
  }

  it('NEXT_STAGE_BY_WAITING_REASON matches its public/index.html mirror exactly', async () => {
    const block = extractBlock(await readIndexHtml(), 'NEXT_STAGE_BY_WAITING_REASON')
    const entryRe = /\{\s*marker:\s*'([^']*)',\s*stage:\s*'([^']*)'\s*\}/g
    const clientEntries = [...block.matchAll(entryRe)].map((m) => ({ marker: m[1], stage: m[2] }))

    expect(clientEntries.length).toBeGreaterThan(0) // the extraction itself must have found something
    expect(clientEntries).toEqual(NEXT_STAGE_BY_WAITING_REASON)
  })

  it("FLAT_CHAIN_STAGES' stage order matches STAGES exactly", async () => {
    const html = await readIndexHtml()
    // Trailing `[^}]*` tolerates the `hint` field M2 added after `label` on
    // each entry (see FLAT_CHAIN_STAGES/MILESTONE_CHAIN_STAGES in
    // public/index.html) — id/stage/label are still captured in order, and
    // that's all this test asserts on.
    const entryRe = /\{\s*id:\s*'([^']*)',\s*stage:\s*'([^']*)',\s*label:\s*'([^']*)'[^}]*\}/g

    // FLAT_CHAIN_STAGES is [planning, plan-review, ...MILESTONE_CHAIN_STAGES]
    // in the source (a spread, which this regex can't follow), so the two
    // explicit entries and the six spread-in ones are pulled from their own
    // literal blocks and concatenated in the same order the real spread
    // produces.
    const flatOwnEntries = [...extractBlock(html, 'FLAT_CHAIN_STAGES').matchAll(entryRe)]
      .map((m) => ({ id: m[1], stage: m[2] }))
    const milestoneEntries = [...extractBlock(html, 'MILESTONE_CHAIN_STAGES').matchAll(entryRe)]
      .map((m) => ({ id: m[1], stage: m[2] }))
    const fullChain = [...flatOwnEntries, ...milestoneEntries]

    expect(fullChain.length).toBeGreaterThan(0)
    expect(fullChain.map((s) => s.stage)).toEqual(STAGES)
  })
})

// ---------------------------------------------------------------------------
// Shelving a task back to the backlog — the `shelved` STATUS value, the
// `shelved: <slug>` BACKLOG.md marker, and the two directions across that
// boundary. See tech-design-backlog-demote-in-progress-task.md.
// ---------------------------------------------------------------------------

describe('parseStatusContent — shelved', () => {
  it('recognises the bare word', () => {
    expect(parseStatusContent('shelved')).toEqual({ status: 'shelved' })
    expect(parseStatusContent('shelved\n')).toEqual({ status: 'shelved' })
  })

  it('does not recognise a "shelved: <reason>" form — there is no reason to carry', () => {
    // Falls through to the existing unrecognised-value contract, exactly
    // like any other unknown STATUS text.
    expect(parseStatusContent('shelved: because I got bored')).toEqual({ status: 'working' })
    expect(parseStatusContent('shelved: later')).toEqual({ status: 'working' })
  })
})

describe('parseBacklogContent — the shelved marker', () => {
  it('lifts a lone marker line out of context', () => {
    const items = parseBacklogContent('- [ ] Parked work (2026-08-28)\n  shelved: parked-task')
    expect(items).toEqual([
      { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: null, done: false },
    ])
  })

  it('parses a context line and a marker independently, in either order', () => {
    const contextFirst = parseBacklogContent('- [ ] Parked (2026-08-28)\n  some context\n  shelved: parked-task')
    const markerFirst = parseBacklogContent('- [ ] Parked (2026-08-28)\n  shelved: parked-task\n  some context')
    const expected = [{ description: 'Parked', date: '2026-08-28', context: 'some context', shelvedSlug: 'parked-task', project: null, done: false }]
    expect(contextFirst).toEqual(expected)
    expect(markerFirst).toEqual(expected)
  })

  it('treats multi-word prose after "shelved:" as ordinary context, not a pointer', () => {
    expect(parseBacklogContent('- [ ] Idea (2026-08-28)\n  shelved: some free prose')).toEqual([
      { description: 'Idea', date: '2026-08-28', context: 'shelved: some free prose', shelvedSlug: null, project: null, done: false },
    ])
  })

  it('takes the last marker when a hand-edited file carries two', () => {
    const items = parseBacklogContent('- [ ] Parked (2026-08-28)\n  shelved: first-task\n  shelved: second-task')
    expect(items[0].shelvedSlug).toBe('second-task')
  })

  it('leaves an ordinary item with a null pointer', () => {
    expect(parseBacklogContent('- [ ] Just an idea (2026-08-28)\n  with context')[0].shelvedSlug).toBeNull()
  })
})

describe('applyBacklogEdit — shelved items', () => {
  const raw = ['- [ ] Parked work (2026-08-28)', '  old context', '  shelved: parked-task'].join('\n')
  const original = { description: 'Parked work', date: '2026-08-28', context: 'old context', shelvedSlug: 'parked-task', project: null, done: false }

  it('re-emits the marker when the description and context are edited', () => {
    const result = applyBacklogEdit(raw, 0, original, { description: 'Parked work, renamed', date: '2026-08-28', context: 'new context', project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'Parked work, renamed', date: '2026-08-28', context: 'new context', shelvedSlug: 'parked-task', project: null, done: false },
    ])
  })

  it('re-emits the marker even when the context is cleared entirely', () => {
    const result = applyBacklogEdit(raw, 0, original, { description: 'Parked work', date: '2026-08-28', context: null, project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].shelvedSlug).toBe('parked-task')
  })

  it('conflicts when the original\'s pointer disagrees with what is on disk', () => {
    // An edit racing a shelve: the client last saw an ordinary item, and the
    // line it is addressing has since acquired a pointer.
    const stale = { ...original, shelvedSlug: null }
    const result = applyBacklogEdit(raw, 0, stale, { description: 'x', date: null, context: null, project: null })
    expect(result).toEqual({ ok: false, error: 'conflict' })
  })

  it('refuses a single-token context that would parse back as a pointer', () => {
    const ordinary = '- [ ] Just an idea (2026-08-28)'
    const item = { description: 'Just an idea', date: '2026-08-28', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(ordinary, 0, item, { description: 'Just an idea', date: '2026-08-28', context: 'shelved: later', project: null })
    expect(result).toEqual({ ok: false, error: 'marker-collision' })
  })

  it('accepts multi-word prose after "shelved:", which cannot parse as a pointer', () => {
    const ordinary = '- [ ] Just an idea (2026-08-28)'
    const item = { description: 'Just an idea', date: '2026-08-28', context: null, shelvedSlug: null, project: null, done: false }
    const result = applyBacklogEdit(ordinary, 0, item, { description: 'Just an idea', date: '2026-08-28', context: 'shelved: because I got bored', project: null })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0]).toEqual({
      description: 'Just an idea', date: '2026-08-28', context: 'shelved: because I got bored', shelvedSlug: null, project: null, done: false,
    })
  })
})

describe('applyBacklogRemoval — shelved items', () => {
  it('removes the marker line along with the item, leaving neighbours intact', () => {
    const raw = [
      '- [ ] First idea (2026-08-27)',
      '- [ ] Parked work (2026-08-28)',
      '  shelved: parked-task',
      '- [ ] Third idea (2026-08-29)',
    ].join('\n')
    const original = { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: null, done: false }
    const result = applyBacklogRemoval(raw, 1, original)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.content).not.toContain('shelved: parked-task')
    expect(parseBacklogContent(result.content).map((i) => i.description)).toEqual(['First idea', 'Third idea'])
  })
})

describe('applyBacklogShelveEntry', () => {
  it('appends an entry that round-trips back through the parser', () => {
    const result = applyBacklogShelveEntry('# Backlog\n\n- [ ] First idea (2026-08-27)\n', {
      description: 'Parked work',
      date: '2026-08-28',
      slug: 'parked-task',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'First idea', date: '2026-08-27', context: null, shelvedSlug: null, project: null, done: false },
      { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: null, done: false },
    ])
  })

  it('normalises a file with no trailing newline', () => {
    const result = applyBacklogShelveEntry('# Backlog\n\n- [ ] First idea (2026-08-27)', {
      description: 'Parked work',
      date: '2026-08-28',
      slug: 'parked-task',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.content).toContain('- [ ] First idea (2026-08-27)\n- [ ] Parked work')
    expect(parseBacklogContent(result.content)).toHaveLength(2)
  })

  it('refuses a second pointer at the same task dir', () => {
    const raw = '# Backlog\n\n- [ ] Parked work (2026-08-28)\n  shelved: parked-task\n'
    const result = applyBacklogShelveEntry(raw, { description: 'Parked again', date: '2026-08-29', slug: 'parked-task', project: null })
    expect(result).toEqual({ ok: false, error: 'already-shelved' })
  })

  it('writes the tag from a valid project', () => {
    const result = applyBacklogShelveEntry('# Backlog\n', {
      description: 'Parked work',
      date: '2026-08-28',
      slug: 'parked-task',
      project: 'cockpit-ai',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].project).toBe('cockpit-ai')
  })

  it('writes untagged for a null project', () => {
    const result = applyBacklogShelveEntry('# Backlog\n', {
      description: 'Parked work',
      date: '2026-08-28',
      slug: 'parked-task',
      project: null,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(parseBacklogContent(result.content)[0].project).toBeNull()
  })

  it('refuses project-collision for an untagged title starting with a bracketed word, writing nothing', () => {
    const result = applyBacklogShelveEntry('# Backlog\n', {
      description: '[WIP] some task title',
      date: '2026-08-28',
      slug: 'parked-task',
      project: null,
    })
    expect(result).toEqual({ ok: false, error: 'project-collision' })
  })
})

describe('findResumableBacklogSlug', () => {
  const raw = ['- [ ] First idea (2026-08-27)', '- [ ] Parked work (2026-08-28)', '  shelved: parked-task'].join('\n')
  const shelvedItem = { description: 'Parked work', date: '2026-08-28', context: null, shelvedSlug: 'parked-task', project: null, done: false }

  it('resolves the task dir a shelved entry points at', () => {
    expect(findResumableBacklogSlug(raw, 1, shelvedItem)).toEqual({ ok: true, slug: 'parked-task' })
  })

  it('refuses an ordinary item — there is nothing to resume', () => {
    const ordinary = { description: 'First idea', date: '2026-08-27', context: null, shelvedSlug: null, project: null, done: false }
    expect(findResumableBacklogSlug(raw, 0, ordinary)).toEqual({ ok: false, error: 'not-shelved' })
  })

  it('refuses an out-of-range index', () => {
    expect(findResumableBacklogSlug(raw, 9, shelvedItem)).toEqual({ ok: false, error: 'out-of-range' })
  })

  it('refuses when the file changed underneath the client', () => {
    const stale = { ...shelvedItem, description: 'What the client last saw' }
    expect(findResumableBacklogSlug(raw, 1, stale)).toEqual({ ok: false, error: 'conflict' })
  })
})

describe('applyBacklogProjectBackfill', () => {
  it('tags exact-match entries and preserves date/context/shelved', () => {
    const raw = [
      '# Backlog',
      '',
      '- [ ] First idea (2026-08-20)',
      '- [ ] Second idea (2026-08-21)',
      '  some context',
      '- [ ] Third idea (2026-08-22)',
      '  shelved: parked-task',
    ].join('\n')
    const mapping = new Map([
      ['First idea', 'cockpit-ai'],
      ['Third idea', 'overlap'],
    ])
    const result = applyBacklogProjectBackfill(raw, mapping)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.tagged).toEqual(['First idea', 'Third idea'])
    expect(result.unmatched).toEqual(['Second idea'])
    expect(result.unusedKeys).toEqual([])
    expect(parseBacklogContent(result.content)).toEqual([
      { description: 'First idea', date: '2026-08-20', context: null, shelvedSlug: null, project: 'cockpit-ai', done: false },
      { description: 'Second idea', date: '2026-08-21', context: 'some context', shelvedSlug: null, project: null, done: false },
      { description: 'Third idea', date: '2026-08-22', context: null, shelvedSlug: 'parked-task', project: 'overlap', done: false },
    ])
  })

  it('never overwrites an existing tag', () => {
    const raw = '- [ ] [overlap] First idea (2026-08-20)'
    const result = applyBacklogProjectBackfill(raw, new Map([['First idea', 'cockpit-ai']]))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.tagged).toEqual([])
    expect(parseBacklogContent(result.content)[0].project).toBe('overlap')
  })

  it('a second run is a no-op: identical content, empty tagged', () => {
    const raw = '- [ ] First idea (2026-08-20)'
    const mapping = new Map([['First idea', 'cockpit-ai']])
    const first = applyBacklogProjectBackfill(raw, mapping)
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('expected ok')
    const second = applyBacklogProjectBackfill(first.content, mapping)
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('expected ok')
    expect(second.content).toBe(first.content)
    expect(second.tagged).toEqual([])
  })

  it('reports unusedKeys for a mapping key matching nothing in the file', () => {
    const raw = '- [ ] First idea (2026-08-20)'
    const mapping = new Map([['First idea', 'cockpit-ai'], ['Edited-away idea', 'overlap']])
    const result = applyBacklogProjectBackfill(raw, mapping)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok')
    expect(result.unusedKeys).toEqual(['Edited-away idea'])
  })

  it('refuses a non-token mapping value before rewriting anything', () => {
    const raw = '- [ ] First idea (2026-08-20)'
    const result = applyBacklogProjectBackfill(raw, new Map([['First idea', 'not a slug']]))
    expect(result).toEqual({ ok: false, error: 'invalid-project', key: 'First idea' })
  })
})

describe('shouldShowOnBoard / computeAttentionStatus — shelved', () => {
  it('keeps a shelved task off the board, and leaves every other status alone', () => {
    expect(shouldShowOnBoard({ slug: 'parked-task', status: 'shelved' } as Task)).toBe(false)
    expect(shouldShowOnBoard({ slug: 'parked-task', status: 'working' } as Task)).toBe(true)
    expect(shouldShowOnBoard({ slug: 'parked-task', status: 'paused' } as Task)).toBe(true)
  })

  it('keeps a shelved milestone child off the board too', () => {
    // parseMilestoneSlug would otherwise short-circuit to true for a child.
    expect(shouldShowOnBoard({ slug: 'some-project-m1', status: 'shelved' } as Task)).toBe(false)
  })

  it('answers "does this need me right now" the same way as paused', () => {
    const task = { status: 'shelved', qaFailures: [], findings: [] } as unknown as Task
    expect(computeAttentionStatus(task, null)).toBe('paused')
  })
})

describe('worktreesDir', () => {
  let originalWorktreesDir: string | undefined

  beforeEach(() => {
    originalWorktreesDir = process.env.WORKTREES_DIR
  })

  afterEach(() => {
    if (originalWorktreesDir === undefined) delete process.env.WORKTREES_DIR
    else process.env.WORKTREES_DIR = originalWorktreesDir
  })

  it('respects WORKTREES_DIR when set', () => {
    process.env.WORKTREES_DIR = '/tmp/some-worktrees'
    expect(worktreesDir()).toBe('/tmp/some-worktrees')
  })

  it('resolves a relative WORKTREES_DIR, matching the inline code it replaced', () => {
    process.env.WORKTREES_DIR = 'relative-worktrees'
    expect(worktreesDir()).toBe(path.resolve('relative-worktrees'))
  })

  it('falls back to ~/Dev/worktrees', () => {
    delete process.env.WORKTREES_DIR
    expect(worktreesDir()).toBe(path.join(os.homedir(), 'Dev', 'worktrees'))
  })
})

describe('buildDeadSessionMessage', () => {
  // The standing message, spelled out rather than derived — the whole point
  // of this suite is that adding the recreate clause did not disturb it.
  const STANDING =
    'The tmux session for `parked-task` is gone — its iTerm tab and tmux session are both dead (likely after a restart).' +
    ' Recreate a tmux session attached to its existing worktree, launch `claude` in it, and prompt it to read TASK.md and resume from wherever its STATUS paused note says to pick up.'

  let originalWorktreesDir: string | undefined
  let originalReposDir: string | undefined

  beforeEach(() => {
    originalWorktreesDir = process.env.WORKTREES_DIR
    originalReposDir = process.env.REPOS_DIR
    process.env.WORKTREES_DIR = '/tmp/wt'
    process.env.REPOS_DIR = '/tmp/repos'
  })

  afterEach(() => {
    if (originalWorktreesDir === undefined) delete process.env.WORKTREES_DIR
    else process.env.WORKTREES_DIR = originalWorktreesDir
    if (originalReposDir === undefined) delete process.env.REPOS_DIR
    else process.env.REPOS_DIR = originalReposDir
  })

  it('is byte-for-byte the standing message when the worktree is still there', () => {
    expect(buildDeadSessionMessage('parked-task', { worktree: '/tmp/wt/parked-task', repo: 'cockpit-ai', branch: 'claude/parked-task' }))
      .toBe(STANDING)
  })

  it('splices in a recreate command when the worktree is gone', () => {
    const message = buildDeadSessionMessage('parked-task', { worktree: null, repo: 'cockpit-ai', branch: 'claude/parked-task' })
    expect(message).toContain('git -C /tmp/repos/cockpit-ai worktree add /tmp/wt/parked-task claude/parked-task')
    // Spliced into the standing message, never a replacement for it: recreate
    // first, then the unchanged reattach-and-resume instruction.
    expect(message.startsWith('The tmux session for `parked-task` is gone')).toBe(true)
    expect(message.endsWith('resume from wherever its STATUS paused note says to pick up.')).toBe(true)
  })

  it('names no command when the task dir never gave a repo or a branch', () => {
    // parseTaskMdContent falls back to '' for both — a half-written
    // `git -C /tmp/repos/ worktree add ... ` is worse than nothing.
    expect(buildDeadSessionMessage('parked-task', { worktree: null, repo: '', branch: '' })).toBe(STANDING)
    expect(buildDeadSessionMessage('parked-task', { worktree: null, repo: 'cockpit-ai', branch: '' })).toBe(STANDING)
  })
})
