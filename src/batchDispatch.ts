// Composing and validating a batch-dispatch message is a self-contained
// concern with its own unit-test file — own module rather than another
// export on taskParser.ts (already 2173 lines), matching derivePort.ts /
// markdown.ts / orchestratorLock.ts precedent.

// A backlog item as it travels from the client through a batch-dispatch
// request to RENDER_ITEM.backlog — one named shape so a field added to it
// (like `project`) only needs updating in one place.
export interface BacklogBatchItem {
  description: string
  context?: string
  project?: string
}

export type BatchDispatchRequest =
  | { kind: 'wave'; slugs: string[] }
  | { kind: 'backlog'; items: BacklogBatchItem[] }

// The one bare-token charset shared by every directory-safe/shell-safe
// identifier this codebase guards: task/milestone slugs (minted by
// cockpit-planning — see taskParser's MILESTONE_SLUG_RE for the "<parent>-mN"
// shape those extend) and a backlog item's project tag (taskParser.ts's
// isBacklogProject). Guards a wave batch's slugs before they're concatenated
// into the staged /cockpit-dev command — same reasoning as
// buildTmuxAttachCommand's SAFE_TMUX_SESSION_NAME in focusTab.ts. Shared by
// POST /batch-dispatch and POST /stage-skill/:slug's orchestrator branch
// (server.ts), which needs the identical guard for its own slug arg.
export const SAFE_TOKEN = /^[a-zA-Z0-9_.-]+$/

const BATCH_NOUN = { wave: 'milestones', backlog: 'backlog items' } as const
const BATCH_SINGULAR = { wave: 'milestone', backlog: 'backlog item' } as const

const RENDER_ITEM = {
  wave: (slug: string) => `/cockpit-dev ${slug}`,
  backlog: (item: BacklogBatchItem) => {
    const prefix = item.project ? `[${item.project}] ` : ''
    return item.context ? `${prefix}${item.description} — ${item.context}` : `${prefix}${item.description}`
  },
}

// The exact clause POST /backlog/dispatch splices into its pasted message
// when a backlog item carries a project — one definition shared by single
// and batch dispatch so they can't word it differently.
export function renderBacklogProjectClause(project: string | null | undefined): string {
  return project ? ` (project: ${project})` : ''
}

function composeMessage(kind: 'wave' | 'backlog', renderedItems: string[]): string {
  const text = renderedItems.length === 1
    ? `Dispatch this ${BATCH_SINGULAR[kind]}: ${renderedItems[0]}`
    : `Dispatch these ${renderedItems.length} ${BATCH_NOUN[kind]} in parallel: ` +
      renderedItems.map((item, i) => `(${i + 1}) ${item}`).join('; ')

  // The safety invariant, not a formatting preference: a newline through
  // writeToOrchestrator's stageInSession write path is a real LF keystroke
  // (escapeForAppleScriptString in focusTab.ts), which IS a submit. Collapsing
  // whitespace here — the cheapest and most reliable place to hold it — is
  // what keeps an item whose context sits on its own line in BACKLOG.md from
  // composing a message that submits itself halfway through.
  return text.replace(/\s+/g, ' ').trim()
}

// Takes `unknown`, not BatchDispatchRequest: the only caller feeds it
// req.body, which is untrusted JSON, so the type must be earned inside this
// function rather than asserted at its boundary. Returns the single-line
// message to stage, or null when the request is unusable — the caller turns
// null into a 400 rather than staging something malformed into a live
// session. A slugs/items element that doesn't fit the expected shape makes
// the whole request null rather than being silently skipped — a `slugs`
// array containing `{}` must not compose "Dispatch this milestone:
// /cockpit-dev [object Object]".
export function composeBatchMessage(request: unknown): string | null {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null
  const kind = (request as Record<string, unknown>).kind
  if (kind !== 'wave' && kind !== 'backlog') return null

  if (kind === 'wave') {
    const slugs = (request as Record<string, unknown>).slugs
    if (!Array.isArray(slugs) || slugs.length === 0) return null
    const rendered: string[] = []
    for (const slug of slugs) {
      if (typeof slug !== 'string' || !SAFE_TOKEN.test(slug)) return null
      rendered.push(RENDER_ITEM.wave(slug))
    }
    return composeMessage('wave', rendered)
  }

  const items = (request as Record<string, unknown>).items
  if (!Array.isArray(items) || items.length === 0) return null
  const rendered: string[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return null
    const description = (item as Record<string, unknown>).description
    if (typeof description !== 'string' || !description.trim()) return null
    const context = (item as Record<string, unknown>).context
    const project = (item as Record<string, unknown>).project
    if (project !== undefined && (typeof project !== 'string' || !SAFE_TOKEN.test(project))) return null
    rendered.push(RENDER_ITEM.backlog({
      description: description.trim(),
      context: typeof context === 'string' ? context : undefined,
      project: typeof project === 'string' ? project : undefined,
    }))
  }
  return composeMessage('backlog', rendered)
}
