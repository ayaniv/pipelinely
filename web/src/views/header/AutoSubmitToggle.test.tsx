import { afterEach, describe, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { AutoSubmitToggle } from './AutoSubmitToggle'
import { AUTO_SUBMIT_STORAGE_KEY, autoSubmitStore } from '../../data/autoSubmit'

afterEach(() => vi.unstubAllGlobals())

describe('AutoSubmitToggle', () => {
  test('is absent until the access probe says the page is remote, then reflects and flips aria-pressed', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => { storage.set(k, v) } })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ isRemoteAccess: true }), { status: 200 })))
    render(<AutoSubmitToggle />)
    expect(screen.queryByTestId('auto-submit-toggle')).not.toBeInTheDocument()

    await act(() => autoSubmitStore.probeAccessContext())

    const toggle = screen.getByTestId('auto-submit-toggle')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(screen.getByTestId('auto-submit-toggle')).toHaveAttribute('aria-pressed', 'true')
    expect(storage.get(AUTO_SUBMIT_STORAGE_KEY)).toBe('on')
    fireEvent.click(screen.getByTestId('auto-submit-toggle'))
    expect(screen.getByTestId('auto-submit-toggle')).toHaveAttribute('aria-pressed', 'false')
  })
})
