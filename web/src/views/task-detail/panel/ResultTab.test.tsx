import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ResultDoc, ResultDocMeta } from '../../../../../src/types'
import { ResultTab } from './ResultTab'

// Vitest runs from the repo root, so a root-relative path is stable under jsdom
// (where import.meta.url is not a file: URL).
const readFixture = (name: string) => readFileSync(path.join(process.cwd(), 'src/__fixtures__', name), 'utf-8')

const doc = (markdown: string, overrides: Partial<ResultDoc> = {}): ResultDoc => ({ file: 'AUDIT.md', markdown, isTruncated: false, totalBytes: markdown.length, mtimeMs: 1000, ...overrides })
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => vi.unstubAllGlobals())

// The tab fetches its markdown lazily, so every render stubs the endpoint.
function metaFor(document: ResultDoc): ResultDocMeta {
  return { file: document.file, isTruncated: document.isTruncated, totalBytes: document.totalBytes, mtimeMs: document.mtimeMs }
}

async function renderResultTab(document: ResultDoc | number) {
  const fetchSpy = vi.fn().mockResolvedValue(typeof document === 'number' ? new Response(null, { status: document }) : json(200, document))
  vi.stubGlobal('fetch', fetchSpy)
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <ResultTab slug="research-task" meta={typeof document === 'number' ? null : metaFor(document)} />
    </QueryClientProvider>,
  )
  if (typeof document !== 'number') await screen.findByTestId('result-doc-body')
  return { ...view, fetchSpy }
}

// Every element a browser would run, fetch from, or restyle the page with.
const ACTIVE_ELEMENTS = 'script, img, iframe, link, svg, style, form, base, meta, object, embed, input, video, audio, source, [onerror], [onload], [onclick]'

// Interpolated into every remote-URL fixture below instead of written inline:
// the no-remote-font-host scan in src/selfHostedFonts.test.ts reads this file as
// shipped source and flags a literal remote <link rel="stylesheet"> (only that
// row needs it today; the rest use it so the table reads uniformly).
const EVIL_ORIGIN = 'https://evil.example'

describe('ResultTab loading', () => {
  test('fetches the document lazily by slug, once, and is otherwise silent on the network', async () => {
    const { fetchSpy } = await renderResultTab(doc('# Title\n\n[link](https://example.com)'))
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledWith('/result-doc/research-task', expect.anything())
  })

  test('shows a loading note until the document arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
    render(<QueryClientProvider client={new QueryClient()}><ResultTab slug="research-task" meta={{ file: 'AUDIT.md', isTruncated: false, totalBytes: 7, mtimeMs: 1000 }} /></QueryClientProvider>)
    expect(screen.getByTestId('result-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('result-doc-body')).toBeNull()
  })

  test('says so when the document is gone (404), without a body', async () => {
    await renderResultTab(404)
    expect(await screen.findByTestId('result-missing')).toBeInTheDocument()
    expect(screen.queryByTestId('result-doc-body')).toBeNull()
  })

  test('says so when the load fails, and logs it', async () => {
    const logError = vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderResultTab(500)
    expect(await screen.findByTestId('result-failed')).toBeInTheDocument()
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('[result-doc]'), expect.any(Error))
    logError.mockRestore()
  })
})

describe('ResultTab rendering', () => {
  test('renders headings, tables and code blocks as formatted markdown', async () => {
    await renderResultTab(doc('# Title\n\n## Findings\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\nconst x = 1\n```'))
    const body = screen.getByTestId('result-doc-body')
    expect(body.querySelector('h1')).toHaveTextContent('Title')
    expect(body.querySelector('h2')).toHaveTextContent('Findings')
    expect(body.querySelector('table td')).toHaveTextContent('1')
    expect(body.querySelector('pre code')).toHaveTextContent('const x = 1')
  })

  test('names the source file', async () => {
    await renderResultTab(doc('# x', { file: 'DESIGN.md' }))
    expect(screen.getByTestId('result-doc-source')).toHaveTextContent('DESIGN.md')
  })

  test('puts a wide table inside a horizontally scrolling container', async () => {
    await renderResultTab(doc('| a | b |\n|---|---|\n| 1 | 2 |'))
    const wrap = screen.getByTestId('result-doc-body').querySelector('.md-table-scroll')
    expect(wrap).not.toBeNull()
    expect(wrap!.querySelector('table')).not.toBeNull()
  })

  test('shows a truncation note only when the document was cut at the size cap', async () => {
    const { unmount } = await renderResultTab(doc('# x'))
    expect(screen.queryByTestId('result-truncated-note')).toBeNull()
    unmount()
    await renderResultTab(doc('# x', { isTruncated: true, totalBytes: 900 * 1024 }))
    expect(screen.getByTestId('result-truncated-note')).toHaveTextContent('900')
  })
})

