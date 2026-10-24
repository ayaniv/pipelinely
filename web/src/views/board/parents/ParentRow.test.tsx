import { readFileSync } from 'fs'
import path from 'path'
import { afterEach, beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { MilestoneStatus, Task } from '../../../../../src/types'
import { clientState } from '../../../data/clientState'
import { READ_ONLY_INSTANCE_TITLE } from '../../../components/readOnly'
import { makeTask } from '../testTask'
import { ParentRow, type ParentRowProps } from './ParentRow'

function milestone(id: string, wave: number, state: MilestoneStatus['state'], name = `${id} name`): MilestoneStatus {
  return { id, name, needs: [], estimate: null, specFile: null, wave, task: null, state }
}

const ROSIE = { name: 'Rosie', color: '#a8d8c9', shape: '61% 68% 37% 59% / 63% 38% 50% 54%' }

const PLAN_REVIEWED = [{ stage: 'plan-review' as const, at: '2026-01-01T00:00:00Z', note: '' }]

function parent(milestones: MilestoneStatus[], overrides: Partial<Task> = {}): Task {
  return makeTask({ slug: 'billing', title: 'Workspace billing', repo: 'acme-web', creature: ROSIE, milestones, stageHistory: PLAN_REVIEWED, ...overrides })
}

const RUNNABLE = parent([milestone('M1', 1, 'done'), milestone('M2', 2, 'queued'), milestone('M3', 2, 'queued')])
const LOCKED = parent([milestone('M1', 1, 'dispatched'), milestone('M2', 1, 'done'), milestone('M4', 1, 'dispatched'), milestone('M5', 2, 'queued')])

let onToggle: Mock<ParentRowProps['onToggle']>
let onRunWave: Mock<ParentRowProps['onRunWave']>
let onOpenPlan: Mock<ParentRowProps['onOpenPlan']>

beforeEach(() => {
  onToggle = vi.fn<ParentRowProps['onToggle']>()
  onRunWave = vi.fn<ParentRowProps['onRunWave']>()
  onOpenPlan = vi.fn<ParentRowProps['onOpenPlan']>()
})

afterEach(() => clientState.setWaveRunning('billing', 2, false))

function renderRow(task: Task, overrides: Partial<ParentRowProps> = {}) {
  return render(<ParentRow task={task} isOpen={false} onToggle={onToggle} onRunWave={onRunWave} onOpenPlan={onOpenPlan} creaturePlacement="header" isCanonical {...overrides} />)
}

describe('ParentRow collapsed', () => {
  test('shows the title, the project, the progress and no expanded body', () => {
    renderRow(RUNNABLE)
    expect(screen.getByTestId('parent-title')).toHaveTextContent('Workspace billing')
    expect(screen.getByTestId('parent-project')).toHaveTextContent('acme-web')
    expect(screen.getByTestId('parent-progress')).toHaveTextContent('1 / 3 done')
    expect(screen.queryByTestId('parent-expanded')).not.toBeInTheDocument()
    expect(screen.getByTestId('parent-chevron')).toHaveAttribute('aria-expanded', 'false')
  })

  test('draws one icon per milestone, in wave groups, each titled "M1 · name · state"', () => {
    renderRow(RUNNABLE)
    const groups = screen.getAllByTestId('parent-icon-wave')
    expect(groups.map((g) => within(g).getAllByTestId('milestone-icon').length)).toEqual([1, 2])
    expect(within(groups[0]).getByTestId('milestone-icon').querySelector('title')).toHaveTextContent('M1 · M1 name · done')
    expect(within(groups[1]).getAllByTestId('milestone-icon').map((i) => i.dataset.state)).toEqual(['idle', 'idle'])
  })

  test('the three states render as done / working / idle icons', () => {
    renderRow(LOCKED)
    const states = screen.getAllByTestId('milestone-icon').map((icon) => icon.dataset.state)
    expect(states).toEqual(['working', 'done', 'working', 'idle'])
  })

  test('draws the creature as a bare 22x20 blob with two eyes and no visor, as the v4 design does', () => {
    renderRow(RUNNABLE)
    const creature = screen.getByTestId('creature')
    expect(creature.style.width).toBe('22px')
    expect(creature.style.height).toBe('20px')
    expect(within(creature).getAllByTestId('creature-eye')).toHaveLength(2)
    expect(within(creature).queryByTestId('creature-visor')).not.toBeInTheDocument()
  })

  test('each wave group is titled with its wave', () => {
    renderRow(RUNNABLE)
    expect(screen.getAllByTestId('parent-icon-wave').map((group) => group.getAttribute('title'))).toEqual(['Wave 1', 'Wave 2'])
  })

  test('a parent without a creature still renders its row', () => {
    renderRow(parent([milestone('M1', 1, 'queued')], { creature: null }))
    expect(screen.queryByTestId('creature')).not.toBeInTheDocument()
    expect(screen.getByTestId('parent-title')).toBeInTheDocument()
  })

  test('hides the creature when the Settings placement is off', () => {
    renderRow(RUNNABLE, { creaturePlacement: 'off' })
    expect(screen.queryByTestId('creature')).not.toBeInTheDocument()
  })

  test('the chevron rotates only when open', () => {
    const { rerender } = renderRow(RUNNABLE)
    expect(screen.getByTestId('parent-chevron')).not.toHaveClass('is-open')
    rerender(<ParentRow task={RUNNABLE} isOpen onToggle={onToggle} onRunWave={onRunWave} onOpenPlan={onOpenPlan} creaturePlacement="header" isCanonical />)
    expect(screen.getByTestId('parent-chevron')).toHaveClass('is-open')
  })
})

describe('ParentRow Run wave failure paths', () => {
  const runButton = () => screen.getByTestId('parent-wave-btn')

  test('off the canonical instance Run wave is disabled with the read-only title, so a refused dispatch is never silent', () => {
    renderRow(RUNNABLE, { isCanonical: false })
    expect(runButton()).toBeDisabled()
    expect(runButton()).toHaveAttribute('title', READ_ONLY_INSTANCE_TITLE)
    fireEvent.click(runButton())
    expect(onRunWave).not.toHaveBeenCalled()
  })

  test('before plan review no milestone is eligible, so Run wave is disabled and says why', () => {
    renderRow(parent(RUNNABLE.milestones ?? [], { stageHistory: [] }))
    expect(runButton()).toBeDisabled()
    expect(runButton()).toHaveAttribute('title', 'The plan has not been reviewed yet')
  })

  test('a wave whose milestones all wait on an unmerged need is disabled even though its icons are all idle', () => {
    const blocked = parent([{ ...milestone('M1', 1, 'done'), id: 'M1' }, { ...milestone('M2', 2, 'queued'), needs: ['M9'] }])
    renderRow(blocked)
    expect(runButton()).toBeDisabled()
  })

  test('while the wave is being staged it is disabled with the staging title', () => {
    clientState.setWaveRunning('billing', 2, true)
    renderRow(RUNNABLE)
    expect(runButton()).toBeDisabled()
    expect(runButton()).toHaveAttribute('title', 'Staging wave 2…')
  })
})

describe('ParentRow toggling', () => {
  test('a click on the row toggles it with the parent slug', () => {
    renderRow(RUNNABLE)
    fireEvent.click(screen.getByTestId('parent-row-head'))
    expect(onToggle).toHaveBeenCalledWith('billing')
  })

  test('the chevron is the keyboard control: a labelled button whose click toggles the row once', () => {
    renderRow(RUNNABLE)
    const chevron = screen.getByTestId('parent-chevron')
    expect(chevron.tagName).toBe('BUTTON')
    expect(chevron).toHaveAttribute('aria-label', 'Expand Workspace billing')
    fireEvent.click(chevron)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  test('an open row labels its chevron Collapse', () => {
    renderRow(RUNNABLE, { isOpen: true })
    expect(screen.getByTestId('parent-chevron')).toHaveAttribute('aria-label', 'Collapse Workspace billing')
  })
})

describe('ParentRow wave button', () => {
  test('runnable: a dark "Run wave N" button that calls onRunWave(task, N) and never toggles the row', () => {
    renderRow(RUNNABLE)
    const button = screen.getByTestId('parent-wave-btn')
    expect(button).toHaveAttribute('data-kind', 'run')
    expect(button).toHaveTextContent('Run wave 2')
    expect(button).toBeEnabled()
    fireEvent.click(button)
    expect(onRunWave).toHaveBeenCalledWith(RUNNABLE, 2)
    expect(onToggle).not.toHaveBeenCalled()
  })

  test('locked: a disabled "Wave N" button with the waiting tooltip, whose click never toggles the row', () => {
    renderRow(LOCKED)
    const button = screen.getByTestId('parent-wave-btn')
    expect(button).toHaveAttribute('data-kind', 'locked')
    expect(button).toHaveTextContent('Wave 2')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', 'Waiting on wave 1 · M1 working, M4 working')
    fireEvent.click(button)
    fireEvent.click(screen.getByTestId('parent-wave-btn-slot'))
    expect(onRunWave).not.toHaveBeenCalled()
    expect(onToggle).not.toHaveBeenCalled()
  })

  test('no idle wave left: no button at all', () => {
    renderRow(parent([milestone('M1', 1, 'dispatched'), milestone('M2', 2, 'dispatched')]))
    expect(screen.queryByTestId('parent-wave-btn')).not.toBeInTheDocument()
  })

  test('a wave already being staged disables its Run button', () => {
    clientState.setWaveRunning('billing', 2, true)
    renderRow(RUNNABLE)
    expect(screen.getByTestId('parent-wave-btn')).toBeDisabled()
    fireEvent.click(screen.getByTestId('parent-wave-btn'))
    expect(onRunWave).not.toHaveBeenCalled()
  })
})

describe('ParentRow expanded', () => {
  test('lists one column per wave with a WAVE N eyebrow and one line per milestone', () => {
    renderRow(LOCKED, { isOpen: true })
    const columns = screen.getAllByTestId('parent-wave-col')
    expect(columns.map((c) => within(c).getByTestId('parent-wave-eyebrow').textContent)).toEqual(['WAVE 1', 'WAVE 2'])
    const lines = within(columns[0]).getAllByTestId('parent-milestone-line')
    expect(lines.map((l) => within(l).getByTestId('parent-milestone-id').textContent)).toEqual(['M1', 'M2', 'M4'])
    expect(within(lines[0]).getByTestId('parent-milestone-title')).toHaveTextContent('M1 name')
    expect(within(lines[0]).getByTestId('milestone-icon')).toHaveAttribute('data-state', 'working')
    expect(screen.getByTestId('parent-chevron')).toHaveAttribute('aria-expanded', 'true')
  })

  test('an idle milestone line is marked idle so its title can be dimmed', () => {
    renderRow(LOCKED, { isOpen: true })
    const lines = screen.getAllByTestId('parent-milestone-line')
    expect(lines.map((l) => l.dataset.state)).toEqual(['working', 'done', 'working', 'idle'])
  })

  test('"Open milestone plan →" links to the parent pipeline page at the Dev stage and opens it in place on a plain click', () => {
    renderRow(RUNNABLE, { isOpen: true })
    const link = screen.getByTestId('parent-open-plan')
    expect(link).toHaveAttribute('href', '/task/billing?stage=dev')
    fireEvent.click(link)
    expect(onOpenPlan).toHaveBeenCalledWith('billing', { stage: 'dev' })
    expect(onToggle).not.toHaveBeenCalled()
  })

  test('clicking inside the expanded body does not collapse the row', () => {
    renderRow(RUNNABLE, { isOpen: true })
    fireEvent.click(screen.getAllByTestId('parent-wave-col')[0])
    expect(onToggle).not.toHaveBeenCalled()
  })
})

describe('the parent row styles', () => {
  const css = readFileSync(path.join(process.cwd(), 'web/src/styles/app.css'), 'utf-8')
  const ruleFor = (selector: string) => css.match(new RegExp(`\\n\\s*${selector.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? ''

  test('the row grid is auto | minmax(0,1fr) | auto | auto | auto', () => {
    expect(ruleFor('.parent-row-head').replace(/\s+/g, '')).toContain('grid-template-columns:auto minmax(0,1fr) auto auto auto'.replace(/\s+/g, ''))
  })

  test('the title keeps its width and the project shrinks first', () => {
    const shrinkOf = (selector: string) => Number(ruleFor(selector).match(/flex-shrink:\s*(\d+)/)?.[1])
    expect(shrinkOf('.parent-project')).toBeGreaterThan(shrinkOf('.parent-title'))
  })

  test('hover lifts the row to surface2', () => {
    expect(ruleFor('.parent-row-head:hover')).toMatch(/background:\s*var\(--surface2\)/)
  })

  // min(100%, 220px) is the v4 HTML's own guard: one column never overflows a row narrower than 220px.
  test('expanded wave columns are auto-fill, minmax(min(100%, 220px), 1fr)', () => {
    expect(ruleFor('.parent-expanded')).toMatch(/repeat\(auto-fill,\s*minmax\(min\(100%,\s*220px\),\s*1fr\)\)/)
  })

  test('the plan link spans the whole wave grid, under the columns', () => {
    renderRow(RUNNABLE, { isOpen: true })
    expect(screen.getByTestId('parent-open-plan').parentElement).toBe(screen.getByTestId('parent-expanded'))
    expect(ruleFor('.parent-open-plan')).toMatch(/grid-column:\s*1\s*\/\s*-1/)
  })
})
