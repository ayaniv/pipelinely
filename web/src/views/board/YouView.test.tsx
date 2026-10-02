import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { DoneDateGroup } from '../../../../src/types'
import { YouView } from './YouView'
import { makeTask } from './testTask'

const now = new Date(2026, 8, 24)

const groupWithSessions = (startedAts: string[]): DoneDateGroup[] => [
  { dateKey: '2026-09-10', label: 'x', tasks: [makeTask({ sessions: startedAts.map((startedAt) => ({ startedAt })) as never })] },
]

describe('YouView', () => {
  test('always draws the full 53-week grid, even with no history', () => {
    render(<YouView doneGroups={[]} now={now} />)

    expect(screen.getAllByTestId('density-cell')).toHaveLength(53 * 7)
    expect(screen.getByTestId('density-total')).toHaveAttribute('data-count', '0')
    expect(screen.getByTestId('density-total')).toHaveTextContent('0 sessions in the last year')
  })

  test('a session lights its day and adds to the total', () => {
    render(<YouView doneGroups={groupWithSessions(['2026-09-08T09:00:00', '2026-09-08T15:00:00'])} now={now} />)

    const cell = document.querySelector('[data-date="2026-09-08"]')!
    expect(cell).toHaveAttribute('data-count', '2')
    expect(cell).toHaveAttribute('data-level', '4')
    expect(cell).toHaveAttribute('title', '2 sessions · Sep 08 2026')
    expect(screen.getByTestId('density-total')).toHaveTextContent('2 sessions in the last year')
  })

  test('a single session is "1 session" in its title', () => {
    render(<YouView doneGroups={groupWithSessions(['2026-09-08T09:00:00'])} now={now} />)
    expect(document.querySelector('[data-date="2026-09-08"]')).toHaveAttribute('title', '1 session · Sep 08 2026')
  })

  test('labels a month only when its run is at least two weeks wide', () => {
    render(<YouView doneGroups={[]} now={now} />)

    const labels = [...document.querySelectorAll('.work-density-months > div')].map((el) => el.textContent)
    expect(labels).toContain('Sep')
    expect(labels.every((label) => label === '' || /^[A-Z][a-z]{2}$/.test(label!))).toBe(true)
  })
})
