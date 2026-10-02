// Client-side display helpers: rates/cost, token and model formatting, the
// ctx-meter thresholds and relative time. Every React primitive that needs
// these imports from here, so there is exactly one client-side copy.
// (localDateKey, which the server's Done grouping shares, lives in
// src/dateKey.ts.)

const RATES: Record<string, { input: number; output: number }> = {
  'claude-opus-5':     { input: 5, output: 25 },
  'claude-opus-4-8':   { input: 5, output: 25 },
  'claude-sonnet-5':   { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5':  { input: 1, output: 5 },
}

export function computeCost(inputTokens: number, outputTokens: number, model: string | undefined): number {
  const rates = model ? RATES[model] : undefined
  if (!rates) return 0
  return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output
}

export function costIsPriced(model: string | undefined): boolean {
  return !!model && !!RATES[model]
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'K'
  return String(n)
}

export function modelShort(model: string | undefined): string {
  if (!model) return '—'
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

// The tint a stat tile's model name reads in.
export function modelClass(model: string | undefined): string {
  if (!model) return 'model-unknown'
  if (model.includes('opus')) return 'model-opus'
  if (model.includes('sonnet')) return 'model-sonnet'
  if (model.includes('haiku')) return 'model-haiku'
  return 'model-unknown'
}

const COST_YELLOW_FROM_USD = 0.1
const COST_RED_FROM_USD = 0.5

// The colour a stat tile's cost reads at; a dash when the model has no rate,
// since then the number is not a price at all.
export function costClass(cost: number, model: string | undefined): string {
  if (!costIsPriced(model)) return 'cost-dash'
  if (cost < COST_YELLOW_FROM_USD) return 'cost-green'
  if (cost < COST_RED_FROM_USD) return 'cost-yellow'
  return 'cost-red'
}

// Dollars at which a card's COST reads red.
const COST_HIGH_THRESHOLD_USD = 2
export function costIsHigh(cost: number | null): boolean {
  return cost !== null && cost >= COST_HIGH_THRESHOLD_USD
}

// The design's one hot-context rule, shared by every ctx meter (card,
// milestone card, task-detail header).
export const CTX_HOT_THRESHOLD = 60
export function ctxIsHot(ctx: number | null): boolean {
  return ctx !== null && ctx > CTX_HOT_THRESHOLD
}

// The stat-grid/banner warning threshold — distinct from CTX_HOT_THRESHOLD
// above (that's the meter's own tint rule); this is when the bigger
// "⚠ consider /pipelinely-handover" treatment kicks in.
export const CTX_WARN_THRESHOLD = 80

// The three-step color a ctx meter/value reads at, board-card scale.
export function ctxMeterColor(ctx: number | null): string {
  if (ctx === null) return 'var(--bl)'
  if (ctx >= 75) return 'var(--rd)'
  if (ctx >= 45) return 'var(--am)'
  return 'var(--bl)'
}

// A relative time ("5m ago"). `now` is a parameter (defaulting to the
// wall clock) so a caller that ticks on an interval passes the tick's own
// timestamp, and so tests need no fake timers.
export function relTime(when: string | Date, now: number = Date.now()): string {
  // Clamped: `now` can lag a just-written timestamp (a STATUS write is what
  // triggers the SSE push whose updatedAt is newer than the last clock tick).
  const diffSeconds = Math.max(0, Math.floor((now - new Date(when).getTime()) / 1000))
  if (diffSeconds < 60) return `${diffSeconds}s ago`
  if (diffSeconds < 3600) return `${Math.floor(diffSeconds / 60)}m ago`
  if (diffSeconds < 86400) return `${Math.floor(diffSeconds / 3600)}h ago`
  return `${Math.floor(diffSeconds / 86400)}d ago`
}

// A TIMELINE timestamp as "Sep 18, 02:30 PM", or an
// em dash for an unparseable one (never "Invalid Date" on screen).
export function formatWhen(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
