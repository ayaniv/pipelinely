import { describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DetailMetaRow } from './DetailMetaRow'

// Four labeled mono pairs
// (tok/cost/sessions/model), computed by taskScope.ts's detailMetaPairs and
// rendered here purely as markup.

describe('DetailMetaRow', () => {
  test('renders one label+value pair per entry, in order', () => {
    render(
      <DetailMetaRow
        pairs={[
          ['tok', '2.5M'],
          ['cost', '$9.00'],
          ['sessions', '1'],
          ['model', 'Sonnet'],
        ]}
      />,
    )
    const labels = screen.getAllByTestId('detail-meta-label').map((el) => el.textContent)
    const values = screen.getAllByTestId('detail-meta-value').map((el) => el.textContent)
    expect(labels).toEqual(['tok', 'cost', 'sessions', 'model'])
    expect(values).toEqual(['2.5M', '$9.00', '1', 'Sonnet'])
  })

  test('renders nothing for an empty pair list rather than an empty wrapper row', () => {
    const { container } = render(<DetailMetaRow pairs={[]} />)
    expect(container.querySelectorAll('.detail-meta-pair')).toHaveLength(0)
  })
})
