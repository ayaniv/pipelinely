import { useState } from 'react'
import { postHelpFeedback, type PostActionOptions } from '../../api/actions'
import { useActionFlash } from '../../components/useActionFlash'
import { FullPage } from './FullPage'

// Stages, never sends: the developer still has to press Return in the
// orchestrator's own session, and the description below is the only place
// that says so.
export function HelpPage({ fetchImpl = fetch, log = console.error }: Partial<PostActionOptions> = {}) {
  const [message, setMessage] = useState('')
  const { flash, showOutcome, isPending, run } = useActionFlash()

  // Send is enabled only for a message the server would actually accept, so
  // the disabled state and the route's own 400 agree on what "empty" means.
  const trimmedMessage = message.trim()
  const canSend = trimmedMessage !== ''

  const handleSend = () => run(async () => {
    const result = await postHelpFeedback(trimmedMessage, { fetchImpl, log })
    showOutcome(result)
    if (result.ok) setMessage('')
  })

  return (
    <FullPage pageId="help-page" title="Help">
      <div className="help-feedback-panel" data-testid="help-feedback-panel">
        <span className="page-row-label" data-testid="help-feedback-label">File a public GitHub issue</span>
        <div className="help-feedback-composer">
          <textarea
            id="help-feedback-input"
            data-testid="help-feedback-input"
            className="help-feedback-input"
            aria-label="Feedback message"
            rows={3}
            placeholder="What's working, what isn't…"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <button
            type="button"
            className={`btn ${flash.className}`.trim()}
            id="help-feedback-send"
            data-testid="help-feedback-send"
            disabled={!canSend || isPending}
            onClick={handleSend}
          >
            {flash.label ?? 'Stage /pipelinely-feedback'}
          </button>
        </div>
        <span className="page-row-desc" data-testid="help-feedback-disclosure">Stages /pipelinely-feedback into the orchestrator's session, unsent — press Return there. It files a public GitHub issue on the Pipelinely repo, using your own gh login, visible to everyone; the skill shows you the exact text first and posts only after you confirm. Nothing is sent to a Pipelinely server. Line breaks are collapsed to a single space.</span>
      </div>
      <div className="page-row-desc help-support-row">
        Need help another way? <a href="mailto:ayaniv@gmail.com?subject=pipelinely" id="help-support-link" data-testid="help-support-link">Contact support</a>
      </div>
    </FullPage>
  )
}
