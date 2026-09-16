import { test, expect, type Page } from '@playwright/test'
import { gotoBoardTab } from './fixtures/boardTabs.js'

// Covers wire-backlog-batch-delete: the Backlog batch bar's "Delete (N)"
// button and the one confirm modal it shares with each row's own trash icon
// (the approved "Pipelinely Dashboard v2" design — the native confirm() the
// row used before is gone).
//
// `ui` project on purpose, and every POST /backlog/dismiss/:index is
// route-mocked rather than let through: the fixture BACKLOG.md is shared by
// every spec in this fullyParallel suite (batch-dispatch-staging.spec.ts
// reads the same three rows), so a real removal here would race them. What
// the dashboard SENDS — which indices, in which order, with which `original`
// guard — is exactly what a route mock answers, and the server side of that
// route is already covered by src/server.test.ts.
//
// Fixture rows (e2e/fixtures/tasks/BACKLOG.md), in file order:
//   0 "First batch-dispatch fixture item"
//   1 "Second batch-dispatch fixture item"
//   2 "Third batch-dispatch fixture item"

type DismissResponse = number | 'abort'

interface DismissPost {
  index: number
  original: { description: string }
}

// Records every dismiss POST and answers it with `respond(index)` — a status
// code, or 'abort' to simulate the server being unreachable.
async function mockDismiss(page: Page, respond: (index: number) => DismissResponse): Promise<DismissPost[]> {
  const posts: DismissPost[] = []
  await page.route('**/backlog/dismiss/*', async (route) => {
    const index = Number(new URL(route.request().url()).pathname.split('/').pop())
    posts.push({ index, original: route.request().postDataJSON().original })
    const response = respond(index)
    if (response === 'abort') return route.abort()
    return route.fulfill({ status: response, contentType: 'application/json', body: response === 409 ? '{"error":"conflict"}' : '' })
  })
  return posts
}

async function selectRows(page: Page, indices: number[]): Promise<void> {
  for (const index of indices) {
    await page.locator(`[data-testid="backlog-select-checkbox"][data-index="${index}"]`).check()
  }
}

function modal(page: Page) {
  return page.getByTestId('backlog-delete-modal')
}

