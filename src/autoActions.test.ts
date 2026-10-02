import { describe, expect, it, vi } from 'vitest'
import { runAutoActions } from './autoActions.js'

describe('runAutoActions', () => {
  const handlers = () => ({ dispatch: vi.fn().mockResolvedValue(undefined), skipQa: vi.fn().mockResolvedValue(undefined) })

  it('records a skip, and pastes nothing, for an entry carrying a skipReason', async () => {
    const h = handlers()
    await runAutoActions([{ slug: 'a', stage: 'qa', skipReason: 'no e2e' }], h)
    expect(h.skipQa).toHaveBeenCalledWith('a', 'no e2e')
    expect(h.dispatch).not.toHaveBeenCalled()
  })

  it('dispatches an ordinary entry', async () => {
    const h = handlers()
    await runAutoActions([{ slug: 'a', stage: 'code-review' }], h)
    expect(h.dispatch).toHaveBeenCalledWith('a', 'code-review')
    expect(h.skipQa).not.toHaveBeenCalled()
  })

  it('runs entries strictly in order, one at a time', async () => {
    const order: string[] = []
    const h = {
      dispatch: vi.fn(async (slug: string) => { order.push(`start ${slug}`); await Promise.resolve(); order.push(`end ${slug}`) }),
      skipQa: vi.fn(),
    }
    await runAutoActions([{ slug: 'a', stage: 'dev' }, { slug: 'b', stage: 'dev' }], h)
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b'])
  })
})
