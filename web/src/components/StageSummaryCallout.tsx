import type { ReactElement } from 'react'
import { STAGE_TONE_VARS, type StageSummary, type StageTone, type SummaryIcon } from '../stageView'
import { SummaryCheckIcon, SummaryCommentIcon, SummaryDotIcon } from './icons'

// The card's (and the inner view's) summary callout: a stage-soft box whose
// first sentence is bold in the stage ink and the rest in text2. The container
// testid is a prop so each surface keeps its own hook; the head and rest parts
// are the same element on every surface, so they keep one shared id.

const ICON_BY_KIND: Record<SummaryIcon, () => ReactElement> = {
  check: SummaryCheckIcon,
  comment: SummaryCommentIcon,
  dot: SummaryDotIcon,
}

export interface StageSummaryCalloutProps {
  summary: StageSummary
  tone: StageTone
  icon: SummaryIcon
  testId?: string
}

export function StageSummaryCallout({ summary, tone, icon, testId = 'card-summary' }: StageSummaryCalloutProps) {
  const vars = STAGE_TONE_VARS[tone]
  const Icon = ICON_BY_KIND[icon]
  return (
    <div className="stage-summary" data-testid={testId} data-icon={icon} style={{ background: vars.soft }}>
      <span className="stage-summary-icon" style={{ color: vars.ink }}><Icon /></span>
      <div className="stage-summary-text">
        <div className="stage-summary-head" data-testid="card-summary-head" style={{ color: vars.ink }}>{summary.head}</div>
        {summary.rest && <div className="stage-summary-rest" data-testid="card-summary-rest">{summary.rest}</div>}
      </div>
    </div>
  )
}
