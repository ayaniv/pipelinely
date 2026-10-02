import type { Stage } from './types.js'

export interface AutoAction {
  slug: string
  stage: Stage
  // Set when QA is not applicable: record a skip instead of dispatching.
  skipReason?: string
}

export interface AutoActionHandlers {
  dispatch: (slug: string, stage: Stage) => Promise<void>
  skipQa: (slug: string, reason: string) => Promise<void>
}

// Executes the auto pass's decided actions strictly in order: all dispatches
// share the one orchestrator session, so two in flight would interleave
// keystrokes. Split out of server.ts so the skip-vs-dispatch wiring is testable.
export async function runAutoActions(actions: readonly AutoAction[], handlers: AutoActionHandlers): Promise<void> {
  for (const { slug, stage, skipReason } of actions) {
    if (skipReason) await handlers.skipQa(slug, skipReason)
    else await handlers.dispatch(slug, stage)
  }
}
