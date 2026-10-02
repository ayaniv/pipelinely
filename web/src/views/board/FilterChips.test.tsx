import { describe, expect, test, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FilterChips } from './FilterChips'

describe('FilterChips', () => {
  test('renders one chip per option carrying its raw value', () => {
    render(<FilterChips options={['acme-api', 'cockpit-ai']} selected={new Set()} onToggle={vi.fn()} />)

    const chip = screen.getByTestId('filter-chip-project-acme-api')
    expect(chip).toHaveAttribute('data-value', 'acme-api')
    expect(chip).toHaveTextContent('acme-api')
    expect(chip).not.toHaveClass('is-active')
  })

  test('selected values render active; several can be active at once', () => {
    render(<FilterChips options={['a', 'b', 'c']} selected={new Set(['a', 'c'])} onToggle={vi.fn()} />)
    expect(screen.getByTestId('filter-chip-project-a')).toHaveClass('is-active')
    expect(screen.getByTestId('filter-chip-project-b')).not.toHaveClass('is-active')
    expect(screen.getByTestId('filter-chip-project-c')).toHaveClass('is-active')
  })

  test('clicking a chip reports its value', () => {
    const onToggle = vi.fn()
    render(<FilterChips options={['a', 'b']} selected={new Set()} onToggle={onToggle} />)
    fireEvent.click(screen.getByTestId('filter-chip-project-b'))
    expect(onToggle).toHaveBeenCalledWith('b')
  })

  test('has no synthetic "All" chip, and renders nothing for no options', () => {
    const { container } = render(<FilterChips options={[]} selected={new Set()} onToggle={vi.fn()} />)
    expect(container).toBeEmptyDOMElement()
  })
})
