import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SnapshotPlaceholder } from './SnapshotPlaceholder'

describe('SnapshotPlaceholder', () => {
  test('says the board is loading while the first snapshot is on its way', () => {
    render(<SnapshotPlaceholder connection="connecting" />)

    expect(screen.getByTestId('snapshot-loading')).toHaveTextContent('Loading')
    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('board-empty-state')).not.toBeInTheDocument()
  })

  test('reports an unreachable server as an alert, so it is never mistaken for an empty board', () => {
    render(<SnapshotPlaceholder connection="reconnecting" />)

    expect(screen.getByTestId('snapshot-error')).toHaveTextContent("Can't reach the server")
    expect(screen.getByRole('alert')).toBeInTheDocument()
  })

  test('a live stream that has not delivered yet is still just loading', () => {
    render(<SnapshotPlaceholder connection="live" />)
    expect(screen.getByTestId('snapshot-loading')).toBeInTheDocument()
  })
})
