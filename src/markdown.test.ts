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
    expect(out).toBe('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>')
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
      .toBe('<p><a href="https://example.com" target="_blank" rel="noopener">go</a></p>')
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
