import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useBodyClass } from './useBodyClass'

afterEach(() => document.body.classList.remove('detail-open'))

describe('useBodyClass', () => {
  it('adds the class while mounted and removes it on unmount', () => {
    const { unmount } = renderHook(() => useBodyClass('detail-open'))
    expect(document.body).toHaveClass('detail-open')
    unmount()
    expect(document.body).not.toHaveClass('detail-open')
  })

  it('follows isOn as it flips', () => {
    const { rerender } = renderHook(({ isOn }) => useBodyClass('detail-open', isOn), { initialProps: { isOn: false } })
    expect(document.body).not.toHaveClass('detail-open')
    rerender({ isOn: true })
    expect(document.body).toHaveClass('detail-open')
    rerender({ isOn: false })
    expect(document.body).not.toHaveClass('detail-open')
  })

  it("leaves the body's other classes alone", () => {
    document.body.classList.add('theme-x')
    const { unmount } = renderHook(() => useBodyClass('detail-open'))
    unmount()
    expect(document.body).toHaveClass('theme-x')
    document.body.classList.remove('theme-x')
  })
})
