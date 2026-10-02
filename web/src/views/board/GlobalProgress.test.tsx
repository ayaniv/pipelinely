import { describe, expect, test, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import { GlobalProgress } from './GlobalProgress'

// The container itself belongs to the app frame (#global-progress) and the
// stylesheet keys off its `is-visible` class, so it is exercised through a real container element here.

afterEach(() => { document.body.innerHTML = '' })

function setup(activeProject: Parameters<typeof GlobalProgress>[0]['activeProject']) {
  const container = document.createElement('div')
  container.id = 'global-progress'
  document.body.appendChild(container)
  const view = render(<GlobalProgress activeProject={activeProject} />)
  return { slot: container, ...view }
}

describe('GlobalProgress', () => {
  test('shows the project label, ratio and a proportional fill, and makes the container visible', () => {
    const { slot: container } = setup({ projectBase: 'react-migration', current: 3, total: 4 })

    expect(container).toHaveClass('is-visible')
    expect(container.querySelector('.global-progress-label')).toHaveTextContent('react-migration')
    expect(container.querySelector('.global-progress-ratio')).toHaveTextContent('3/4')
    expect((container.querySelector('.global-progress-fill') as HTMLElement).style.width).toBe('75%')
  })

  test('rounds the percentage', () => {
    const { slot: container } = setup({ projectBase: 'p', current: 1, total: 3 })
    expect((container.querySelector('.global-progress-fill') as HTMLElement).style.width).toBe('33%')
  })

  test('is hidden and empty when there is no active project', () => {
    const { slot: container } = setup(null)
    expect(container).not.toHaveClass('is-visible')
    expect(container).toBeEmptyDOMElement()
  })

  test('a project with no steps is hidden rather than dividing by zero', () => {
    const { slot: container } = setup({ projectBase: 'empty', current: 0, total: 0 })
    expect(container).not.toHaveClass('is-visible')
    expect(container.querySelector('.global-progress-fill')).not.toBeInTheDocument()
  })
})
