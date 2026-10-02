import { describe, expect, test } from 'vitest'
import { focusStepForKey } from './chainFocus'

describe('focusStepForKey', () => {
  test('in an LTR document ArrowRight is next and ArrowLeft is previous', () => {
    expect(focusStepForKey('ArrowRight', 'ltr')).toBe(1)
    expect(focusStepForKey('ArrowLeft', 'ltr')).toBe(-1)
  })

  test('in an RTL document the arrows swap, following the reading direction', () => {
    expect(focusStepForKey('ArrowRight', 'rtl')).toBe(-1)
    expect(focusStepForKey('ArrowLeft', 'rtl')).toBe(1)
  })

  test('every other key is ignored', () => {
    expect(focusStepForKey('ArrowDown', 'ltr')).toBe(0)
    expect(focusStepForKey('Enter', 'rtl')).toBe(0)
  })
})
