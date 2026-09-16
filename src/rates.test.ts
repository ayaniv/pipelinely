import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// RATES/computeCost/scopeCost live in public/index.html's classic <script>
// — there's no module boundary to import them through (see
// setHtmlIfChanged.test.ts for the same constraint). Extracted from the
// real file and evaluated fresh per call, rather than hand-copied here, so
// this test exercises the actual shipped rate table instead of a second
// copy that could silently drift from it — which is exactly the class of
// bug this test guards against (a stale or missing rate silently producing
// a wrong or zero cost).
let makeRatesModule: () => {
  RATES: Record<string, { input: number; output: number }>
  computeCost: (inputTokens: number, outputTokens: number, model: string) => number
  scopeCost: (rows: Array<{ s: { inputTokens?: number; outputTokens?: number }; model?: string }>) => number | null
}

beforeAll(async () => {
  const indexHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html')
  const source = await fs.readFile(indexHtmlPath, 'utf-8')

  const ratesMatch = source.match(/const RATES = \{[\s\S]*?\n\s*\}\n/)
  if (!ratesMatch) throw new Error('RATES not found in public/index.html — extraction regex is stale')

  const computeCostMatch = source.match(/function computeCost\(inputTokens, outputTokens, model\) \{[\s\S]*?\n\s*\}\n/)
  if (!computeCostMatch) throw new Error('computeCost not found in public/index.html — extraction regex is stale')

  const scopeCostMatch = source.match(/function scopeCost\(rows\) \{[\s\S]*?return priced \? cost : null\n\s*\}\n/)
  if (!scopeCostMatch) throw new Error('scopeCost not found in public/index.html — extraction regex is stale')

  // eslint-disable-next-line no-new-func -- deliberate: evaluating the real,
  // extracted source rather than a hand-copied reimplementation.
  makeRatesModule = new Function(
    `${ratesMatch[0]}\n${computeCostMatch[0]}\n${scopeCostMatch[0]}\nreturn { RATES, computeCost, scopeCost }`
  ) as typeof makeRatesModule
})

describe('RATES', () => {
  it('has the currently published per-million-token rate for every model in use, including claude-opus-5', () => {
    const { RATES } = makeRatesModule()
    expect(RATES['claude-opus-5']).toEqual({ input: 5, output: 25 })
    expect(RATES['claude-opus-4-8']).toEqual({ input: 5, output: 25 })
    expect(RATES['claude-sonnet-5']).toEqual({ input: 2, output: 10 })
    expect(RATES['claude-sonnet-4-6']).toEqual({ input: 3, output: 15 })
    expect(RATES['claude-haiku-4-5']).toEqual({ input: 1, output: 5 })
  })
})

describe('computeCost', () => {
  it('prices claude-opus-5 tokens instead of silently returning 0', () => {
    const { computeCost } = makeRatesModule()
    // 1M input @ $5 + 1M output @ $25
    expect(computeCost(1_000_000, 1_000_000, 'claude-opus-5')).toBe(30)
  })

  it('returns 0 for a model with no rate entry, rather than throwing', () => {
    const { computeCost } = makeRatesModule()
    expect(computeCost(1_000_000, 1_000_000, 'some-unpriced-model')).toBe(0)
  })
})

describe('scopeCost', () => {
  it('sums cost per row at that row\'s own model rate', () => {
    const { scopeCost } = makeRatesModule()
    const rows = [
      { s: { inputTokens: 400_000, outputTokens: 20_000 }, model: 'claude-sonnet-5' },
      { s: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, model: 'claude-opus-5' },
    ]
    // sonnet-5: 0.4*2 + 0.02*10 = 1.0; opus-5: 1*5 + 1*25 = 30
    expect(scopeCost(rows)).toBe(31)
  })

  it('returns null, not 0, when no row has a priced model', () => {
    const { scopeCost } = makeRatesModule()
    const rows = [{ s: { inputTokens: 1_000_000, outputTokens: 1_000_000 }, model: 'some-unpriced-model' }]
    expect(scopeCost(rows)).toBeNull()
  })
})
