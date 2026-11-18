import { expect, test } from '@playwright/test'

test('an intentionally cleared personal board stays empty after reload',async({page})=>{
 await page.goto('/board')
 const shapes=page.locator('[data-shape-id]')
 await expect.poll(()=>shapes.count()).toBeGreaterThanOrEqual(10)
 await page.locator('.tl-canvas').click({position:{x:900,y:800}})
 await page.keyboard.press('Control+a')
 await page.keyboard.press('Backspace')
 await expect.poll(()=>shapes.count()).toBe(0)
 await page.waitForTimeout(1500)
 await page.reload()
 await expect(page.locator('.tl-canvas')).toBeVisible()
 await expect(shapes).toHaveCount(0)
 await page.getByRole('button',{name:'Пружина'}).click()
 await expect.poll(()=>shapes.count()).toBeGreaterThan(0)
})
