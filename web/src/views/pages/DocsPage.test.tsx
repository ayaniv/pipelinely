import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { DocsPage } from './DocsPage'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let queryClient: QueryClient

function mount(fetchImpl: typeof fetch) {
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={queryClient}><MemoryRouter>{children}</MemoryRouter></QueryClientProvider>
  )
  return render(wrap(<DocsPage fetchImpl={fetchImpl} log={vi.fn()} />))
}

beforeEach(() => {
  queryClient = new QueryClient()
})

afterEach(() => {
  document.body.className = ''
})

describe('DocsPage', () => {
  test('renders the fetched guide into the docs body, with no error', async () => {
    mount(vi.fn().mockResolvedValue(jsonResponse(200, { html: '<h1>Guide</h1><h2>One</h2>' })))

    await waitFor(() => expect(screen.getByTestId('docs-body').querySelector('h1')).not.toBeNull())
    expect(screen.getByTestId('docs-body').querySelectorAll('h2')).toHaveLength(1)
    expect(screen.queryByTestId('docs-error')).not.toBeInTheDocument()
  })

  test('a failed load shows the error and leaves the body empty', async () => {
    mount(vi.fn().mockResolvedValue(new Response(null, { status: 500 })))

    expect(await screen.findByTestId('docs-error')).toBeInTheDocument()
    expect(screen.getByTestId('docs-body')).toBeEmptyDOMElement()
  })

  test('a missing guide (404) reads the same as any other failure', async () => {
    mount(vi.fn().mockResolvedValue(new Response(null, { status: 404 })))
    expect(await screen.findByTestId('docs-error')).toBeInTheDocument()
  })

  test('is cached: a second mount shows the guide without asking again', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { html: '<h1>Guide</h1>' }))
    const first = mount(fetchImpl)
    await waitFor(() => expect(screen.getByTestId('docs-body').querySelector('h1')).not.toBeNull())
    first.unmount()

    mount(fetchImpl)

    expect(screen.getByTestId('docs-body').querySelector('h1')).not.toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('hides the board behind it while mounted', async () => {
    const { unmount } = mount(vi.fn().mockResolvedValue(jsonResponse(200, { html: '' })))
    expect(document.body).toHaveClass('full-page-open')
    unmount()
    expect(document.body).not.toHaveClass('full-page-open')
  })
})
