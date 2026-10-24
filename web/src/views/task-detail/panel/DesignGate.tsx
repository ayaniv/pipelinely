import './DesignGate.css'
import { useState } from 'react'
import type { Task } from '../../../../../src/types'
import { postDesignApproval, type PostActionOptions } from '../../../api/actions'
import { useActionFlash } from '../../../components/useActionFlash'
import { designQaImageFiles, designQaImageUrl, isReportMissingImages, unservableImageCells } from '../../../designQaReport'
import { PanelBody, PanelFooter, PanelNote } from './PanelLayout'

// The two pieces of the designer's gate: what design QA found (its report and
// screenshots) and the decision buttons.

// A screenshot the route could not serve (listed in the report but not on
// disk) says so in place of a broken-image icon.
function DesignQaImage({ slug, file }: { slug: string; file: string }) {
  const [hasFailed, setHasFailed] = useState(false)
  if (hasFailed) return <PanelNote testId="design-qa-image-failed">Screenshot not found: {file}</PanelNote>
  return <img className="design-gate-image" data-testid="design-qa-image" src={designQaImageUrl(slug, file)} alt={file} onError={() => setHasFailed(true)} />
}

export function DesignQaReport({ task }: { task: Pick<Task, 'slug' | 'designQaReport'> }) {
  if (!task.designQaReport) return <PanelNote testId="design-qa-no-report">No design QA report yet — design QA has not run.</PanelNote>

  return (
    <div className="design-gate-report">
      <pre className="design-gate-text" data-testid="design-qa-report">{task.designQaReport}</pre>
      {isReportMissingImages(task.designQaReport) && (
        <PanelNote testId="design-qa-images-missing">No screenshots found in this report — expected cells like design-qa/primary-light.png.</PanelNote>
      )}
      {unservableImageCells(task.designQaReport).length > 0 && (
        <PanelNote testId="design-qa-images-unservable">Not shown (expected design-qa/&lt;file&gt;.png with no spaces): {unservableImageCells(task.designQaReport).join(', ')}</PanelNote>
      )}
      <div className="design-gate-images">
        {designQaImageFiles(task.designQaReport).map((file) => <DesignQaImage key={file} slug={task.slug} file={file} />)}
      </div>
    </div>
  )
}

const NOT_AT_GATE_TITLE = 'Not ready yet — appears once design QA hands off to the designer.'

export interface DesignApprovalGateProps extends Partial<PostActionOptions> {
  task: Pick<Task, 'slug' | 'designQaReport'>
  isLive: boolean
}

// The gate's body and footer. Approve is one click; Request changes needs
// notes, since they are what pipelinely-design-fixes works from. Both stay
// disabled (saying why) unless the task is genuinely waiting at the gate, so
// neither looks live and does nothing.
export function DesignApprovalGate({ task, isLive, fetchImpl = fetch, log = console.error }: DesignApprovalGateProps) {
  const [notes, setNotes] = useState('')
  const approve = useActionFlash()
  const requestChanges = useActionFlash()
  const hasNotes = notes.trim() !== ''
  const disabledTitle = isLive ? undefined : NOT_AT_GATE_TITLE

  const handleApprove = () => approve.run(async () => {
    approve.showOutcome(await postDesignApproval(task.slug, { decision: 'approve' }, { fetchImpl, log }))
  })
  const handleRequestChanges = () => requestChanges.run(async () => {
    const outcome = await postDesignApproval(task.slug, { decision: 'request-changes', notes }, { fetchImpl, log })
    requestChanges.showOutcome(outcome)
    if (outcome.ok) setNotes('')
  })

  return (
    <>
      <PanelBody>
        <DesignQaReport task={task} />
        <textarea
          className="design-gate-notes"
          data-testid="design-changes-notes"
          placeholder="What should change? Required to request changes."
          value={notes}
          disabled={!isLive}
          onChange={(event) => setNotes(event.target.value)}
        />
      </PanelBody>
      <PanelFooter
        primary={(
          <button type="button" className={`btn ${approve.flash.className}`.trim()} data-testid="design-approve-btn" disabled={!isLive || approve.isPending} title={disabledTitle} onClick={handleApprove}>
            {approve.flash.label ?? 'Approve design'}
          </button>
        )}
        secondaries={(
          <button type="button" className={`btn ${requestChanges.flash.className}`.trim()} data-testid="design-request-changes-btn" disabled={!isLive || !hasNotes || requestChanges.isPending} title={disabledTitle} onClick={handleRequestChanges}>
            {requestChanges.flash.label ?? 'Request changes'}
          </button>
        )}
      />
    </>
  )
}
