import './ResultTab.css'
import { useMemo } from 'react'
import type { ResultDoc, ResultDocMeta } from '../../../../../src/types'
import { renderMarkdownToHtml } from '../../../../../src/markdown'
import { ServerHtml } from '../../../components/ServerHtml'
import { useResultDoc } from '../../../data/taskResources'
import { PanelNote } from './PanelLayout'

// A research task's deliverable (RESULT.md, AUDIT.md, DESIGN.md, ...) as
// formatted markdown. The snapshot only says a document exists; the markdown is
// fetched here, when the tab opens (GET /result-doc/:slug). It goes through the
// same renderer as the Plan tab, which escapes every input line and only allows
// http(s)/fragment/root-relative links, so a worker's raw HTML or javascript:
// link renders as text — see src/markdown.ts. Rendering itself makes no request.

function formatKilobytes(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`
}

function ResultDocument({ doc }: { doc: ResultDoc }) {
  const html = useMemo(() => renderMarkdownToHtml(doc.markdown), [doc.markdown])
  return (
    <>
      <div className="result-tab-head">
        <span className="result-tab-source" data-testid="result-doc-source">{doc.file}</span>
      </div>
      {doc.isTruncated && (
        <PanelNote testId="result-truncated-note">
          Showing the first part of this document — it is {formatKilobytes(doc.totalBytes)} in full. Open {doc.file} in the task dir for the rest.
        </PanelNote>
      )}
      <ServerHtml testId="result-doc-body" className="markdown-body" html={html} />
    </>
  )
}

function ResultBody({ slug, meta }: { slug: string; meta: ResultDocMeta | null }) {
  const result = useResultDoc(slug, meta)
  switch (result.status) {
    case 'loading':
      return <PanelNote testId="result-loading">Loading the result…</PanelNote>
    case 'failed':
      // Already logged where the fetch failed.
      return <PanelNote testId="result-failed">Could not load this task&apos;s result document.</PanelNote>
    case 'ready':
      if (result.data === null) return <PanelNote testId="result-missing">This task no longer has a result document.</PanelNote>
      return <ResultDocument doc={result.data} />
  }
}

export function ResultTab({ slug, meta }: { slug: string; meta: ResultDocMeta | null }) {
  return (
    <div className="result-tab" data-testid="result-tab">
      <ResultBody slug={slug} meta={meta} />
    </div>
  )
}
