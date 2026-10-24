import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { OpenTask } from '../../shell/appNavigation'
import { PlannedParentRow } from './PlannedParentRow'
import { makeTask } from './testTask'

const QUEUED_MILESTONE = { id: 'M0', name: 'Foundation', needs: [], estimate: null, specFile: null, wave: 1, task: null, state: 'queued' as const }
const PARENT = makeTask({ slug: 'billing', title: 'Workspace billing', repo: 'acme-web', milestones: [QUEUED_MILESTONE, { ...QUEUED_MILESTONE, id: 'M1' }] })

let onOpenPlan: Mock<OpenTask>

beforeEach(() => {
  onOpenPlan = vi.fn<OpenTask>()
})

describe('PlannedParentRow', () => {
  test('shows the project, the title and that its first wave has not started', () => {
    render(<ul><PlannedParentRow task={PARENT} onOpenPlan={onOpenPlan} /></ul>)
    expect(screen.getByTestId('backlog-planned-parent-project')).toHaveTextContent('acme-web')
    expect(screen.getByTestId('backlog-planned-parent-title')).toHaveTextContent('Workspace billing')
    expect(screen.getByTestId('backlog-planned-parent-context')).toHaveTextContent('2 milestones')
  })

  test('has no project chip for a task without a repo', () => {
    render(<ul><PlannedParentRow task={{ ...PARENT, repo: '' }} onOpenPlan={onOpenPlan} /></ul>)
    expect(screen.queryByTestId('backlog-planned-parent-project')).not.toBeInTheDocument()
  })

  test('a plain click on "Open plan" opens the Dev stage of the parent', () => {
    render(<ul><PlannedParentRow task={PARENT} onOpenPlan={onOpenPlan} /></ul>)
    const link = screen.getByTestId('backlog-planned-parent-open')
    expect(link).toHaveAttribute('href', '/task/billing?stage=dev')
    fireEvent.click(link)
    expect(onOpenPlan).toHaveBeenCalledWith('billing', { stage: 'dev' })
  })

  test('a modified click is left to the browser, so "open in new tab" works', () => {
    render(<ul><PlannedParentRow task={PARENT} onOpenPlan={onOpenPlan} /></ul>)
    fireEvent.click(screen.getByTestId('backlog-planned-parent-open'), { metaKey: true })
    expect(onOpenPlan).not.toHaveBeenCalled()
  })
})
