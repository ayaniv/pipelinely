import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { Task } from '../../../../../src/types'
import { FindingsChecklist, PlannedQaList, PlannedQaRows, QaCaseList, QaFailuresChecklist, TriageContainer } from './Checklists'

type Finding = Task['findings'][number]
type QaFailure = Task['qaFailures'][number]

const finding = (overrides: Partial<Finding> = {}): Finding => ({ severity: 'must', category: 'correctness', description: 'Off by one', location: 'a.ts:1', selected: false, ...overrides })
const failure = (overrides: Partial<QaFailure> = {}): QaFailure => ({ label: 'Case 1', description: 'CTA text is wrong', location: 'e2e/x.spec.ts:10', selected: false, ...overrides })

describe('FindingsChecklist', () => {
  test('read-only: one row per finding with its severity, category, description and location — and no checkbox or count', () => {
    render(<FindingsChecklist findings={[finding(), finding({ severity: 'should', description: 'Rename' })]} />)

    const rows = screen.getAllByTestId('finding-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveClass('read-only')
    expect(within(rows[0]).getByTestId('finding-severity')).toHaveClass('pill', 'pill-must')
    expect(within(rows[1]).getByTestId('finding-severity')).toHaveClass('pill-should')
    expect(screen.queryByTestId('triage-checkbox')).toBeNull()
    expect(screen.queryByTestId('checklist-selected-count')).toBeNull()
  })

  test('the header names the source and pluralises the count', () => {
    const { rerender } = render(<FindingsChecklist findings={[finding()]} />)
    expect(screen.getByTestId('checklist-source')).toHaveTextContent('from task-pr-review.md · 1 finding')
    rerender(<FindingsChecklist findings={[finding(), finding()]} />)
    expect(screen.getByTestId('checklist-source')).toHaveTextContent('from task-pr-review.md · 2 findings')
  })

  test('interactive: a checkbox per row, checked as selected, with a selected-of-total count', () => {
    render(<FindingsChecklist findings={[finding(), finding()]} selected={[true, false]} onToggle={vi.fn()} />)

    const boxes = screen.getAllByTestId('triage-checkbox')
    expect(boxes[0]).toBeChecked()
    expect(boxes[1]).not.toBeChecked()
    expect(boxes[1]).toHaveAttribute('aria-label', 'Select finding 2')
    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('1')
    expect(screen.getByTestId('checklist-selected-summary')).toHaveTextContent('1 of 2 selected')
  })

  test('toggling a checkbox reports its row index', () => {
    const onToggle = vi.fn()
    render(<FindingsChecklist findings={[finding(), finding()]} selected={[false, false]} onToggle={onToggle} />)

    fireEvent.click(screen.getAllByTestId('triage-checkbox')[1])

    expect(onToggle).toHaveBeenCalledWith(1)
  })

  test('finding text is rendered as text, never as markup', () => {
    render(<FindingsChecklist findings={[finding({ description: '<img src=x onerror=alert(1)>' })]} />)
    expect(screen.getByTestId('finding-row').querySelector('img')).toBeNull()
    expect(screen.getByTestId('finding-description')).toHaveTextContent('<img src=x onerror=alert(1)>')
  })
})

describe('QaFailuresChecklist', () => {
  test('is a no-severity checklist headed by its source and failing-case count, with one checkbox per failure', () => {
    render(<QaFailuresChecklist failures={[failure(), failure({ label: 'Case 2' })]} selected={[true, true]} onToggle={vi.fn()} />)

    expect(screen.getByTestId('checklist-source')).toHaveTextContent('from QA_REPORT.md · 2 failing cases')
    const boxes = screen.getAllByTestId('triage-checkbox')
    expect(boxes).toHaveLength(2)
    expect(boxes[0]).toHaveAttribute('aria-label', 'Select failing case 1')
    expect(screen.getAllByTestId('finding-row')[0]).toHaveClass('no-severity')
    expect(screen.getByTestId('checklist-selected-count')).toHaveTextContent('2')
  })

  test('singular header for one failure', () => {
    render(<QaFailuresChecklist failures={[failure()]} selected={[false]} onToggle={vi.fn()} />)
    expect(screen.getByTestId('checklist-source')).toHaveTextContent('from QA_REPORT.md · 1 failing case')
  })
})

describe('TriageContainer', () => {
  test('carries the endpoint and the owning slug, so the checklist is identifiable', () => {
    render(<TriageContainer slug="child-m1" endpoint="qa-triage"><span /></TriageContainer>)
    const container = screen.getByTestId('triage-checklist')
    expect(container).toHaveClass('detail-row-checklist')
    expect(container).toHaveAttribute('data-endpoint', 'qa-triage')
    expect(container).toHaveAttribute('data-slug', 'child-m1')
  })
})

describe('QaCaseList', () => {
  const cases = [
    { label: 'Case 1', description: 'passes', location: 'a', passed: true },
    { label: 'Case 2', description: 'fails', location: 'b', passed: false },
  ]

  test('lists every case with its pass/fail mark', () => {
    render(<QaCaseList cases={cases} />)

    const rows = screen.getAllByTestId('qa-case-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('data-passed', 'true')
    expect(rows[1]).toHaveAttribute('data-passed', 'false')
    expect(screen.getByTestId('qa-case-list')).toBeInTheDocument()
  })

  test('the header says how many passed of how many', () => {
    render(<QaCaseList cases={cases} />)
    expect(screen.getByTestId('checklist-source')).toHaveTextContent('from QA_REPORT.md · 2 cases')
    expect(screen.getByTestId('qa-case-summary')).toHaveTextContent('1 of 2 passed')
  })
})

describe('PlannedQaList / PlannedQaRows', () => {
  test('marks the list as planned from the spec file and not yet run', () => {
    render(<PlannedQaList specFile="e2e/foo.spec.ts" titles={['does a thing', 'does another']} />)

    expect(screen.getByTestId('checklist-source')).toHaveTextContent('planned, from e2e/foo.spec.ts · not yet run')
    expect(screen.getByTestId('planned-qa-case-list')).toBeInTheDocument()
    expect(screen.getAllByTestId('planned-qa-case-row')).toHaveLength(2)
  })

  test('rows alone (the plan overview reuses them) render one dot-marked row per title', () => {
    render(<PlannedQaRows titles={['one']} />)
    const row = screen.getByTestId('planned-qa-case-row')
    expect(row).toHaveTextContent('one')
    expect(row.querySelector('.qa-case-icon.planned')).not.toBeNull()
  })
})
