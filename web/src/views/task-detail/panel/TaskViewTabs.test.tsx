import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { TASK_VIEW_PANEL_ID, TaskViewTabs } from './TaskViewTabs'

describe('TaskViewTabs semantics', () => {
  test('is a tablist of two tabs, exactly one selected', () => {
    render(<TaskViewTabs activeView="result" onSelect={vi.fn()} />)
    expect(screen.getByRole('tablist')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByTestId('task-view-tab-result')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByTestId('task-view-tab-pipeline')).toHaveAttribute('aria-selected', 'false')
  })

  test('every tab controls the one panel the page renders under the bar', () => {
    render(<TaskViewTabs activeView="pipeline" onSelect={vi.fn()} />)
    for (const tab of screen.getAllByRole('tab')) expect(tab).toHaveAttribute('aria-controls', TASK_VIEW_PANEL_ID)
  })

  test('only the selected tab is in the tab order', () => {
    render(<TaskViewTabs activeView="pipeline" onSelect={vi.fn()} />)
    expect(screen.getByTestId('task-view-tab-pipeline')).toHaveAttribute('tabindex', '0')
    expect(screen.getByTestId('task-view-tab-result')).toHaveAttribute('tabindex', '-1')
  })

  test('clicking a tab selects that view', () => {
    const onSelect = vi.fn()
    render(<TaskViewTabs activeView="pipeline" onSelect={onSelect} />)
    fireEvent.click(screen.getByTestId('task-view-tab-result'))
    expect(onSelect).toHaveBeenCalledWith('result')
  })

  test('arrow keys move the selection between the two tabs', () => {
    const onSelect = vi.fn()
    render(<TaskViewTabs activeView="pipeline" onSelect={onSelect} />)
    fireEvent.keyDown(screen.getByTestId('task-view-tab-pipeline'), { key: 'ArrowRight' })
    expect(onSelect).toHaveBeenLastCalledWith('result')
    fireEvent.keyDown(screen.getByTestId('task-view-tab-pipeline'), { key: 'ArrowLeft' })
    expect(onSelect).toHaveBeenLastCalledWith('result')
  })

  test('ArrowRight moves focus onto the newly selected tab', () => {
    render(<TaskViewTabs activeView="pipeline" onSelect={vi.fn()} />)
    fireEvent.keyDown(screen.getByTestId('task-view-tab-pipeline'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(screen.getByTestId('task-view-tab-result'))
  })

  test('ArrowLeft moves focus onto the newly selected tab', () => {
    render(<TaskViewTabs activeView="result" onSelect={vi.fn()} />)
    fireEvent.keyDown(screen.getByTestId('task-view-tab-result'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(screen.getByTestId('task-view-tab-pipeline'))
  })

  test('each tab has a stable id', () => {
    render(<TaskViewTabs activeView="pipeline" onSelect={vi.fn()} />)
    expect(screen.getByTestId('task-view-tab-pipeline')).toHaveAttribute('id', 'task-view-tab-pipeline')
    expect(screen.getByTestId('task-view-tab-result')).toHaveAttribute('id', 'task-view-tab-result')
  })
})

// jsdom does no layout, so the scroll behaviour is pinned where it is defined:
// in stylesheets the component imports, not in the global app.css.
describe('the Result view styles live in the React tree', () => {
  const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), 'utf-8')

  test('the wide-table scroll wrapper scrolls sideways, in ServerHtml.css', () => {
    expect(read('web/src/components/ServerHtml.css')).toMatch(/\.markdown-body \.md-table-scroll\s*\{[^}]*overflow-x:\s*auto/)
  })

  test('nothing the Result tab depends on lives only in the global app.css', () => {
    const globalCss = read('web/src/styles/app.css')
    expect(globalCss).not.toContain('md-table-scroll')
    expect(globalCss).not.toMatch(/\.markdown-body\s*\{/)
    expect(read('web/src/views/task-detail/panel/ResultTab.css')).toContain('.result-tab')
    expect(read('web/src/views/task-detail/panel/TaskViewTabs.css')).toContain('.task-view-tab')
  })

  test.each(['ResultTab', 'TaskViewTabs'])('%s imports its own stylesheet', (name) => {
    expect(read(`web/src/views/task-detail/panel/${name}.tsx`)).toContain(`import './${name}.css'`)
  })
})
