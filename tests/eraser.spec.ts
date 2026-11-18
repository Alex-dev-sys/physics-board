import { expect, test } from '@playwright/test'

test('editor remains available after the license check', async ({page}) => {
 await page.goto(process.env.TEST_BASE_URL || '/')
 await expect(page.locator('.tl-canvas')).toBeVisible()
 await page.waitForTimeout(6500) // tldraw enforces the production license after five seconds.
 await expect(page.locator('[data-testid="tl-license-expired"]')).toHaveCount(0)
 await expect(page.locator('.tl-canvas')).toBeVisible()
})

test('an expired license shows an explanation instead of a blank board', async ({page}) => {
 await page.goto('/')
 await expect(page.locator('.tl-canvas')).toBeVisible()
 await page.locator('.canvas').evaluate(container=>{
  const gate=document.createElement('div')
  gate.dataset.testid='tl-license-expired'
  container.appendChild(gate)
 })
 await expect(page.locator('.license-notice')).toContainText('Лицензия редактора не активна')
 await page.locator('[data-testid="tl-license-expired"]').evaluate(gate=>gate.remove())
 await expect(page.locator('.license-notice')).toHaveCount(0)
})

for (const tool of ['Карандаш','Маркер']) test(`partial eraser splits a ${tool} stroke and undo restores it`, async ({ page }) => {
 await page.setViewportSize({width:1400,height:900})
 await page.goto(process.env.TEST_BASE_URL || '/')
 const shapes=page.locator('[data-shape-id]')
 const ids=()=>shapes.evaluateAll(elements=>Array.from(new Set(elements.map(element=>element.getAttribute('data-shape-id')))))
 await expect.poll(()=>shapes.count()).toBeGreaterThanOrEqual(10)
 const before=await ids()
 await page.getByRole('button',{name:tool}).click()
 await page.mouse.move(390,650)
 await page.mouse.down()
 await page.mouse.move(850,650,{steps:40})
 await page.mouse.up()
 await expect.poll(async()=> (await ids()).filter(id=>!before.includes(id)).length).toBe(1)
 const drawn=await ids()
 const original=drawn.find(id=>!before.includes(id))
 expect(original).toBeTruthy()
 await page.getByRole('button',{name:'Ластик'}).click()
 const menu=page.getByRole('dialog',{name:'Настройки инструмента'})
 await menu.getByRole('button',{name:'Часть штриха'}).click()
 await page.mouse.move(620,630)
 await page.mouse.down()
 await page.mouse.move(620,670,{steps:6})
 await page.mouse.up()
 await expect.poll(async()=> (await ids()).filter(id=>!before.includes(id)).length).toBe(2)
 await page.getByTitle('Отменить').click()
 await expect.poll(async()=> (await ids()).filter(id=>!before.includes(id)).length).toBe(1)
 expect(await ids()).toContain(original)
 await page.getByTitle('Повторить').click()
 await expect.poll(async()=> (await ids()).filter(id=>!before.includes(id)).length).toBe(2)
})
