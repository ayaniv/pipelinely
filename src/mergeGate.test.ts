import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execa } from 'execa'
import { evaluateMergeReadiness, formatMergeBlockers, checkMergeReadiness } from './mergeGate.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

function basePrView(overrides: Record<string, unknown> = {}) {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    headRefOid: 'a'.repeat(40),
    headRefName: 'claude/some-task',
    isCrossRepository: false,
    statusCheckRollup: [],
    ...overrides,
  }
}

describe('evaluateMergeReadiness', () => {
  it('is ready when the rollup is empty (decision 1: zero checks passes)', () => {
    const result = evaluateMergeReadiness(basePrView())
    expect(result).toEqual({
      ready: true,
      headSha: 'a'.repeat(40),
      headRefName: 'claude/some-task',
      isCrossRepository: false,
    })
  })

  it('is ready when every check passes, carrying headRefName/isCrossRepository through', () => {
    const result = evaluateMergeReadiness(basePrView({
      isCrossRepository: true,
      statusCheckRollup: [
        { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: null },
        { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'NEUTRAL', detailsUrl: null },
        { __typename: 'CheckRun', name: 'legacy', status: 'COMPLETED', conclusion: 'SKIPPED', detailsUrl: null },
        { __typename: 'StatusContext', context: 'ci/status', state: 'SUCCESS', targetUrl: null },
      ],
    }))
    expect(result).toEqual({ ready: true, headSha: 'a'.repeat(40), headRefName: 'claude/some-task', isCrossRepository: true })
  })

  it('blocks with not-open when state is not OPEN', () => {
    const result = evaluateMergeReadiness(basePrView({ state: 'MERGED' }))
    expect(result.ready).toBe(false)
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['not-open'])
  })

  it('blocks with draft when isDraft is true', () => {
    const result = evaluateMergeReadiness(basePrView({ isDraft: true }))
    expect(result.ready).toBe(false)
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['draft'])
  })

  it('blocks with conflicts when mergeable is CONFLICTING', () => {
    const result = evaluateMergeReadiness(basePrView({ mergeable: 'CONFLICTING' }))
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['conflicts'])
  })

  it('blocks with conflicts when mergeStateStatus is DIRTY, even if mergeable itself is not CONFLICTING', () => {
    const result = evaluateMergeReadiness(basePrView({ mergeStateStatus: 'DIRTY' }))
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['conflicts'])
  })

  it('blocks with mergeability-unknown when mergeable is UNKNOWN', () => {
    const result = evaluateMergeReadiness(basePrView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['mergeability-unknown'])
  })

  it('blocks with blocked when mergeStateStatus is BLOCKED', () => {
    const result = evaluateMergeReadiness(basePrView({ mergeStateStatus: 'BLOCKED' }))
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind)).toEqual(['blocked'])
  })

  it('blocks with check-pending for a CheckRun that has not completed, named by name', () => {
    const result = evaluateMergeReadiness(basePrView({
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: null, detailsUrl: 'https://x/1' }],
    }))
    expect((result as { blockers: unknown[] }).blockers).toEqual([
      { kind: 'check-pending', name: 'e2e', link: 'https://x/1', detail: expect.stringContaining('e2e') },
    ])
  })

  it('blocks with check-pending for a StatusContext in PENDING or EXPECTED, named by context', () => {
    for (const state of ['PENDING', 'EXPECTED']) {
      const result = evaluateMergeReadiness(basePrView({
        statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/build', state, targetUrl: 'https://x/2' }],
      }))
      expect((result as { blockers: unknown[] }).blockers).toEqual([
        { kind: 'check-pending', name: 'ci/build', link: 'https://x/2', detail: expect.stringContaining('ci/build') },
      ])
    }
  })

  it('blocks with check-failed for a CheckRun with a failing conclusion', () => {
    for (const conclusion of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']) {
      const result = evaluateMergeReadiness(basePrView({
        statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion, detailsUrl: null }],
      }))
      expect((result as { blockers: { kind: string; name: string }[] }).blockers).toEqual([
        { kind: 'check-failed', name: 'unit-tests', link: null, detail: expect.stringContaining('unit-tests') },
      ])
    }
  })

  it('blocks with check-failed for a StatusContext in FAILURE or ERROR, named by context', () => {
    for (const state of ['FAILURE', 'ERROR']) {
      const result = evaluateMergeReadiness(basePrView({
        statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci/coverage', state, targetUrl: null }],
      }))
      expect((result as { blockers: { kind: string; name: string }[] }).blockers).toEqual([
        { kind: 'check-failed', name: 'ci/coverage', link: null, detail: expect.stringContaining('ci/coverage') },
      ])
    }
  })

  it('reports multiple blockers together, not just the first one found', () => {
    const result = evaluateMergeReadiness(basePrView({
      mergeable: 'CONFLICTING',
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: null }],
    }))
    expect((result as { blockers: { kind: string }[] }).blockers.map((b) => b.kind).sort()).toEqual(['check-failed', 'conflicts'])
  })

  it.each([
    ['null', null],
    ['a string', 'not an object'],
    ['an array', []],
    ['missing headRefOid', basePrView({ headRefOid: undefined })],
    ['empty headRefOid', basePrView({ headRefOid: '' })],
    ['missing headRefName', basePrView({ headRefName: undefined })],
    ['non-boolean isCrossRepository', basePrView({ isCrossRepository: 'false' })],
    ['non-array statusCheckRollup', basePrView({ statusCheckRollup: 'nope' })],
    ['a rollup entry with an unrecognized __typename', basePrView({ statusCheckRollup: [{ __typename: 'Mystery' }] })],
    ['a CheckRun with an unrecognized conclusion', basePrView({
      statusCheckRollup: [{ __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'WEIRD', detailsUrl: null }],
    })],
  ])('never treats %s as ready — reports malformed instead', (_label, input) => {
    const result = evaluateMergeReadiness(input)
    expect(result.ready).toBe(false)
    expect((result as { blockers: { kind: string }[] }).blockers).toEqual([expect.objectContaining({ kind: 'malformed' })])
  })
})

