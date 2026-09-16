import { withFixtureLock } from './fixtureLock.js'
import { assertIsolatedEnvironment } from '../../src/e2eIsolation.js'

// Module-scope, deliberately — see itermSessions.ts's identical comment and
// src/e2eIsolation.ts. This file doesn't itself shell out, but it gates
// read/write access to the real ORCHESTRATOR_SESSION pointer's fixture
// stand-in, so the same guard applies.
assertIsolatedEnvironment()

// The lock covers SETTINGS.json too, not just ORCHESTRATOR_SESSION: auto
// mode being on globally changes what the server DOES with any task's STATUS
// write (see orchestrator-auto-mode.spec.ts), so a spec that flips it while
// another spec is mid-dispatch races just as badly as two specs stomping on
// the session pointer. Same rule, same lock.
//
// ORCHESTRATOR_SESSION is a single fixture file shared by every e2e spec
// that dispatches "into the orchestrator" (pipeline-stage-cta.spec.ts,
// qa-case-list.spec.ts, resume-dead-session-fallback.spec.ts). Playwright
// runs spec files in separate parallel workers by default (fullyParallel),
// so without this lock two tests in different files can stomp on each
// other's ORCHESTRATOR_SESSION mid-test — one test's real scratch iTerm2
// session gets registered as "the orchestrator" out from under another
// test's assertion that no orchestrator is reachable (surfaced by
// resume-dead-session-fallback.spec.ts flaking against qa-case-list.spec.ts's
// real-session dispatch test). Every test that reads or writes
// ORCHESTRATOR_SESSION for the duration of a scenario must acquire this
// lock first.
//
// The same applies to ORCHESTRATOR_TMUX, which
// orchestrator-session-self-heal.spec.ts writes alongside it: the server's
// reattach path reads the two together as one unit, so a test holding the
// lock for only one of them could still be raced on the other.
//
// The spin-on-exclusive-create mechanism itself lives in fixtureLock.ts,
// shared with withBacklogFileLock — including the ordering rule that
// applies when a test needs both locks.
export async function withOrchestratorSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  return withFixtureLock('orchestrator-session', fn)
}
