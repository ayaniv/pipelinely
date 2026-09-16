import { expect, type Page } from '@playwright/test'

export async function openTask(page: Page, slug: string): Promise<void> {
  await page.goto('/')
  await page.locator(`.card[data-slug="${slug}"] .card-title`).click()
  await expect(page.getByTestId('task-detail')).toBeVisible()
}
