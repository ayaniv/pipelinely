import { describe, it, expect } from 'vitest'
import { renderMarkdownToHtml } from './markdown.js'

describe('renderMarkdownToHtml', () => {
  it('renders headings at their level', () => {
    expect(renderMarkdownToHtml('## Milestones')).toBe('<h2>Milestones</h2>')
    expect(renderMarkdownToHtml('#### Deep')).toBe('<h4>Deep</h4>')
  })

  it('joins consecutive lines into one paragraph', () => {
    expect(renderMarkdownToHtml('one\ntwo')).toBe('<p>one two</p>')
  })

  it('separates paragraphs on a blank line', () => {
    expect(renderMarkdownToHtml('one\n\ntwo')).toBe('<p>one</p>\n<p>two</p>')
  })

  it('renders an unordered list', () => {
    expect(renderMarkdownToHtml('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
  })

  it('renders an ordered list', () => {
    expect(renderMarkdownToHtml('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  it('renders a pipe table', () => {
    const out = renderMarkdownToHtml('| A | B |\n|---|---|\n| 1 | 2 |')
    expect(out).toBe('<div class="md-table-scroll"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>')
  })

  it('keeps a fenced code block verbatim, without inline formatting', () => {
    const out = renderMarkdownToHtml('```\nconst a = **not bold**\n```')
    expect(out).toBe('<pre><code>const a = **not bold**</code></pre>')
  })

  it('renders a horizontal rule', () => {
    expect(renderMarkdownToHtml('---')).toBe('<hr>')
  })

  it('renders inline code, bold and italic', () => {
    expect(renderMarkdownToHtml('a `b` **c** *d*')).toBe('<p>a <code>b</code> <strong>c</strong> <em>d</em></p>')
  })

  it('does not treat ** inside backticks as bold', () => {
    expect(renderMarkdownToHtml('`a ** b`')).toBe('<p><code>a ** b</code></p>')
  })

  it('renders an http link and opens it in a new tab', () => {
    expect(renderMarkdownToHtml('[go](https://example.com)'))
      .toBe('<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">go</a></p>')
  })

  it('strips a link whose href is not http, a fragment, or a root path', () => {
    // The label survives; the dangerous href does not become an anchor at all.
    const out = renderMarkdownToHtml('[click](javascript:alert(1))')
    expect(out).toBe('<p>click</p>')
    expect(out).not.toContain('javascript:')
  })

  it('escapes HTML in body text so a plan cannot inject markup', () => {
    const out = renderMarkdownToHtml('before <script>alert(1)</script> after')
    expect(out).toBe('<p>before &lt;script&gt;alert(1)&lt;/script&gt; after</p>')
    expect(out).not.toContain('<script>')
  })

  it('escapes HTML inside headings, list items, table cells and code blocks', () => {
    expect(renderMarkdownToHtml('# <b>x</b>')).toBe('<h1>&lt;b&gt;x&lt;/b&gt;</h1>')
    expect(renderMarkdownToHtml('- <b>x</b>')).toBe('<ul><li>&lt;b&gt;x&lt;/b&gt;</li></ul>')
    expect(renderMarkdownToHtml('| <b>x</b> |\n|---|\n| <i>y</i> |'))
      .toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(renderMarkdownToHtml('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>')
  })

  it('returns an empty string for an empty document', () => {
    expect(renderMarkdownToHtml('')).toBe('')
  })

  it('terminates on a stray pipe line that is not a table', () => {
    // Regression guard: the block scanner must always advance.
    expect(renderMarkdownToHtml('| dangling')).toBe('')
  })
})

// Every href that made it into the output, and every tag name the renderer
// emitted, so the tests below can assert on what a browser would act on.
const hrefsIn = (html: string) => [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])
const tagsIn = (html: string) => new Set([...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase()))
// Tags that fetch, run or restyle something: none may ever be emitted.
const ACTIVE_TAGS = ['script', 'img', 'iframe', 'link', 'svg', 'style', 'form', 'base', 'meta', 'object', 'embed', 'input', 'video', 'audio', 'source']

describe('renderMarkdownToHtml link parsing', () => {
  it('turns two adjacent links into two anchors', () => {
    expect(hrefsIn(renderMarkdownToHtml('[a](https://x.example)[b](https://y.example)'))).toEqual(['https://x.example', 'https://y.example'])
  })

  it('never lets code, bold or italic markup end up inside an href', () => {
    const out = renderMarkdownToHtml('[a](https://x.example/`b`) and [c](https://x.example/**d**) and [e](https://x.example/*f*g*)')
    for (const href of hrefsIn(out)) expect(href).not.toMatch(/[<>]/)
    expect(hrefsIn(out)).toEqual(['https://x.example/`b`', 'https://x.example/**d**', 'https://x.example/*f*g*'])
  })

  it('still formats the label of a link', () => {
    expect(renderMarkdownToHtml('[**bold** `code`](https://x.example)')).toContain('<a href="https://x.example" target="_blank" rel="noopener noreferrer"><strong>bold</strong> <code>code</code></a>')
  })

  it('does not link inside a code span', () => {
    expect(renderMarkdownToHtml('`[a](https://x.example)`')).toBe('<p><code>[a](https://x.example)</code></p>')
  })

  it('keeps a query string with an ampersand as one escaped href', () => {
    expect(hrefsIn(renderMarkdownToHtml('[q](https://x.example/?a=1&b=2)'))).toEqual(['https://x.example/?a=1&amp;b=2'])
  })
})

describe('renderMarkdownToHtml unsafe input', () => {
  it.each([
    ['javascript:', '[x](javascript:alert(1))'],
    ['mixed-case javascript:', '[x](JaVaScRiPt:alert(1))'],
    ['data:', '[x](data:text/html;base64,PHNjcmlwdD4=)'],
    ['vbscript:', '[x](vbscript:msgbox(1))'],
    ['entity-encoded scheme', '[x](java&#x09;script:alert(1))'],
    ['numeric-entity scheme', '[x](&#106;avascript:alert(1))'],
    ['protocol-relative //host', '[x](//evil.example/x)'],
    ['slash-backslash /\\host', '[x](/\\evil.example)'],
    ['backslash-slash', '[x](\\/evil.example)'],
    ['file:', '[x](file:///etc/passwd)'],
    ['reference link', '[x][1]\n\n[1]: javascript:alert(1)'],
    ['autolink', '<javascript:alert(1)>'],
  ])('%s produces no anchor', (_name, markdown) => {
    expect(hrefsIn(renderMarkdownToHtml(markdown))).toEqual([])
  })

  it.each([
    ['https', '[x](https://x.example/a)', 'https://x.example/a'],
    ['http', '[x](http://x.example/a)', 'http://x.example/a'],
    ['fragment', '[x](#section)', '#section'],
    ['root-relative path', '[x](/task/foo)', '/task/foo'],
  ])('still allows a %s link', (_name, markdown, href) => {
    expect(hrefsIn(renderMarkdownToHtml(markdown))).toEqual([href])
  })

  it.each([
    ['script', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg onload=alert(1)>'],
    ['iframe', '<iframe src="https://evil.example"></iframe>'],
    ['style', '<style>body{background:url(https://evil.example)}</style>'],
    ['form', '<form action="https://evil.example"><input name=x></form>'],
    ['base', '<base href="https://evil.example/">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example">'],
    ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">'],
    ['remote image', '![tracker](https://evil.example/pixel.png)'],
    ['remote image in a table cell', '| a |\n|---|\n| ![t](https://evil.example/p.png) |'],
    ['tag inside a heading', '# <img src=x onerror=alert(1)>'],
    ['tag inside a list item', '- <iframe src=x></iframe>'],
  ])('%s never becomes an element that runs or fetches', (_name, markdown) => {
    const tags = tagsIn(renderMarkdownToHtml(markdown))
    for (const tag of ACTIVE_TAGS) expect(tags.has(tag)).toBe(false)
  })

  it('renders a remote image as a plain link, not an image', () => {
    const out = renderMarkdownToHtml('![tracker](https://evil.example/pixel.png)')
    expect(tagsIn(out).has('img')).toBe(false)
    expect(hrefsIn(out)).toEqual(['https://evil.example/pixel.png'])
  })
})

