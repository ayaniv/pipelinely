import { describe, expect, test } from 'vitest'
import { isBabysitWired } from './babysitWiring'

describe('isBabysitWired', () => {
  test('is true now the /pipelinely-babysit skill is wired behind pushForward(), so the Push forward pill renders', () => {
    expect(isBabysitWired()).toBe(true)
  })
})
