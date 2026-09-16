import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// setHtmlIfChanged lives in public/index.html's classic <script> — there's
// no module boundary to import it through, and no jsdom dependency in this
// repo to justify adding just for one helper. Extracted from the real file
// and evaluated fresh per call, rather than hand-copied here, so this test
// exercises the actual shipped implementation (including its own
// `lastRenderedHtml` WeakMap) instead of a second copy that could silently
// drift from it. A plain object stands in for a DOM element: the function
// only ever reads/writes `.innerHTML` as a property and uses the element as
// a WeakMap key, neither of which needs a real DOM.
let makeSetHtmlIfChanged: () => (el: { innerHTML: string }, html: string) => boolean

beforeAll(async () => {
  const indexHtmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'index.html')
  const source = await fs.readFile(indexHtmlPath, 'utf-8')
  const match = source.match(/const lastRenderedHtml = new WeakMap\(\)\s*\n\s*function setHtmlIfChanged\(el, html\) \{[\s\S]*?\n\s*\}\n/)
  if (!match) throw new Error('setHtmlIfChanged not found in public/index.html — extraction regex is stale')
  // eslint-disable-next-line no-new-func -- deliberate: evaluating the
  // real, extracted source rather than a hand-copied reimplementation.
  makeSetHtmlIfChanged = new Function(`${match[0]}\nreturn setHtmlIfChanged`) as typeof makeSetHtmlIfChanged
})

describe('setHtmlIfChanged', () => {
  it('writes on the first call for a given element', () => {
    const setHtmlIfChanged = makeSetHtmlIfChanged()
    const el = { innerHTML: '' }
    expect(setHtmlIfChanged(el, '<b>a</b>')).toBe(true)
    expect(el.innerHTML).toBe('<b>a</b>')
  })

  it('writes again when the new html actually differs from the last write', () => {
    const setHtmlIfChanged = makeSetHtmlIfChanged()
    const el = { innerHTML: '' }
    setHtmlIfChanged(el, '<b>a</b>')
    expect(setHtmlIfChanged(el, '<b>b</b>')).toBe(true)
    expect(el.innerHTML).toBe('<b>b</b>')
  })

  it('skips the write when the html is byte-identical to the last write', () => {
    const setHtmlIfChanged = makeSetHtmlIfChanged()
    const el = { innerHTML: '' }
    setHtmlIfChanged(el, '<b>a</b>')
    expect(setHtmlIfChanged(el, '<b>a</b>')).toBe(false)
  })

  it('compares against the last string it actually wrote, not the element\'s current innerHTML', () => {
    // The whole reason this exists: a real browser re-serializes markup on
    // read, so comparing against el.innerHTML would never compare equal and
    // the guard would never skip anything. Mutating el.innerHTML out from
    // under it (standing in for that re-serialization) and confirming the
    // guard still skips — leaving the mutation in place — proves it isn't
    // reading el.innerHTML back at all.
    const setHtmlIfChanged = makeSetHtmlIfChanged()
    const el = { innerHTML: '' }
    setHtmlIfChanged(el, '<b>a</b>')
    el.innerHTML = 'mutated out from under it'
    expect(setHtmlIfChanged(el, '<b>a</b>')).toBe(false)
    expect(el.innerHTML).toBe('mutated out from under it')
  })

  it('tracks each element independently', () => {
    const setHtmlIfChanged = makeSetHtmlIfChanged()
    const elA = { innerHTML: '' }
    const elB = { innerHTML: '' }
    setHtmlIfChanged(elA, '<b>same</b>')
    expect(setHtmlIfChanged(elB, '<b>same</b>')).toBe(true)
    expect(elB.innerHTML).toBe('<b>same</b>')
  })
})
