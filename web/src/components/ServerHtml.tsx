import './ServerHtml.css'

// Rendered markdown (GET /tech-design/:slug's `html` and `summaryHtml`, and the
// Result tab's own renderMarkdownToHtml call). The one remaining rich-HTML
// insertion in the panel: renderMarkdownToHtml (src/markdown.ts) HTML-escapes every input
// line before it adds its own tags, so the string is markup the server built
// from local task files, never markup taken from them. Everything else in
// the panel renders through React and needs no such escape hatch.

export interface ServerHtmlProps {
  testId: string
  className?: string
  html: string
}

export function ServerHtml({ testId, className, html }: ServerHtmlProps) {
  return <div data-testid={testId} className={className} dangerouslySetInnerHTML={{ __html: html }} />
}
