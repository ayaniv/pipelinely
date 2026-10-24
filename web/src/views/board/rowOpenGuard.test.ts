import { afterEach, describe, expect, test } from 'vitest'
import { shouldIgnoreOpenClick } from './rowOpenGuard'

function clickOn(html: string, targetSelector: string): { row: HTMLElement; event: { target: EventTarget; currentTarget: EventTarget } } {
  document.body.innerHTML = `<div id="row">${html}</div>`
  const row = document.getElementById('row')!
  return { row, event: { target: row.querySelector(targetSelector) ?? row, currentTarget: row } }
}

describe('shouldIgnoreOpenClick', () => {
  afterEach(() => { document.body.innerHTML = ''; window.getSelection()?.removeAllRanges() })

  test('a plain cell click opens the task', () => {
    const { event } = clickOn('<span id="t">x</span>', '#t')
    expect(shouldIgnoreOpenClick(event)).toBe(false)
  })

  test.each([['button', '<button id="t">b</button>'], ['link', '<a id="t" href="/x">a</a>'], ['menu', '<div class="card-menu"><span id="t">i</span></div>']])(
    'a %s target is ignored', (_label, html) => {
      const { event } = clickOn(html, '#t')
      expect(shouldIgnoreOpenClick(event)).toBe(true)
    })

  test('a click that ends a selection inside the row is ignored', () => {
    const { row, event } = clickOn('<span id="t">some text</span>', '#t')
    window.getSelection()!.selectAllChildren(row)
    expect(shouldIgnoreOpenClick(event)).toBe(true)
  })

  test('a collapsed selection does not block opening', () => {
    const { row, event } = clickOn('<span id="t">some text</span>', '#t')
    window.getSelection()!.collapse(row, 0)
    expect(shouldIgnoreOpenClick(event)).toBe(false)
  })

  test('a selection elsewhere on the page does not block opening', () => {
    document.body.innerHTML = '<p id="other">elsewhere</p><div id="row"><span id="t">x</span></div>'
    window.getSelection()!.selectAllChildren(document.getElementById('other')!)
    const row = document.getElementById('row')!
    expect(shouldIgnoreOpenClick({ target: row.querySelector('#t')!, currentTarget: row })).toBe(false)
  })
})
