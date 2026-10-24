import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  DISABLE_RETIREMENT_ENV,
  TASK_SESSION_SUFFIXES,
  formatRetirementSummary,
  retireSessionsOfTask,
  retireTaskSessions,
  taskSessionNames,
  type TmuxRunResult,
  type TmuxRunner,
} from './retireTaskSessions.js'

const { parseAllTasksMock } = vi.hoisted(() => ({ parseAllTasksMock: vi.fn() }))
vi.mock('./taskParser.js', () => ({ parseAllTasks: parseAllTasksMock }))

describe('taskSessionNames', () => {
  it('matches the dev tab and every known stage suffix, with optional digits', () => {
    const sessions = [
      'worker-foo',
      'worker-foo-cr',
      'worker-foo-cr2',
      'worker-foo-qa',
      'worker-foo-qa12',
      'worker-foo-fix',
      'worker-foo-crfix',
      'worker-foo-qafix',
      'worker-foo-review',
      'worker-foo-merge',
      'worker-foo-readmefix',
    ]
    expect(taskSessionNames({ slug: 'foo' }, sessions)).toEqual(sessions)
  })

  it('does not match another task whose slug extends this one', () => {
    expect(taskSessionNames({ slug: 'foo' }, ['worker-foo-bar', 'worker-foo-m1', 'worker-foo-m1-qa', 'worker-foo-bar-cr'])).toEqual([])
  })

  it('matches only its own sessions for a milestone slug', () => {
    const sessions = ['worker-foo', 'worker-foo-qa', 'worker-foo-m1', 'worker-foo-m1-qa', 'worker-foo-m1-cr2', 'worker-foo-m10-qa']
    expect(taskSessionNames({ slug: 'foo-m1' }, sessions)).toEqual(['worker-foo-m1', 'worker-foo-m1-qa', 'worker-foo-m1-cr2'])
  })

  it('does not match a task whose slug is a prefix of this one', () => {
    expect(taskSessionNames({ slug: 'foo-bar' }, ['worker-foo', 'worker-foo-qa', 'worker-foo-bar'])).toEqual(['worker-foo-bar'])
  })

  it('rejects unknown suffixes, non-digit suffix tails and non-worker names', () => {
    expect(
      taskSessionNames({ slug: 'foo' }, ['worker-foo-unknown', 'worker-foo-qax', 'worker-foo-', 'worker-foo2', 'orchestrator', 'claude-foo', 'xworker-foo', 'worker-foo-qa-extra']),
    ).toEqual([])
  })

  it('treats regex metacharacters in a slug literally', () => {
    expect(taskSessionNames({ slug: 'a.c' }, ['worker-a.c', 'worker-abc', 'worker-a.c-qa'])).toEqual(['worker-a.c', 'worker-a.c-qa'])
  })

  it('matches the handover successor tab worker-<slug>-s<N>', () => {
    expect(taskSessionNames({ slug: 'foo' }, ['worker-foo-s2', 'worker-foo-s10', 'worker-foo-s', 'worker-foo-sx'])).toEqual(['worker-foo-s2', 'worker-foo-s10', 'worker-foo-s'])
  })

  it('leaves a session to the longer slug that also matches it', () => {
    const sessions = ['worker-foo-fix', 'worker-foo-qa', 'worker-foo-fix-qa', 'worker-foo-review']
    expect(taskSessionNames({ slug: 'foo' }, sessions, ['foo', 'foo-fix'])).toEqual(['worker-foo-qa', 'worker-foo-review'])
    expect(taskSessionNames({ slug: 'foo-fix' }, sessions, ['foo', 'foo-fix'])).toEqual(['worker-foo-fix', 'worker-foo-fix-qa'])
  })

  it('still matches a suffixed session when no longer slug exists', () => {
    expect(taskSessionNames({ slug: 'foo' }, ['worker-foo-fix'], ['foo', 'unrelated'])).toEqual(['worker-foo-fix'])
  })

  it('also matches the exact TMUX_SESSION pointer of the task, whatever its suffix', () => {
    expect(taskSessionNames({ slug: 'foo', tmuxSession: 'worker-foo-devurl' }, ['worker-foo-devurl', 'worker-foo-other'])).toEqual(['worker-foo-devurl'])
  })

  it('never honours a pointer naming another task\'s session, even one a longer slug owns', () => {
    const sessions = ['worker-foo-m1', 'worker-foo-fix', 'worker-foobar', 'worker-other', 'worker-foo']
    for (const tmuxSession of ['worker-foo-m1', 'worker-foo-fix', 'worker-foobar', 'worker-other']) {
      expect(taskSessionNames({ slug: 'foo', tmuxSession }, sessions, ['foo', 'foo-m1', 'foo-fix'])).toEqual(['worker-foo'])
    }
  })

  it('never honours a pointer that is not a worker session, such as the orchestrator', () => {
    expect(taskSessionNames({ slug: 'foo', tmuxSession: 'orchestrator' }, ['orchestrator', 'worker-foo'])).toEqual(['worker-foo'])
  })

  it('returns nothing for an empty session list', () => {
    expect(taskSessionNames({ slug: 'foo' }, [])).toEqual([])
  })

  it('covers every tmux-name suffix the dispatching skills use', () => {
    const skillsDir = path.join(__dirname, '..', '.claude', 'skills')
    const dispatchedSuffixes = fs
      .readdirSync(skillsDir)
      .map((skill) => path.join(skillsDir, skill, 'SKILL.md'))
      .filter((file) => fs.existsSync(file))
      .flatMap((file) => [...fs.readFileSync(file, 'utf8').matchAll(/worker-<slug>-([a-z]+)(?:\d*|<N>)(?![a-z])/g)].map((match) => match[1]))
    expect(dispatchedSuffixes.length).toBeGreaterThan(0)
    for (const suffix of dispatchedSuffixes) expect(TASK_SESSION_SUFFIXES).toContain(suffix)
  })
})

