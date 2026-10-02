import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { makeTask } from '../../testing/makeTask'
import { formatWhen } from '../../format'
import { ParentStepper } from './ParentStepper'

const event = (stage: string, at: string) => ({ stage: stage as never, at, note: null })
const columns = () => screen.getAllByTestId('step-col')

describe('ParentStepper', () => {
  test('is always the three parent stages, with plan-review spelled with a space', () => {
    render(<ParentStepper task={makeTask({ stage: 'dev' })} />)
    expect(columns()).toHaveLength(3)
    expect(columns().map((column) => column.querySelector('.step-name')!.textContent)).toEqual(['planning', 'plan review', 'dev'])
  })

  test('a stage TIMELINE recorded is done, with its formatted time', () => {
    const at = '2026-09-18T14:30:00Z'
    render(<ParentStepper task={makeTask({ stage: 'dev', stageHistory: [event('planning', at)] })} />)
    expect(columns()[0]).toHaveClass('is-done')
    expect(columns()[0].querySelector('.step-when')).toHaveTextContent(formatWhen(at))
  })

  test('the current stage reads "current" when nothing recorded it', () => {
    render(<ParentStepper task={makeTask({ stage: 'plan-review' })} />)
    expect(columns()[1]).toHaveClass('is-at')
    expect(columns()[1].querySelector('.step-when')).toHaveTextContent('current')
  })

  test('the current stage stays "at" even when it has a recorded time', () => {
    render(<ParentStepper task={makeTask({ stage: 'dev', stageHistory: [event('dev', '2026-09-18T14:30:00Z')] })} />)
    expect(columns()[2]).toHaveClass('is-at')
  })

  test('a stage with no record is a dash while the task is live — never inferred done from position', () => {
    render(<ParentStepper task={makeTask({ stage: 'dev' })} />)
    expect(columns()[0]).not.toHaveClass('is-done')
    expect(columns()[0].querySelector('.step-when')).toHaveTextContent('—')
  })

  test('on a finished task an unreached stage is "not recorded", not skipped', () => {
    render(<ParentStepper task={makeTask({ status: 'done', stage: null })} />)
    expect(columns()[0]).toHaveClass('is-unrecorded')
    expect(columns()[0].querySelector('.step-when')).toHaveTextContent('not recorded')
  })

  test('the newest entry for a repeated stage wins', () => {
    const older = '2026-09-18T10:00:00Z'
    const newer = '2026-09-19T11:00:00Z'
    render(<ParentStepper task={makeTask({ stage: 'dev', stageHistory: [event('plan-review', older), event('plan-review', newer)] })} />)
    expect(columns()[1].querySelector('.step-when')).toHaveTextContent(formatWhen(newer))
  })
})
