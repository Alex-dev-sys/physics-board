import { test, expect } from '@playwright/test'

test('physics presets create editable board objects that survive reload', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  const spring = page.getByRole('button', { name: 'Пружина' })
  await expect(spring).toBeVisible()
  const before = await page.locator('[data-shape-id]').count()
  for (const name of ['Плоскость', 'Тело', 'Оси X / Y', 'Пружина', 'Резистор', 'Конденсатор', 'Линза']) {
    await page.getByRole('button', { name }).click()
  }
  const after = await page.locator('[data-shape-id]').count()
  expect(after).toBeGreaterThan(before)
  await page.waitForTimeout(1500) // tldraw persists asynchronously to IndexedDB
  await page.reload()
  await expect(spring).toBeVisible()
  await expect.poll(() => page.locator('[data-shape-id]').count()).toBe(after)
  expect(errors).toEqual([])
})

test('preset list remains usable on a shorter screen', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.goto('/')
  const lens = page.getByRole('button', { name: 'Линза' })
  await lens.scrollIntoViewIfNeeded()
  await lens.click()
  await expect(page.getByText('Объект добавлен на доску')).toBeVisible()
})