function ok(stdout = ''): TmuxRunResult {
  return { exitCode: 0, stdout, stderr: '' }
}

function fail(stderr: string): TmuxRunResult {
  return { exitCode: 1, stdout: '', stderr }
}

function listing(...rows: Array<[string, 0 | 1]>): TmuxRunResult {
  return ok(rows.map(([name, attached]) => `${name} ${attached}`).join('\n'))
}

describe('retireTaskSessions', () => {
  let runTmux: ReturnType<typeof vi.fn<TmuxRunner>>
  let killHandler: (name: string) => TmuxRunResult

  const killCalls = () => runTmux.mock.calls.map(([args]) => args).filter((args) => args[0] === 'kill-session')

  beforeEach(() => {
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv('TMUX_PANE', '')
    killHandler = () => ok()
    runTmux = vi.fn<TmuxRunner>(async (args) => (args[0] === 'kill-session' ? killHandler(args[2].slice(1)) : ok()))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  function givenSessions(result: TmuxRunResult) {
    runTmux.mockImplementation(async (args) => (args[0] === 'list-sessions' ? result : killHandler(args[2].slice(1))))
  }

  it('lists with the name+attached format and kills exactly the matching unattached sessions by exact =name', async () => {
    givenSessions(
      listing(['worker-foo', 0], ['worker-foo-qa', 0], ['worker-foo-bar', 0], ['worker-other', 0], ['orchestrator', 0]),
    )

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(runTmux.mock.calls[0][0]).toEqual(['list-sessions', '-F', '#{session_name} #{session_attached}'])
    expect(killCalls()).toEqual([
      ['kill-session', '-t', '=worker-foo'],
      ['kill-session', '-t', '=worker-foo-qa'],
    ])
    expect(result).toEqual({ retired: ['worker-foo', 'worker-foo-qa'], wasAttached: [], failures: [], listError: null })
  })

  it('kills an attached session too, by plain exact kill-session, and records it was attached', async () => {
    givenSessions(listing(['worker-foo', 0], ['worker-foo-cr', 1]))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toEqual([
      ['kill-session', '-t', '=worker-foo'],
      ['kill-session', '-t', '=worker-foo-cr'],
    ])
    expect(result.retired).toEqual(['worker-foo', 'worker-foo-cr'])
    expect(result.wasAttached).toEqual(['worker-foo-cr'])
    expect(result).not.toHaveProperty('leftOpen')
  })

  it('types nothing into any session: only list-sessions and kill-session are ever run', async () => {
    givenSessions(listing(['worker-foo', 1], ['worker-foo-s2', 1]))

    await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    const verbs = new Set(runTmux.mock.calls.map(([args]) => args[0]))
    expect(verbs).toEqual(new Set(['list-sessions', 'kill-session']))
  })

  it('never selects another task or the orchestrator even when they are attached', async () => {
    givenSessions(listing(['worker-foo-m1', 1], ['worker-foobar', 1], ['worker-foo-bar', 1], ['orchestrator', 1], ['worker-foo-s2', 1]))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toEqual([['kill-session', '-t', '=worker-foo-s2']])
    expect(result.wasAttached).toEqual(['worker-foo-s2'])
  })

  it('a failed kill of an attached session is a failure, not retired and not marked attached', async () => {
    givenSessions(listing(['worker-foo-cr', 1]))
    killHandler = () => fail('server exited unexpectedly')

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(result.retired).toEqual([])
    expect(result.wasAttached).toEqual([])
    expect(result.failures).toEqual([{ name: 'worker-foo-cr', error: 'server exited unexpectedly' }])
  })

  describe('when run from inside one of the task\'s own sessions', () => {
    beforeEach(() => {
      vi.stubEnv('TMUX_PANE', '%7')
    })
    afterEach(() => {
      vi.unstubAllEnvs()
    })

    function givenCallerSession(callerSession: string, rows: Array<[string, 0 | 1]>) {
      runTmux.mockImplementation(async (args) => {
        if (args[0] === 'list-sessions') return listing(...rows)
        if (args[0] === 'display-message') return ok(`${callerSession}\n`)
        return killHandler(args[2].slice(1))
      })
    }

    it('kills the caller\'s own session last so the rest and the report still happen', async () => {
      givenCallerSession('worker-foo', [['worker-foo', 1], ['worker-foo-qa', 1], ['worker-foo-cr', 1]])

      const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

      expect(runTmux).toHaveBeenCalledWith(['display-message', '-p', '-t', '%7', '#{session_name}'])
      expect(killCalls().map((args) => args[2])).toEqual(['=worker-foo-qa', '=worker-foo-cr', '=worker-foo'])
      expect(result.retired).toEqual(['worker-foo-qa', 'worker-foo-cr', 'worker-foo'])
    })

    it('still retires everything when the caller\'s session cannot be determined', async () => {
      runTmux.mockImplementation(async (args) => {
        if (args[0] === 'list-sessions') return listing(['worker-foo', 1], ['worker-foo-qa', 1])
        if (args[0] === 'display-message') return fail('no current client')
        return killHandler(args[2].slice(1))
      })

      const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

      expect(result.retired).toEqual(['worker-foo', 'worker-foo-qa'])
      expect(console.error).toHaveBeenCalled()
    })
  })

  it('reports a failed kill with tmux error text and still retires the rest', async () => {
    givenSessions(listing(['worker-foo', 0], ['worker-foo-qa', 0], ['worker-foo-cr', 0]))
    killHandler = (name) => (name === 'worker-foo-qa' ? fail("can't find session: worker-foo-qa") : ok())

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toHaveLength(3)
    expect(result.retired).toEqual(['worker-foo', 'worker-foo-cr'])
    expect(result.failures).toEqual([{ name: 'worker-foo-qa', error: "can't find session: worker-foo-qa" }])
    expect(console.error).toHaveBeenCalled()
  })

  it('is a quiet no-op, logged at debug, when no tmux server is running', async () => {
    givenSessions(fail('no server running on /private/tmp/tmux-501/default'))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toEqual([])
    expect(result).toEqual({ retired: [], wasAttached: [], failures: [], listError: null })
    expect(console.debug).toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('is a quiet no-op when the server has no sessions at all', async () => {
    givenSessions(ok(''))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toEqual([])
    expect(result).toEqual({ retired: [], wasAttached: [], failures: [], listError: null })
    expect(console.error).not.toHaveBeenCalled()
  })

  it('reports a list failure that is not "no server", and kills nothing', async () => {
    givenSessions(fail('unknown option -- F'))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(killCalls()).toEqual([])
    expect(result.listError).toBe('unknown option -- F')
    expect(console.error).toHaveBeenCalled()
  })

  it('does not mistake a socket permission problem for "no server": it is a list error, not a debug no-op', async () => {
    givenSessions(fail('error connecting to /private/tmp/tmux-501/default (Permission denied)'))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(result.listError).toMatch(/Permission denied/)
    expect(console.error).toHaveBeenCalled()
  })

  it('treats a missing socket as "no server": a quiet no-op', async () => {
    givenSessions(fail('error connecting to /private/tmp/tmux-501/default (No such file or directory)'))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(result.listError).toBeNull()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('retires a handover tab and the TMUX_SESSION pointer, but not a session a longer slug owns', async () => {
    givenSessions(listing(['worker-foo-s2', 0], ['worker-foo-custom', 0], ['worker-foo-fix', 0], ['worker-foo', 0]))

    const result = await retireTaskSessions({ slug: 'foo', tmuxSession: 'worker-foo-custom' }, ['foo', 'foo-fix'], { runTmux })

    expect(result.retired.sort()).toEqual(['worker-foo', 'worker-foo-custom', 'worker-foo-s2'])
    expect(killCalls().map((args) => args[2])).not.toContain('=worker-foo-fix')
  })

  describe(`with ${DISABLE_RETIREMENT_ENV}=1`, () => {
    afterEach(() => {
      delete process.env[DISABLE_RETIREMENT_ENV]
    })

    it('never runs tmux at all, so the e2e server cannot touch live sessions', async () => {
      process.env[DISABLE_RETIREMENT_ENV] = '1'

      const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

      expect(runTmux).not.toHaveBeenCalled()
      expect(result).toEqual({ retired: [], wasAttached: [], failures: [], listError: null })
    })
  })

  it('reports a thrown runner (tmux not installed) as a list error instead of throwing', async () => {
    runTmux.mockRejectedValue(new Error('spawn tmux ENOENT'))

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(result.listError).toBe('spawn tmux ENOENT')
  })

  it('reports a kill that throws as a failure and continues', async () => {
    runTmux.mockImplementation(async (args) => {
      if (args[0] === 'list-sessions') return listing(['worker-foo', 0], ['worker-foo-qa', 0])
      if (args[2] === '=worker-foo') throw new Error('boom')
      return ok()
    })

    const result = await retireTaskSessions({ slug: 'foo' }, [], { runTmux })

    expect(result.retired).toEqual(['worker-foo-qa'])
    expect(result.failures).toEqual([{ name: 'worker-foo', error: 'boom' }])
  })
})

describe('retireSessionsOfTask', () => {
  const runTmux = vi.fn<TmuxRunner>()

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    runTmux.mockReset()
    runTmux.mockImplementation(async (args) =>
      args[0] === 'list-sessions' ? ok('worker-foo 0\nworker-foo-fix 0') : ok(),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('passes every task slug as the other owners, so a longer slug keeps its own session', async () => {
    parseAllTasksMock.mockResolvedValueOnce([{ slug: 'foo' }, { slug: 'foo-fix' }])

    const result = await retireSessionsOfTask('/tasks', { slug: 'foo' }, { runTmux })

    expect(parseAllTasksMock).toHaveBeenCalledWith('/tasks')
    expect(result.retired).toEqual(['worker-foo'])
  })

  it('retires nothing and reports it when the task list cannot be read', async () => {
    parseAllTasksMock.mockRejectedValueOnce(new Error('EACCES'))

    const result = await retireSessionsOfTask('/tasks', { slug: 'foo' }, { runTmux })

    expect(runTmux).not.toHaveBeenCalled()
    expect(result.listError).toMatch(/could not read the task list: EACCES/)
    expect(console.error).toHaveBeenCalled()
  })
})

describe('formatRetirementSummary', () => {
  const empty = { retired: [], wasAttached: [], failures: [], listError: null }

  it('says none when nothing was retired or failed', () => {
    expect(formatRetirementSummary(empty)).toBe('sessions: none')
  })

  it('lists retired sessions, flagging the ones that were attached when killed', () => {
    expect(formatRetirementSummary({ ...empty, retired: ['worker-a', 'worker-a-qa'] })).toBe('sessions: retired worker-a, worker-a-qa')
    expect(
      formatRetirementSummary({ ...empty, retired: ['worker-a', 'worker-a-cr'], wasAttached: ['worker-a-cr'] }),
    ).toBe('sessions: retired worker-a, worker-a-cr (was attached)')
  })

  it('includes failures and a list error', () => {
    expect(formatRetirementSummary({ ...empty, failures: [{ name: 'worker-a', error: 'nope' }] })).toBe('sessions: failed worker-a (nope)')
    expect(formatRetirementSummary({ ...empty, listError: 'bad flag' })).toBe('sessions: could not list tmux sessions (bad flag)')
  })
})