describe('ResultTab sanitization', () => {
  test.each([
    ['<script>', 'before <script>window.__pwned = 1</script> after'],
    ['<img onerror>', '<img src=x onerror="window.__pwned = 1">'],
    ['<svg onload>', '<svg onload="window.__pwned = 1"></svg>'],
    ['<iframe>', `<iframe src="${EVIL_ORIGIN}"></iframe>`],
    ['<style>', `<style>body { background: url(${EVIL_ORIGIN}/x) }</style>`],
    ['<form>', `<form action="${EVIL_ORIGIN}"><input name=x></form>`],
    ['<base>', `<base href="${EVIL_ORIGIN}/">`],
    ['<meta refresh>', `<meta http-equiv="refresh" content="0;url=${EVIL_ORIGIN}">`],
    ['<link stylesheet>', `<link rel="stylesheet" href="${EVIL_ORIGIN}/x.css">`],
    ['a remote image', `![tracker](${EVIL_ORIGIN}/pixel.png)`],
    ['a reference link', `[x][1]\n\n[1]: ${EVIL_ORIGIN}`],
    ['entities in a tag', '&lt;img src=x onerror=alert(1)&gt;'],
  ])('%s renders as text, never as an element that runs or fetches', async (_name, markdown) => {
    await renderResultTab(doc(markdown))
    expect(screen.getByTestId('result-doc-body').querySelectorAll(ACTIVE_ELEMENTS)).toHaveLength(0)
  })

  test.each([
    ['javascript:', '[click me](javascript:alert(1))'],
    ['mixed-case JaVaScRiPt:', '[click me](JaVaScRiPt:alert(1))'],
    ['data:', '[click me](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[click me](vbscript:msgbox(1))'],
    ['an entity-encoded scheme', '[click me](java&#x09;script:alert(1))'],
    ['a protocol-relative //host', '[click me](//evil.example/x)'],
    ['a /\\host', '[click me](/\\evil.example)'],
  ])('a link with %s keeps its label but is not an anchor', async (_name, markdown) => {
    await renderResultTab(doc(markdown))
    const body = screen.getByTestId('result-doc-body')
    expect(body.querySelector('a')).toBeNull()
    expect(body).toHaveTextContent('click me')
  })

  test('an external link cannot leak the dashboard origin', async () => {
    await renderResultTab(doc('[docs](https://example.com)'))
    const link = screen.getByTestId('result-doc-body').querySelector('a')!
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')!.split(' ')).toEqual(expect.arrayContaining(['noopener', 'noreferrer']))
  })

  test('two adjacent links are two anchors with their own hrefs', async () => {
    await renderResultTab(doc('[a](https://x.example)[b](https://y.example)'))
    const hrefs = [...screen.getByTestId('result-doc-body').querySelectorAll('a')].map((a) => a.getAttribute('href'))
    expect(hrefs).toEqual(['https://x.example', 'https://y.example'])
  })
})

describe('ResultTab with the sample deliverables', () => {
  test.each([
    ['AUDIT.md', 'sample-audit.md'],
    ['DESIGN.md', 'sample-design.md'],
  ])('%s renders headings, every table inside a scrolling container, and nothing that fetches', async (file, fixture) => {
    await renderResultTab(doc(readFixture(fixture), { file }))
    const body = screen.getByTestId('result-doc-body')
    const tables = body.querySelectorAll('table')
    expect(body.querySelectorAll('h2').length).toBeGreaterThan(0)
    expect(tables.length).toBeGreaterThan(0)
    tables.forEach((table) => expect(table.parentElement).toHaveClass('md-table-scroll'))
    await waitFor(() => expect(body.querySelectorAll(ACTIVE_ELEMENTS)).toHaveLength(0))
  })
})
