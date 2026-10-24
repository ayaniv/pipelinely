import { execa } from 'execa'
import { parseAllTasks } from './taskParser.js'

// Every tmux-name suffix a stage tab of a task is dispatched under
// (`worker-<slug>-<suffix>`, optionally numbered: cr2, qa2). dispatch-tab.sh
// takes any suffix, so this list is the single place that decides which
// sessions belong to a task; a test checks it against the cockpit-* skills.
// `dqa` is pipelinely-design-qa's tab, `adopt` pipelinely-adopt's.
// `s` is the handover skill's successor dev tab (`worker-<slug>-s<N>`).
export const TASK_SESSION_SUFFIXES = ['cr', 'qa', 'fix', 'crfix', 'qafix', 'review', 'merge', 'readmefix', 'annotate', 'dqa', 'adopt', 's'] as const

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface TaskSessionOwner {
  slug: string
  // The task's TMUX_SESSION pointer: names its live dev tab exactly, whatever the name.
  tmuxSession?: string | null
}

const WORKER_PREFIX = 'worker-'

// The pointer is trusted only for names inside this task's own `worker-<slug>`
// namespace, so a stale or mis-targeted pointer can't reach another task's tab.
function isInsideSlugNamespace(slug: string, sessionName: string): boolean {
  const base = `${WORKER_PREFIX}${slug}`
  return sessionName === base || sessionName.startsWith(`${base}-`)
}

function matchesSlugPattern(slug: string, sessionName: string): boolean {
  const ownSession = new RegExp(`^${WORKER_PREFIX}${escapeRegExp(slug)}(?:-(?:${TASK_SESSION_SUFFIXES.join('|')})\\d*)?$`)
  return ownSession.test(sessionName)
}

// Exactly the sessions of THIS task. Anchored on both ends and limited to the
// known suffixes, so for slug `foo` the sessions of `foo-bar` or `foo-m1`
// (different tasks) never match. `otherSlugs` closes the remaining gap: a
// session that a longer existing slug also matches (`worker-foo-fix` is task
// `foo-fix`'s dev tab, not task `foo`'s fix tab) belongs to that task, as in
// assignSessionsToTasks's longest-slug rule. The pointer match is limited to
// names inside `worker-<slug>` that no longer slug owns, so a stray pointer can
// never name the orchestrator or another task's tab.
export function taskSessionNames(owner: TaskSessionOwner, allSessionNames: readonly string[], otherSlugs: readonly string[] = []): string[] {
  const longerSlugs = otherSlugs.filter((other) => other.length > owner.slug.length && other !== owner.slug)
  return allSessionNames.filter((name) => {
    const isOwnedByLongerSlug = longerSlugs.some((other) => matchesSlugPattern(other, name))
    if (name === owner.tmuxSession && isInsideSlugNamespace(owner.slug, name)) return !isOwnedByLongerSlug
    return matchesSlugPattern(owner.slug, name) && !isOwnedByLongerSlug
  })
}

export interface TmuxRunResult {
  exitCode: number
  stdout: string
  stderr: string
}

// Always an argv array, never a shell string.
export type TmuxRunner = (args: string[]) => Promise<TmuxRunResult>

export interface RetireDeps {
  runTmux: TmuxRunner
}

export interface RetirementResult {
  retired: string[]
  // Subset of `retired`: the sessions an iTerm tab was attached to when killed.
  wasAttached: string[]
  failures: Array<{ name: string; error: string }>
  // Set only when listing failed for a reason other than "no tmux server".
  listError: string | null
}

const runRealTmux: TmuxRunner = async (args) => {
  const result = await execa('tmux', args, { reject: false })
  return { exitCode: result.exitCode ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? result.shortMessage ?? '') }
}

export const defaultRetireDeps: RetireDeps = { runTmux: runRealTmux }

// tmux exits non-zero with these when there is simply nothing to retire. A
// socket that exists but can't be reached ("error connecting ... (Permission
// denied)") is a real problem and must stay a reported list error.
const NO_SERVER_PATTERN = /no server running|no sessions|error connecting to .*\(No such file or directory\)/i

// The e2e fixture server must never list or kill sessions on the developer's
// live tmux server, so its launch config sets this.
export const DISABLE_RETIREMENT_ENV = 'COCKPIT_DISABLE_SESSION_RETIREMENT'

