import { ServerHtml } from '../../components/ServerHtml'
import { useDocsGuide } from '../../data/taskResources'
import type { PostActionOptions } from '../../api/actions'
import { FullPage } from './FullPage'

// The user guide, rendered server-side from docs/user-guide.md and fetched the
// first time this page opens (see useDocsGuide). Until it arrives the body is
// empty; a failed load shows an error instead of a blank page.
export function DocsPage(options: Partial<PostActionOptions> = {}) {
  const guide = useDocsGuide(options)
  return (
    <FullPage pageId="docs-page" title="Docs">
      <ServerHtml testId="docs-body" className="markdown-body" html={guide.status === 'ready' ? (guide.data ?? '') : ''} />
      {guide.status === 'failed' && (
        <div className="docs-error" data-testid="docs-error">Couldn&apos;t load the guide. Try again.</div>
      )}
    </FullPage>
  )
}
