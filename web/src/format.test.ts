import { describe, it, expect } from 'vitest'
import { computeCost, formatTokens, modelShort, modelClass, costClass, costIsHigh, ctxIsHot, ctxMeterColor, relTime, formatWhen, CTX_HOT_THRESHOLD, CTX_WARN_THRESHOLD } from './format'

// The published per-million-token rate for every model in use. A stale or
// missing rate silently produces a wrong or zero cost, which is exactly what
// these pin.
describe('RATES', () => {
  it.each([
    ['claude-opus-5', 5, 25],
    ['claude-opus-4-8', 5, 25],
    ['claude-sonnet-5', 2, 10],
    ['claude-sonnet-4-6', 3, 15],
    ['claude-haiku-4-5', 1, 5],
  ])('%s is priced at $%i in / $%i out per million tokens', (model, input, output) => {
    expect(computeCost(1_000_000, 0, model)).toBe(input)
    expect(computeCost(0, 1_000_000, model)).toBe(output)
  })
})

describe('computeCost', () => {
  it('prices tokens at the given model\'s per-million rate', () => {
    // claude-sonnet-5: input $2/M, output $10/M
    expect(computeCost(1_000_000, 1_000_000, 'claude-sonnet-5')).toBe(12)
  })

  it('returns 0 for an unpriced or missing model', () => {
    expect(computeCost(1_000_000, 1_000_000, 'some-unknown-model')).toBe(0)
    expect(computeCost(1_000_000, 1_000_000, undefined)).toBe(0)
  })
})

describe('formatTokens', () => {
  it('formats millions with one decimal', () => {
    expect(formatTokens(2_500_000)).toBe('2.5M')
  })
  it('formats thousands rounded to an integer', () => {
    expect(formatTokens(12_400)).toBe('12K')
  })
  it('formats small counts verbatim', () => {
    expect(formatTokens(42)).toBe('42')
  })
})

describe('modelShort', () => {
  it('maps a known model family to its short label', () => {
    expect(modelShort('claude-opus-5')).toBe('Opus')
    expect(modelShort('claude-sonnet-5')).toBe('Sonnet')
    expect(modelShort('claude-haiku-4-5')).toBe('Haiku')
  })
  it('falls back to the raw string for an unrecognized model', () => {
    expect(modelShort('some-future-model')).toBe('some-future-model')
  })
  it('falls back to an em dash for no model', () => {
    expect(modelShort(undefined)).toBe('—')
  })
})

describe('ctxIsHot', () => {
  it('is hot strictly above the threshold', () => {
    expect(ctxIsHot(CTX_HOT_THRESHOLD + 1)).toBe(true)
    expect(ctxIsHot(CTX_HOT_THRESHOLD)).toBe(false)
    expect(ctxIsHot(null)).toBe(false)
  })
})

describe('ctxMeterColor', () => {
  it('reads red at/above the warn threshold', () => {
    expect(ctxMeterColor(CTX_WARN_THRESHOLD)).toBe('var(--rd)')
  })
  it('reads amber in the mid band', () => {
    expect(ctxMeterColor(50)).toBe('var(--am)')
  })
  it('reads blue below the mid band, and for null', () => {
    expect(ctxMeterColor(10)).toBe('var(--bl)')
    expect(ctxMeterColor(null)).toBe('var(--bl)')
  })
})

describe('relTime', () => {
  const NOW = new Date('2026-09-23T12:00:00Z').getTime()
  const ago = (ms: number) => new Date(NOW - ms).toISOString()

  it('reads seconds under a minute', () => {
    expect(relTime(ago(5_000), NOW)).toBe('5s ago')
  })
  it('reads minutes under an hour', () => {
    expect(relTime(ago(5 * 60_000), NOW)).toBe('5m ago')
  })
  it('reads hours under a day', () => {
    expect(relTime(ago(3 * 3_600_000), NOW)).toBe('3h ago')
  })
  it('reads days beyond that', () => {
    expect(relTime(ago(2 * 86_400_000), NOW)).toBe('2d ago')
  })
  it('accepts a Date as well as an ISO string', () => {
    expect(relTime(new Date(NOW - 90_000), NOW)).toBe('1m ago')
  })
  it('never reads negative when the timestamp is newer than the clock tick', () => {
    expect(relTime(new Date(NOW + 17_000), NOW)).toBe('0s ago')
  })
})

describe('formatWhen', () => {
  it('formats a valid ISO timestamp with month, day and time', () => {
    expect(formatWhen('2026-08-10T14:05:00Z')).toBe(new Date('2026-08-10T14:05:00Z').toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
  })
  it('is an em dash for an unparseable timestamp, never "Invalid Date"', () => {
    expect(formatWhen('not a date')).toBe('—')
    expect(formatWhen('')).toBe('—')
  })
})

describe('modelClass', () => {
  it('names the model family a stat tile is tinted by', () => {
    expect(modelClass('claude-opus-5')).toBe('model-opus')
    expect(modelClass('claude-sonnet-5')).toBe('model-sonnet')
    expect(modelClass('claude-haiku-4-5')).toBe('model-haiku')
  })

  it('falls back to unknown for a missing or unrecognised model', () => {
    expect(modelClass(undefined)).toBe('model-unknown')
    expect(modelClass('some-other-model')).toBe('model-unknown')
  })
})

describe('costClass', () => {
  it('steps green, yellow, red at $0.10 and $0.50 for a priced model', () => {
    expect(costClass(0.09, 'claude-sonnet-5')).toBe('cost-green')
    expect(costClass(0.1, 'claude-sonnet-5')).toBe('cost-yellow')
    expect(costClass(0.5, 'claude-sonnet-5')).toBe('cost-red')
  })

  it('is a dash for an unpriced or missing model, whatever the number', () => {
    expect(costClass(5, 'some-other-model')).toBe('cost-dash')
    expect(costClass(5, undefined)).toBe('cost-dash')
  })
})

describe('costIsHigh', () => {
  it('flags a cost at or above the threshold, and never a missing one', () => {
    expect(costIsHigh(1.99)).toBe(false)
    expect(costIsHigh(2)).toBe(true)
    expect(costIsHigh(null)).toBe(false)
  })
})