describe('formatMergeBlockers', () => {
  it('renders one line per blocker, in order, naming checks by name', () => {
    const text = formatMergeBlockers([
      { kind: 'conflicts', detail: 'PR has merge conflicts' },
      { kind: 'check-failed', name: 'unit-tests', link: null, detail: "check `unit-tests` failed" },
    ])
    const lines = text.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('conflict')
    expect(lines[1]).toContain('unit-tests')
  })
})

describe('checkMergeReadiness', () => {
  const mockExeca = vi.mocked(execa)

  beforeEach(() => {
    mockExeca.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Read lazily by mergeGate.ts specifically so a per-test override like
    // this works without needing to precede the module's own import.
    process.env.COCKPIT_MERGEABILITY_RETRY_DELAY_MS = '1'
  })

  it('returns the evaluated readiness on a single successful read', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: JSON.stringify(basePrView()) } as never)
    const result = await checkMergeReadiness('/repo', '42')
    expect(result).toEqual({ ok: true, readiness: { ready: true, headSha: 'a'.repeat(40), headRefName: 'claude/some-task', isCrossRepository: false } })
    expect(mockExeca).toHaveBeenCalledTimes(1)
  })

  it('re-reads while mergeable is UNKNOWN and stops as soon as it resolves', async () => {
    mockExeca
      .mockResolvedValueOnce({ stdout: JSON.stringify(basePrView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })) } as never)
      .mockResolvedValueOnce({ stdout: JSON.stringify(basePrView()) } as never)
    const result = await checkMergeReadiness('/repo', '42')
    expect(result.ok).toBe(true)
    expect((result as { readiness: { ready: boolean } }).readiness.ready).toBe(true)
    expect(mockExeca).toHaveBeenCalledTimes(2)
  })

  it('gives up after the bounded number of re-reads and reports mergeability-unknown', async () => {
    mockExeca.mockResolvedValue({ stdout: JSON.stringify(basePrView({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })) } as never)
    const result = await checkMergeReadiness('/repo', '42')
    expect(result.ok).toBe(true)
    expect((result as { readiness: { blockers: { kind: string }[] } }).readiness.blockers.map((b) => b.kind)).toEqual(['mergeability-unknown'])
    expect(mockExeca.mock.calls.length).toBeGreaterThan(1)
  })

  it('returns ok:false and logs when gh itself fails', async () => {
    mockExeca.mockRejectedValueOnce(new Error('gh: no such PR'))
    const result = await checkMergeReadiness('/repo', '42')
    expect(result).toEqual({ ok: false, error: expect.stringContaining('no such PR') })
    expect(console.error).toHaveBeenCalled()
  })

  it('treats non-JSON gh output as malformed, not as a gate failure', async () => {
    mockExeca.mockResolvedValueOnce({ stdout: 'not json at all' } as never)
    const result = await checkMergeReadiness('/repo', '42')
    expect(result.ok).toBe(true)
    expect((result as { readiness: { blockers: { kind: string }[] } }).readiness.blockers).toEqual([expect.objectContaining({ kind: 'malformed' })])
  })
})