test.describe('batch Delete button', () => {
  let nativeDialogCount: number

  test.beforeEach(async ({ page }) => {
    nativeDialogCount = 0
    page.on('dialog', (dialog) => { nativeDialogCount++; void dialog.dismiss() })
    await gotoBoardTab(page, 'backlog')
  })

  test('sits in the batch bar between clear and Run batch, carrying the selected count', async ({ page }) => {
    await selectRows(page, [0, 2])

    const deleteBtn = page.getByTestId('backlog-delete-selected-btn')
    await expect(deleteBtn).toBeVisible()
    await expect(page.getByTestId('backlog-delete-selected-count')).toHaveText('2')

    const barOrder = await page.getByTestId('backlog-batch-bar').evaluate((bar) =>
      Array.from(bar.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid')))
    const clearAt = barOrder.indexOf('backlog-clear-selected-btn')
    const deleteAt = barOrder.indexOf('backlog-delete-selected-btn')
    const runAt = barOrder.indexOf('backlog-run-selected-btn')
    expect(clearAt).toBeGreaterThanOrEqual(0)
    expect(deleteAt).toBeGreaterThan(clearAt)
    expect(runAt).toBeGreaterThan(deleteAt)
  })

  test('is not reachable with nothing selected', async ({ page }) => {
    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
    await expect(page.getByTestId('backlog-delete-selected-btn')).toBeHidden()
  })

  test('opens the confirm modal parameterized for N items, never a native dialog', async ({ page }) => {
    await selectRows(page, [0, 2])
    await expect(modal(page)).toBeHidden()

    await page.getByTestId('backlog-delete-selected-btn').click()

    await expect(modal(page)).toBeVisible()
    await expect(modal(page)).toHaveAttribute('data-count', '2')
    await expect(page.getByTestId('backlog-delete-headline')).toContainText('2')
    expect(nativeDialogCount).toBe(0)
  })

  test('Cancel closes the modal, sends nothing, and keeps the selection', async ({ page }) => {
    const posts = await mockDismiss(page, () => 200)
    await selectRows(page, [0, 2])
    await page.getByTestId('backlog-delete-selected-btn').click()

    await page.getByTestId('backlog-delete-cancel-btn').click()

    await expect(modal(page)).toBeHidden()
    await expect(page.getByTestId('backlog-selected-count')).toContainText('2')
    expect(posts).toEqual([])
  })

  test('clicking the scrim or pressing Escape also dismisses without sending', async ({ page }) => {
    const posts = await mockDismiss(page, () => 200)
    await selectRows(page, [1])

    await page.getByTestId('backlog-delete-selected-btn').click()
    await page.getByTestId('backlog-delete-scrim').click({ position: { x: 5, y: 5 } })
    await expect(modal(page)).toBeHidden()

    await page.getByTestId('backlog-delete-selected-btn').click()
    await expect(modal(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(modal(page)).toBeHidden()

    expect(posts).toEqual([])
  })

  test('confirming removes every selected item via /backlog/dismiss, highest index first', async ({ page }) => {
    const posts = await mockDismiss(page, () => 200)
    await selectRows(page, [0, 2])
    await page.getByTestId('backlog-delete-selected-btn').click()

    await page.getByTestId('backlog-delete-confirm-btn').click()

    // Descending, so removing one line from BACKLOG.md never shifts the index
    // of an item still waiting to be sent.
    await expect.poll(() => posts.map((p) => p.index)).toEqual([2, 0])
    expect(posts.map((p) => p.original.description)).toEqual([
      'Third batch-dispatch fixture item',
      'First batch-dispatch fixture item',
    ])
    await expect(modal(page)).toBeHidden()
    await expect(page.getByTestId('backlog-batch-bar')).not.toHaveClass(/is-open/)
    await expect(page.locator('[data-testid="backlog-select-checkbox"]:checked')).toHaveCount(0)
  })

  test('a conflict stops the batch and keeps every unremoved item selected', async ({ page }) => {
    const posts = await mockDismiss(page, (index) => (index === 2 ? 409 : 200))
    await selectRows(page, [0, 2])
    await page.getByTestId('backlog-delete-selected-btn').click()

    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect(page.getByTestId('backlog-delete-selected-btn')).toHaveClass(/btn-err/)
    expect(posts.map((p) => p.index)).toEqual([2])
    await expect(page.getByTestId('backlog-batch-bar')).toHaveClass(/is-open/)
    await expect(page.getByTestId('backlog-selected-count')).toContainText('2')
  })

  test('a mid-batch failure drops only the items that were actually removed', async ({ page }) => {
    const posts = await mockDismiss(page, (index) => (index === 0 ? 500 : 200))
    await selectRows(page, [0, 2])
    await page.getByTestId('backlog-delete-selected-btn').click()

    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect(page.getByTestId('backlog-delete-selected-btn')).toHaveClass(/btn-err/)
    expect(posts.map((p) => p.index)).toEqual([2, 0])
    await expect(page.getByTestId('backlog-selected-count')).toContainText('1')
    await expect(page.locator('[data-testid="backlog-select-checkbox"][data-index="0"]')).toBeChecked()
    await expect(page.locator('[data-testid="backlog-select-checkbox"][data-index="2"]')).not.toBeChecked()
  })

  test('an unreachable server keeps the selection intact and says so on the button', async ({ page }) => {
    await mockDismiss(page, () => 'abort')
    await selectRows(page, [1])
    await page.getByTestId('backlog-delete-selected-btn').click()

    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect(page.getByTestId('backlog-delete-selected-btn')).toHaveClass(/btn-err/)
    await expect(page.getByTestId('backlog-selected-count')).toContainText('1')
  })
})

test.describe('row trash icon shares the same modal', () => {
  let nativeDialogCount: number

  test.beforeEach(async ({ page }) => {
    nativeDialogCount = 0
    page.on('dialog', (dialog) => { nativeDialogCount++; void dialog.dismiss() })
    await gotoBoardTab(page, 'backlog')
  })

  test('opens the modal for exactly one item instead of a native confirm()', async ({ page }) => {
    await page.locator('[data-testid="backlog-dismiss-btn"][data-index="1"]').click()

    await expect(modal(page)).toBeVisible()
    await expect(modal(page)).toHaveAttribute('data-count', '1')
    expect(nativeDialogCount).toBe(0)
  })

  test('confirming removes only that row, even while other rows are selected', async ({ page }) => {
    const posts = await mockDismiss(page, () => 200)
    await selectRows(page, [0])

    await page.locator('[data-testid="backlog-dismiss-btn"][data-index="1"]').click()
    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect.poll(() => posts.map((p) => p.index)).toEqual([1])
    expect(posts[0].original.description).toBe('Second batch-dispatch fixture item')
    await expect(modal(page)).toBeHidden()
    // The row's own delete never consumes the batch selection it wasn't part of.
    await expect(page.getByTestId('backlog-selected-count')).toContainText('1')
  })

  test('cancelling sends nothing', async ({ page }) => {
    const posts = await mockDismiss(page, () => 200)
    await page.locator('[data-testid="backlog-dismiss-btn"][data-index="1"]').click()

    await page.getByTestId('backlog-delete-cancel-btn').click()

    await expect(modal(page)).toBeHidden()
    expect(posts).toEqual([])
  })

  test('a failed removal is surfaced on that row\'s trash button', async ({ page }) => {
    await mockDismiss(page, () => 409)
    const trash = page.locator('[data-testid="backlog-dismiss-btn"][data-index="1"]')
    await trash.click()

    await page.getByTestId('backlog-delete-confirm-btn').click()

    await expect(trash).toHaveClass(/btn-err/)
    await expect(trash).toBeEnabled()
  })
})
