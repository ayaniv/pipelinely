// A deliberately small Markdown → HTML renderer for the dashboard's inline
// tech-design.md view.
//
// It lives in src/ rather than in public/index.html for one reason: the
// dashboard has no build step and the repo takes no new npm dependencies, so
// a browser-side parser would be the one piece of escaping-sensitive logic
// the test suite cannot reach. Here, the server hands the browser finished
// HTML and src/markdown.test.ts covers the escaping rules.
//
// Everything is escaped FIRST and no raw HTML from the document is ever
// passed through: a tech-design.md is written by an agent, and a <script> tag
// in one must render as text on the dashboard, not run.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Applied to ALREADY-ESCAPED text. Code spans go first so a ** inside
// backticks is not mistaken for bold.
//
// Link hrefs are allow-listed to http(s), a fragment, or a root-relative
// path; anything else (javascript:, data:) renders as its label alone. The
// href is already escaped at this point, so a quote cannot break out of the
// attribute either.
function renderInline(escaped: string): string {
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^\s]+)\)/g, (_match, text: string, href: string) =>
      /^(https?:\/\/|#|\/)/.test(href)
        ? `<a href="${href}" target="_blank" rel="noopener">${text}</a>`
        : text
    )
}

const FENCE_RE = /^\s*```/
const HEADING_RE = /^(#{1,6})\s+(.*)$/
const HR_RE = /^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/
const TABLE_ROW_RE = /^\s*\|/
const TABLE_DIVIDER_RE = /^\s*\|[\s:|-]+\|\s*$/
const LIST_ITEM_RE = /^\s*([-*]|\d+\.)\s+(.*)$/
// Anything that starts a block, used to decide where a paragraph ends.
const BLOCK_START_RE = /^\s*(```|#{1,6}\s|\||[-*]\s|\d+\.\s)/

// Never throws: an unclosed fence or a malformed table degrades to plainer
// output rather than an error, matching taskParser's tolerance rule.
export function renderMarkdownToHtml(raw: string): string {
  const lines = raw.split('\n')
  const out: string[] = []
  let i = 0

  const cells = (row: string): string[] =>
    row.trim().replace(/^\||\|$/g, '').split('|').map((c) => renderInline(escapeHtml(c.trim())))

  while (i < lines.length) {
    const line = lines[i]

    if (FENCE_RE.test(line)) {
      const body: string[] = []
      i++
      while (i < lines.length && !FENCE_RE.test(lines[i])) {
        body.push(lines[i])
        i++
      }
      i++ // the closing fence, or past the end for an unclosed one
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`)
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${renderInline(escapeHtml(heading[2].trim()))}</h${level}>`)
      i++
      continue
    }

    // Before the list check: "---" is a rule, not a bullet.
    if (HR_RE.test(line)) {
      out.push('<hr>')
      i++
      continue
    }

    if (TABLE_ROW_RE.test(line) && i + 1 < lines.length && TABLE_DIVIDER_RE.test(lines[i + 1])) {
      const head = cells(line)
      i += 2
      const body: string[][] = []
      while (i < lines.length && TABLE_ROW_RE.test(lines[i])) {
        body.push(cells(lines[i]))
        i++
      }
      out.push(
        '<table><thead><tr>' +
        head.map((c) => `<th>${c}</th>`).join('') +
        '</tr></thead><tbody>' +
        body.map((r) => '<tr>' + r.map((c) => `<td>${c}</td>`).join('') + '</tr>').join('') +
        '</tbody></table>'
      )
      continue
    }

    const listStart = line.match(LIST_ITEM_RE)
    if (listStart) {
      const ordered = /\d/.test(listStart[1])
      const items: string[] = []
      while (i < lines.length) {
        const item = lines[i].match(LIST_ITEM_RE)
        if (!item || /\d/.test(item[1]) !== ordered) break
        items.push(`<li>${renderInline(escapeHtml(item[2].trim()))}</li>`)
        i++
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
      continue
    }

    if (!line.trim()) {
      i++
      continue
    }

    const para: string[] = []
    while (i < lines.length && lines[i].trim() && !BLOCK_START_RE.test(lines[i])) {
      para.push(lines[i].trim())
      i++
    }
    if (para.length) {
      out.push(`<p>${renderInline(escapeHtml(para.join(' ')))}</p>`)
    } else {
      // A line that looks like a block start but matched no block rule (e.g.
      // a stray "| dangling"). Skip it — the loop must always advance.
      i++
    }
  }

  return out.join('\n')
}