function isSessionRetirementDisabled(): boolean {
  return process.env[DISABLE_RETIREMENT_ENV] === '1'
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function emptyResult(): RetirementResult {
  return { retired: [], wasAttached: [], failures: [], listError: null }
}

interface ListedSession {
  name: string
  isAttached: boolean
}

async function listSessions(runTmux: TmuxRunner): Promise<{ sessions: ListedSession[]; listError: string | null }> {
  let result: TmuxRunResult
  try {
    result = await runTmux(['list-sessions', '-F', '#{session_name} #{session_attached}'])
  } catch (err) {
    console.error('retire-task-sessions: could not run tmux list-sessions:', err)
    return { sessions: [], listError: errorMessage(err) }
  }
  if (result.exitCode !== 0) {
    if (NO_SERVER_PATTERN.test(result.stderr)) {
      console.debug('retire-task-sessions: no tmux server running, nothing to retire')
      return { sessions: [], listError: null }
    }
    console.error(`retire-task-sessions: tmux list-sessions failed: ${result.stderr}`)
    return { sessions: [], listError: result.stderr }
  }
  const sessions = result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf(' ')
      return { name: line.slice(0, separator), isAttached: Number(line.slice(separator + 1)) > 0 }
    })
  return { sessions, listError: null }
}

// The session the caller itself runs in, if it runs inside tmux. Killing it
// SIGHUPs this process, so it has to go last. Read-only; null when unknown.
async function callerSessionName(runTmux: TmuxRunner): Promise<string | null> {
  const pane = process.env.TMUX_PANE
  if (!pane) return null
  try {
    const result = await runTmux(['display-message', '-p', '-t', pane, '#{session_name}'])
    if (result.exitCode === 0) return result.stdout.trim() || null
    console.error(`retire-task-sessions: could not read the caller's tmux session: ${result.stderr}`)
  } catch (err) {
    console.error("retire-task-sessions: could not read the caller's tmux session:", err)
  }
  return null
}

// Retires every session of a FINISHED task, one exact `=name` target at a
// time. Every one is killed, attached or not, whatever it is running: an idle
// `claude` tab is exactly what piles up, and its pane command can't tell idle
// from busy. A plain kill-session is deliberate (the attached claude gets
// SIGHUP and exits at once); nothing is ever typed into a tab. Never throws: the
// merge this runs after is irreversible, so every problem is reported, not
// raised.
export async function retireTaskSessions(
  owner: TaskSessionOwner,
  otherSlugs: readonly string[] = [],
  deps: RetireDeps = defaultRetireDeps,
): Promise<RetirementResult> {
  const result = emptyResult()
  if (isSessionRetirementDisabled()) {
    console.debug(`retire-task-sessions: disabled by ${DISABLE_RETIREMENT_ENV}, leaving ${owner.slug}'s sessions alone`)
    return result
  }
  const { sessions, listError } = await listSessions(deps.runTmux)
  result.listError = listError

  const ownNames = new Set(taskSessionNames(owner, sessions.map((session) => session.name), otherSlugs))
  const callerSession = await callerSessionName(deps.runTmux)
  const ownSessions = sessions.filter((listed) => ownNames.has(listed.name))
  const callerLast = [...ownSessions.filter((listed) => listed.name !== callerSession), ...ownSessions.filter((listed) => listed.name === callerSession)]
  for (const session of callerLast) {
    try {
      // `=name` is tmux's exact-match target; a bare name would prefix-match.
      const kill = await deps.runTmux(['kill-session', '-t', `=${session.name}`])
      if (kill.exitCode === 0) {
        result.retired.push(session.name)
        if (session.isAttached) result.wasAttached.push(session.name)
      } else {
        console.error(`retire-task-sessions: could not kill ${session.name}: ${kill.stderr}`)
        result.failures.push({ name: session.name, error: kill.stderr })
      }
    } catch (err) {
      console.error(`retire-task-sessions: could not kill ${session.name}:`, err)
      result.failures.push({ name: session.name, error: errorMessage(err) })
    }
  }
  return result
}

// What markTaskDone calls: reads every task so a session a longer slug owns is
// never retired under this one. If the task list can't be read, nothing is
// killed and the failure is reported, since ownership can't be proven.
export async function retireSessionsOfTask(tasksDir: string, owner: TaskSessionOwner, deps: RetireDeps = defaultRetireDeps): Promise<RetirementResult> {
  let otherSlugs: string[]
  try {
    otherSlugs = (await parseAllTasks(tasksDir)).map((task) => task.slug)
  } catch (err) {
    console.error(`retire-task-sessions: could not read the task list, retiring nothing for ${owner.slug}:`, err)
    return { ...emptyResult(), listError: `could not read the task list: ${errorMessage(err)}` }
  }
  return retireTaskSessions(owner, otherSlugs, deps)
}

export function formatRetirementSummary(result: RetirementResult): string {
  const parts: string[] = []
  if (result.retired.length) {
    const attachedNames = new Set(result.wasAttached)
    parts.push(`retired ${result.retired.map((name) => (attachedNames.has(name) ? `${name} (was attached)` : name)).join(', ')}`)
  }
  if (result.failures.length) parts.push(`failed ${result.failures.map((failure) => `${failure.name} (${failure.error})`).join(', ')}`)
  if (result.listError !== null) parts.push(`could not list tmux sessions (${result.listError})`)
  return `sessions: ${parts.length ? parts.join('; ') : 'none'}`
}
