import type { ReactNode } from 'react'
import type { QaCase, Task } from '../../../../../src/types'
import type { TriageEndpoint } from '../../../api/actions'

// The findings / QA-failure / QA-case lists a stage panel body is built from,
// All text goes through React, so a finding's own text can never be read as
// markup.

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`

interface ChecklistHeaderProps {
  source: string
  selectedCount?: number
  total: number
}

function ChecklistHeader({ source, selectedCount, total }: ChecklistHeaderProps) {
  return (
    <div className="detail-row-checklist-header">
      <span className="sess-note" data-testid="checklist-source">{source}</span>
      {selectedCount !== undefined && (
        <span className="findings-count" data-testid="checklist-selected-summary">
          <span className="checklist-selected-count" data-testid="checklist-selected-count">{selectedCount}</span> of {total} selected
        </span>
      )}
    </div>
  )
}

interface TriageCheckboxProps {
  index: number
  isSelected: boolean
  ariaLabel: string
  onToggle: (index: number) => void
}

function TriageCheckbox({ index, isSelected, ariaLabel, onToggle }: TriageCheckboxProps) {
  return <input type="checkbox" data-testid="triage-checkbox" checked={isSelected} aria-label={ariaLabel} onChange={() => onToggle(index)} />
}

const countSelected = (selected: boolean[]) => selected.filter(Boolean).length

export interface FindingsChecklistProps {
  findings: Task['findings']
  // Present together: the interactive triage checklist. Absent: the CR tab's
  // read-only recap of a completed review.
  selected?: boolean[]
  onToggle?: (index: number) => void
}

export function FindingsChecklist({ findings, selected, onToggle }: FindingsChecklistProps) {
  const isInteractive = !!selected && !!onToggle

  return (
    <>
      <ChecklistHeader
        source={`from task-pr-review.md · ${plural(findings.length, 'finding')}`}
        selectedCount={isInteractive ? countSelected(selected) : undefined}
        total={findings.length}
      />
      <div className="finding-list">
        {findings.map((finding, i) => (
          <div key={i} className={`finding-row${isInteractive ? '' : ' read-only'}`} data-testid="finding-row">
            {isInteractive && <TriageCheckbox index={i} isSelected={selected[i]} ariaLabel={`Select finding ${i + 1}`} onToggle={onToggle} />}
            <span className={`pill pill-${finding.severity}`} data-testid="finding-severity">{finding.severity}</span>
            <div className="finding-body">
              <span className="finding-category">{finding.category}</span>
              <span className="finding-description" data-testid="finding-description">{finding.description}</span>
            </div>
            <span className="finding-location">{finding.location}</span>
          </div>
        ))}
      </div>
    </>
  )
}

export interface QaFailuresChecklistProps {
  failures: Task['qaFailures']
  selected: boolean[]
  onToggle: (index: number) => void
}

// No severity pill — a QA case either failed or it didn't.
export function QaFailuresChecklist({ failures, selected, onToggle }: QaFailuresChecklistProps) {
  return (
    <>
      <ChecklistHeader source={`from QA_REPORT.md · ${plural(failures.length, 'failing case')}`} selectedCount={countSelected(selected)} total={failures.length} />
      <div className="finding-list">
        {failures.map((failure, i) => (
          <div key={i} className="finding-row no-severity" data-testid="finding-row">
            <TriageCheckbox index={i} isSelected={selected[i]} ariaLabel={`Select failing case ${i + 1}`} onToggle={onToggle} />
            <div className="finding-body">
              <span className="finding-category">{failure.label}</span>
              <span className="finding-description">{failure.description}</span>
            </div>
            <span className="finding-location">{failure.location}</span>
          </div>
        ))}
      </div>
    </>
  )
}

export interface TriageContainerProps {
  // The slug that owns this checklist — a milestone child's, not the open
  // task's, when inside a parent's drill-down.
  slug: string
  endpoint: TriageEndpoint
  children: ReactNode
}

export function TriageContainer({ slug, endpoint, children }: TriageContainerProps) {
  return <div className="detail-row-checklist" data-testid="triage-checklist" data-endpoint={endpoint} data-slug={slug}>{children}</div>
}

// Every case QA ran, pass and fail — read-only; the qa-fixes tab is where a
// failing case actually gets acted on.
export function QaCaseList({ cases }: { cases: QaCase[] }) {
  const passed = cases.filter((c) => c.passed).length
  return (
    <>
      <div className="detail-row-checklist-header">
        <span className="sess-note" data-testid="checklist-source">from QA_REPORT.md · {plural(cases.length, 'case')}</span>
        <span className="findings-count" data-testid="qa-case-summary">{passed} of {cases.length} passed</span>
      </div>
      <div className="finding-list" data-testid="qa-case-list">
        {cases.map((qaCase, i) => (
          <div key={i} className="finding-row no-severity qa-case-row" data-testid="qa-case-row" data-passed={String(qaCase.passed)}>
            <span className="qa-case-icon" aria-hidden="true">{qaCase.passed ? '✓' : '✗'}</span>
            <div className="finding-body">
              <span className="finding-category">{qaCase.label}</span>
              <span className="finding-description">{qaCase.description}</span>
            </div>
            <span className="finding-location">{qaCase.location}</span>
          </div>
        ))}
      </div>
    </>
  )
}

// A dot instead of a check/cross, so a case that has not run can never read
// as a real result. Shared by the QA tab's own preview and the Plan tab's
// derived test list — both show live-parsed test() titles.
export function PlannedQaRows({ titles }: { titles: string[] }) {
  return (
    <>
      {titles.map((title, i) => (
        <div key={i} className="finding-row planned-qa-row" data-testid="planned-qa-case-row">
          <span className="qa-case-icon planned" aria-hidden="true">•</span>
          <span className="finding-description">{title}</span>
        </div>
      ))}
    </>
  )
}

export function PlannedQaList({ specFile, titles }: { specFile: string; titles: string[] }) {
  return (
    <>
      <div className="detail-row-checklist-header">
        <span className="sess-note" data-testid="checklist-source">planned, from {specFile} · not yet run</span>
      </div>
      <div className="finding-list" data-testid="planned-qa-case-list">
        <PlannedQaRows titles={titles} />
      </div>
    </>
  )
}
