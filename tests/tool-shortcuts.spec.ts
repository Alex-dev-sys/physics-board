import { expect, test } from '@playwright/test'

test('keyboard shortcuts select the tools shown in the toolbar without interrupting text entry',async({page})=>{
 await page.goto('/board')
 await expect(page.locator('.tl-canvas')).toBeVisible()
 await page.locator('.tl-canvas').click({position:{x:900,y:850}})
 for(const [key,name] of [['p','Карандаш'],['b','Маркер'],['e','Ластик'],['a','Стрелка'],['r','Фигуры'],['v','Выбор'],['h','Перемещение'],['t','Текст']]){
  await page.keyboard.press(key)
  await expect(page.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true')
 }
 await page.locator('.tl-canvas').click({position:{x:900,y:850}})
 await page.keyboard.type('paper')
 await expect(page.getByTestId('rich-text-area').getByText('paper',{exact:true})).toBeVisible()
 await page.keyboard.press('Escape')
 await page.keyboard.press('r')
 await page.mouse.move(500,850);await page.mouse.down();await page.mouse.move(650,950,{steps:6});await page.mouse.up()
 await expect(page.getByRole('button',{name:'Выбор',exact:true})).toHaveAttribute('aria-pressed','true')
})
