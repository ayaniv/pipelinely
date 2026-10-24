import { expect, type Page } from '@playwright/test'

// A fan-out parent has no card (it is a Parent tasks row), so it is reached by
// its URL; every other task by clicking its card's title like a user would.
export async function openTask(page: Page, slug: string): Promise<void> {
  await page.goto('/')
  const cardTitle = page.locator(`.card[data-slug="${slug}"] .card-title`)
  const parentRow = page.locator(`[data-testid="parent-row"][data-slug="${slug}"]`)
  await expect(cardTitle.or(parentRow)).toBeVisible()
  if (await parentRow.count()) await page.goto(`/task/${slug}`)
  else await cardTitle.click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}
