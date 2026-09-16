import { execa } from 'execa'

export type MergeBlocker =
  | { kind: 'not-open' | 'draft' | 'conflicts' | 'mergeability-unknown' | 'blocked' | 'malformed'; detail: string }
  | { kind: 'check-failed' | 'check-pending'; name: string; link: string | null; detail: string }

export type MergeReadiness =
  | { ready: true; headSha: string; headRefName: string; isCrossRepository: boolean }
  | { ready: false; blockers: MergeBlocker[] }

// One `gh pr view` read carries everything the gate needs: conflict-free
// (mergeable/mergeStateStatus), green (statusCheckRollup), and the exact
// commit + remote branch to act on next (headRefOid/headRefName,
// isCrossRepository) — all from the same atomic read, so a push landing
// between two separate calls can never describe two different commits.
export const GH_PR_VIEW_FIELDS = 'state,isDraft,mergeable,mergeStateStatus,headRefOid,headRefName,isCrossRepository,statusCheckRollup'

const FAILED_CHECK_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'])
const PASSING_CHECK_CONCLUSIONS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])
const PENDING_STATUS_STATES = new Set(['PENDING', 'EXPECTED'])
const FAILED_STATUS_STATES = new Set(['FAILURE', 'ERROR'])

const MALFORMED: MergeReadiness = {
  ready: false,
  blockers: [{ kind: 'malformed', detail: "gh pr view returned data in an unexpected shape — refusing rather than guessing it's ready" }],
}

// Pure. Takes `unknown` (parsed gh JSON, or literally anything checkMergeReadiness
// couldn't parse as JSON at all) and earns the shape inside rather than
// casting at the boundary — this is the one place that decides "ready to
// merge", so drift in gh's own output has to fail closed, not fail open.
export function evaluateMergeReadiness(prView: unknown): MergeReadiness {
  if (!prView || typeof prView !== 'object' || Array.isArray(prView)) return MALFORMED
  const v = prView as Record<string, unknown>

  if (
    typeof v.state !== 'string' ||
    typeof v.isDraft !== 'boolean' ||
    typeof v.mergeable !== 'string' ||
    typeof v.mergeStateStatus !== 'string' ||
    typeof v.headRefOid !== 'string' || !v.headRefOid ||
    typeof v.headRefName !== 'string' || !v.headRefName ||
    typeof v.isCrossRepository !== 'boolean' ||
    !Array.isArray(v.statusCheckRollup)
  ) {
    return MALFORMED
  }

  const blockers: MergeBlocker[] = []
  if (v.state !== 'OPEN') blockers.push({ kind: 'not-open', detail: `PR is not open (state: ${v.state})` })
  if (v.isDraft) blockers.push({ kind: 'draft', detail: 'PR is still a draft' })

  if (v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY') {
    blockers.push({ kind: 'conflicts', detail: 'PR has merge conflicts' })
  } else if (v.mergeable === 'UNKNOWN') {
    blockers.push({ kind: 'mergeability-unknown', detail: "GitHub has not finished computing this PR's mergeability yet" })
  }
  if (v.mergeStateStatus === 'BLOCKED') {
    blockers.push({ kind: 'blocked', detail: 'PR is blocked by a branch protection rule' })
  }

  for (const rawCheck of v.statusCheckRollup) {
    if (!rawCheck || typeof rawCheck !== 'object') return MALFORMED
    const check = rawCheck as Record<string, unknown>

    if (check.__typename === 'CheckRun') {
      if (typeof check.name !== 'string' || !check.name) return MALFORMED
      const link = typeof check.detailsUrl === 'string' ? check.detailsUrl : null
      if (check.status !== 'COMPLETED') {
        blockers.push({ kind: 'check-pending', name: check.name, link, detail: `check \`${check.name}\` is still running` })
      } else if (FAILED_CHECK_CONCLUSIONS.has(check.conclusion as string)) {
        blockers.push({ kind: 'check-failed', name: check.name, link, detail: `check \`${check.name}\` failed` })
      } else if (!PASSING_CHECK_CONCLUSIONS.has(check.conclusion as string)) {
        return MALFORMED
      }
    } else if (check.__typename === 'StatusContext') {
      if (typeof check.context !== 'string' || !check.context) return MALFORMED
      const link = typeof check.targetUrl === 'string' ? check.targetUrl : null
      if (PENDING_STATUS_STATES.has(check.state as string)) {
        blockers.push({ kind: 'check-pending', name: check.context, link, detail: `check \`${check.context}\` is still running` })
      } else if (FAILED_STATUS_STATES.has(check.state as string)) {
        blockers.push({ kind: 'check-failed', name: check.context, link, detail: `check \`${check.context}\` failed` })
      } else if (check.state !== 'SUCCESS') {
        return MALFORMED
      }
    } else {
      return MALFORMED
    }
  }

  if (blockers.length > 0) return { ready: false, blockers }
  return { ready: true, headSha: v.headRefOid, headRefName: v.headRefName, isCrossRepository: v.isCrossRepository }
}

// One line per blocker, in order — the single wording shared by the CLI's
// stdout, the route's 409 `error`, and the dashboard's persistent banner
// (each splits this back apart on '\n').
export function formatMergeBlockers(blockers: MergeBlocker[]): string {
  return blockers.map((b) => b.detail).join('\n')
}

const MERGEABILITY_READ_ATTEMPTS = 3
// Same override precedent as COCKPIT_ORCH_LOCK_TIMEOUT_MS: e2e/unit tests
// shouldn't spend seconds of wall clock proving a refusal the same logic
// proves at a few ms. Read lazily (not a module-level const) so a test can
// set the env var per-case rather than only at process startup.
function mergeabilityRetryDelayMs(): number {
  return Number(process.env.COCKPIT_MERGEABILITY_RETRY_DELAY_MS ?? 2000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Runs `gh pr view <prNumber> --json <fields>`, re-reading while GitHub is
// still computing mergeability (bounded — see MERGEABILITY_READ_ATTEMPTS).
// A gh process failure (non-zero exit — auth, network, no such PR) returns
// `{ ok: false }` and is logged, same as every gitOps.ts helper; gh
// succeeding but printing something that isn't valid JSON is NOT a gate
// failure — it's fed to evaluateMergeReadiness as-is, which reports it
// `malformed` (refuse) rather than this function guessing the PR is safe.
export async function checkMergeReadiness(
  repoPath: string,
  prNumber: string,
): Promise<{ ok: true; readiness: MergeReadiness } | { ok: false; error: string }> {
  for (let attempt = 1; attempt <= MERGEABILITY_READ_ATTEMPTS; attempt++) {
    let stdout: string
    try {
      ;({ stdout } = await execa('gh', ['pr', 'view', prNumber, '--json', GH_PR_VIEW_FIELDS], { cwd: repoPath }))
    } catch (err) {
      console.error(`Failed to read PR #${prNumber}'s merge readiness in ${repoPath}:`, err)
      return { ok: false, error: errorMessage(err) }
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(stdout)
    } catch {
      // Left as null — evaluateMergeReadiness below classifies it malformed.
    }

    const mergeableStillUnknown = !!parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).mergeable === 'UNKNOWN'
    if (mergeableStillUnknown && attempt < MERGEABILITY_READ_ATTEMPTS) {
      await sleep(mergeabilityRetryDelayMs())
      continue
    }

    return { ok: true, readiness: evaluateMergeReadiness(parsed) }
  }
  // Unreachable — the loop always returns by its last iteration.
  throw new Error('checkMergeReadiness: exhausted retries without returning')
}
