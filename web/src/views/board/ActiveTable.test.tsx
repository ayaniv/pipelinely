import { beforeEach, describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ApprovalPrompt } from '../../../../src/approvalPrompt'
import { ActiveTable, type ActiveTableProps } from './ActiveTable'
import { tableSortStore } from './tableSortStore'
import { makeTask } from './testTask'

const NOW = new Date('2026-09-23T12:00:00Z').getTime()
const baseProps: Omit<ActiveTableProps, 'tasks'> = { now: NOW, isTaskOffFocus: () => false, onToggleOffFocus: vi.fn(), onOpenDetail: vi.fn(), creaturePlacement: 'header' }
const approvalPrompt: ApprovalPrompt = { session: 's', question: 'Proceed?', summary: 'Allow?', fingerprint: 'f', options: [{ number: 1, label: 'Yes' }] }

const needsTasks = (count: number) =>
  Array.from({ length: count }, (_, i) => makeTask({ slug: `n-${String(i).padStart(3, '0')}`, title: `Needs ${String(i).padStart(3, '0')}`, status: 'waiting', attentionStatus: 'needs-you', waitingReason: 'Review. please' }))

beforeEach(() => tableSortStore.reset())

describe('ActiveTable', () => {
  test('renders a row for every one of 200 tasks, so the panel needs no scrolling of its own', () => {
    render(<ActiveTable {...baseProps} tasks={needsTasks(200)} />)
    const table = screen.getByTestId('active-table-needs')
    expect(table).toHaveAttribute('aria-rowcount', '201')
    expect(within(table).getAllByTestId('table-row')).toHaveLength(200)
  })

  test('rows carry consecutive aria-rowindex from 2 and the header is row 1', () => {
    render(<ActiveTable {...baseProps} tasks={needsTasks(20)} />)
    expect(screen.getByTestId('table-header-row')).toHaveAttribute('aria-rowindex', '1')
    const indexes = screen.getAllByTestId('table-row').map((row) => Number(row.getAttribute('aria-rowindex')))
    expect(indexes).toEqual(Array.from({ length: 20 }, (_, i) => i + 2))
  })

  test('only sortable headers carry aria-sort, and a click cycles it', () => {
    render(<ActiveTable {...baseProps} tasks={needsTasks(3)} />)
    expect(screen.getByTestId('table-col-actions')).not.toHaveAttribute('aria-sort')
    const header = screen.getByTestId('table-col-task')
    expect(header).toHaveAttribute('aria-sort', 'none')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'ascending')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'descending')
    fireEvent.click(header)
    expect(header).toHaveAttribute('aria-sort', 'none')
  })

  test('a blocked worker row shows the approval callout and no Next button', () => {
    const blocked = makeTask({ slug: 'blocked', status: 'working', attentionStatus: 'needs-you', waitingReason: '', approvalPrompt })
    render(<ActiveTable {...baseProps} tasks={[blocked]} />)
    const row = screen.getByTestId('table-row')
    expect(within(row).getByTestId('card-approval')).toBeInTheDocument()
    expect(within(row).queryByTestId('row-cta-btn')).not.toBeInTheDocument()
  })

  test('a Working row reads "Agent is running <stage>"', () => {
    render(<ActiveTable {...baseProps} tasks={[makeTask({ slug: 'w', status: 'working', attentionStatus: 'working', stage: 'qa' })]} />)
    expect(screen.getByTestId('table-cell-state')).toHaveAttribute('data-running-stage', 'qa')
    expect(screen.getByTestId('table-cell-state')).toHaveTextContent('Agent is running QA')
  })

  // One case per tone, each against its literal token, so a wrong stage-to-tone mapping fails here.
  test.each([
    ['planning', 'var(--planInk)'],
    ['dev', 'var(--devInk)'],
    ['code-review', 'var(--crInk)'],
    ['qa', 'var(--qaInk)'],
    ['merge', 'var(--mergeInk)'],
  ] as const)("a Needs-you row at %s leads its state in that stage's ink, with the rest separate", (stage, ink) => {
    const task = makeTask({ slug: `ink-${stage}`, status: 'waiting', attentionStatus: 'needs-you', stage, waitingReason: 'Lead sentence here. The detail follows' })
    render(<ActiveTable {...baseProps} tasks={[task]} />)
    expect(screen.getByTestId('table-state-head')).toHaveAttribute('style', expect.stringContaining(`color: ${ink}`))
    expect(screen.getByTestId('table-state-rest')).toHaveTextContent('The detail follows')
  })

  test('a Needs-you row with no summary renders no state head at all', () => {
    render(<ActiveTable {...baseProps} tasks={[makeTask({ slug: 'quiet', status: 'waiting', attentionStatus: 'needs-you', waitingReason: '' })]} />)
    expect(screen.queryByTestId('table-state-head')).not.toBeInTheDocument()
  })

  test('only the first row in sort order is marked first, so only it drops the divider above', () => {
    render(<ActiveTable {...baseProps} tasks={needsTasks(3)} />)
    const rows = screen.getAllByTestId('table-row').sort((a, b) => Number(a.getAttribute('aria-rowindex')) - Number(b.getAttribute('aria-rowindex')))
    expect(rows[0]).toHaveAttribute('data-is-first', 'true')
    expect(rows[1]).not.toHaveAttribute('data-is-first')
    fireEvent.click(screen.getByTestId('table-col-task'))
    fireEvent.click(screen.getByTestId('table-col-task'))
    const resorted = screen.getAllByTestId('table-row').filter((row) => row.hasAttribute('data-is-first'))
    expect(resorted.map((row) => row.getAttribute('data-slug'))).toEqual(['n-002'])
  })

  test('the group heading is the label, count and rule, with no creature art', () => {
    render(<ActiveTable {...baseProps} tasks={needsTasks(1)} />)
    const heading = within(screen.getByTestId('active-group-needs')).getByTestId('active-group-header')
    expect(heading.querySelector('[style*="background-image"]')).toBeNull()
    expect(within(heading).getByTestId('active-group-count')).toHaveTextContent('1')
  })

  test('the Ctx cell has no per-row "ctx" label, since its column header already says Ctx', () => {
    render(<ActiveTable {...baseProps} tasks={[makeTask({ slug: 'c', status: 'waiting', attentionStatus: 'needs-you', contextPct: 40 })]} />)
    const cell = screen.getByTestId('table-cell-ctx')
    expect(within(cell).queryByTestId('card-ctx-label')).not.toBeInTheDocument()
    expect(cell).toHaveTextContent('40%')
  })

  test('clicking a row opens the task, but a click on its own button does not', () => {
    const onOpenDetail = vi.fn()
    render(<ActiveTable {...baseProps} onOpenDetail={onOpenDetail} tasks={needsTasks(1)} />)
    fireEvent.click(screen.getByTestId('card-menu-btn'))
    expect(onOpenDetail).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('table-cell-project'))
    expect(onOpenDetail).toHaveBeenCalledWith('n-000')
  })

  test('each table is named after its group, so a screen reader can tell them apart', () => {
    render(<ActiveTable {...baseProps} tasks={[...needsTasks(1), makeTask({ slug: 'w', status: 'working', attentionStatus: 'working' })]} />)
    expect(screen.getByTestId('active-table-needs')).toHaveAttribute('aria-label', 'Needs you')
    expect(screen.getByTestId('active-table-working')).toHaveAttribute('aria-label', 'Working')
  })

  test('renders the empty state with no tasks', () => {
    render(<ActiveTable {...baseProps} tasks={[]} />)
    expect(screen.queryByTestId('active-tables')).not.toBeInTheDocument()
  })
})
