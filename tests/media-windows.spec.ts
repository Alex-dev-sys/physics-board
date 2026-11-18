import { expect, test } from '@playwright/test'
import { deflateSync } from 'node:zlib'

test('media windows can be focused, pinned, minimized and restored', async ({page})=>{
 await page.goto('/')
 await expect(page.locator('.tl-canvas')).toBeVisible()
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a4sAAAAASUVORK5CYII=','base64')
 await page.locator('input[type=file]').setInputFiles([
  {name:'first.png',mimeType:'image/png',buffer:png},
  {name:'second.png',mimeType:'image/png',buffer:png},
 ])
 const first=page.locator('.media-window').filter({hasText:'first.png'})
 const second=page.locator('.media-window').filter({hasText:'second.png'})
 await expect(first).toBeVisible()
 await expect(second).toBeVisible()
 const topWindow=()=>page.evaluate(()=>document.elementFromPoint(1100,200)?.closest('.media-window')?.querySelector('strong')?.textContent)
 expect(await topWindow()).toBe('second.png')
 await page.mouse.click(1410,200)
 await expect.poll(topWindow).toBe('first.png')
 await first.getByRole('button',{name:'Закрепить поверх окон'}).click()
 await expect(first.getByRole('button',{name:'Открепить окно'})).toHaveAttribute('aria-pressed','true')
 await page.mouse.click(960,200)
 expect(await topWindow()).toBe('first.png')
 await first.getByRole('button',{name:'Открепить окно'}).click()
 await page.mouse.click(960,200)
 await expect.poll(topWindow).toBe('second.png')
 await second.getByTitle('Свернуть').click()
 await expect(second).toBeHidden()
 await page.locator('.dock').getByText('second.png').click()
 await expect(second).toBeVisible()
 await expect.poll(topWindow).toBe('second.png')
 const before=await second.boundingBox()
 expect(before).not.toBeNull()
 await page.mouse.move(before!.x+before!.width-3,before!.y+before!.height-3)
 await page.mouse.down()
 await page.mouse.move(before!.x+before!.width+55,before!.y+before!.height+45,{steps:6})
 await page.mouse.up()
 await expect.poll(async()=> (await second.boundingBox())!.width).toBeGreaterThan(before!.width+30)
 const resized=await second.boundingBox()
 await page.mouse.move(resized!.x+80,resized!.y+20)
 await page.mouse.down()
 await page.mouse.move(resized!.x+30,resized!.y+60,{steps:6})
 await page.mouse.up()
 await expect.poll(async()=> (await second.boundingBox())!.x).toBeLessThan(resized!.x-30)
})

test('closing a file releases its temporary URL but minimizing keeps it available', async ({page})=>{
 await page.addInitScript(()=>{
  const revoke=URL.revokeObjectURL.bind(URL)
  ;(window as unknown as {revokedUrls:string[]}).revokedUrls=[]
  URL.revokeObjectURL=(url:string)=>{(window as unknown as {revokedUrls:string[]}).revokedUrls.push(url);revoke(url)}
 })
 await page.goto('/')
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a4sAAAAASUVORK5CYII=','base64')
 await page.locator('input[type=file]').setInputFiles({name:'task.png',mimeType:'image/png',buffer:png})
 const window=page.locator('.media-window').filter({hasText:'task.png'})
 const url=await window.getByAltText('task.png').getAttribute('src')
 expect(url).toMatch(/^blob:/)
 await window.getByTitle('Свернуть').click()
 await expect(window).toBeHidden()
 expect(await page.evaluate(value=>(globalThis as unknown as {revokedUrls:string[]}).revokedUrls.includes(value!),url)).toBe(false)
 await page.locator('.dock').getByText('task.png').click()
 await window.getByRole('button',{name:'На доску'}).click()
 await expect(page.locator('img.tl-image')).toHaveCount(1)
 await window.getByTitle('Закрыть').click()
 await expect.poll(()=>page.evaluate(value=>(globalThis as unknown as {revokedUrls:string[]}).revokedUrls.includes(value!),url)).toBe(true)
 await expect.poll(()=>page.locator('img.tl-image').evaluate((image:HTMLImageElement)=>image.complete&&image.naturalWidth>0)).toBe(true)
})

test('material window controls stay reachable after switching to a narrow viewport', async ({ page }) => {
 await page.goto('/')
 const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a4sAAAAASUVORK5CYII=', 'base64')
 await page.locator('input[type=file]').setInputFiles({ name: 'phone.png', mimeType: 'image/png', buffer: png })
 const material = page.locator('.media-window')
 await expect(material).toBeVisible()
 await page.setViewportSize({ width: 360, height: 480 })
 const bounds = await material.boundingBox()
 expect(bounds.x + bounds.width).toBeLessThanOrEqual(360)
 expect(bounds.y + bounds.height).toBeLessThanOrEqual(480)
 await material.getByTitle('Закрыть').click()
 await expect(material).toHaveCount(0)
})

test('a high-resolution PDF scan inserts a real image on the board', async ({ page }) => {
 const width = 2000
 const height = 1600
 const pixels = Buffer.alloc(width * height * 3)
 let random = 123456
 for (let i = 0; i < pixels.length; i++) {
  random ^= random << 13
  random ^= random >>> 17
  random ^= random << 5
  pixels[i] = random & 255
 }
 const image = deflateSync(pixels)
 const content = 'q ' + width + ' 0 0 ' + height + ' 0 0 cm /Scan Do Q'
 const objects = [
  Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
  Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
  Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + width + ' ' + height +
   '] /Resources << /XObject << /Scan 5 0 R >> >> /Contents 4 0 R >>'),
  Buffer.from('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream'),
  Buffer.concat([Buffer.from('<< /Type /XObject /Subtype /Image /Width ' + width + ' /Height ' + height +
   ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ' + image.length + ' >>\nstream\n'),
  image, Buffer.from('\nendstream')]),
 ]
 const pieces = [Buffer.from('%PDF-1.4\n')]
 const offsets = []
 let offset = pieces[0].length
 for (const [i, object] of objects.entries()) {
  const piece = Buffer.concat([Buffer.from((i + 1) + ' 0 obj\n'), object, Buffer.from('\nendobj\n')])
  offsets.push(String(offset).padStart(10, '0') + ' 00000 n \n')
  pieces.push(piece)
  offset += piece.length
 }
 pieces.push(Buffer.from('xref\n0 6\n0000000000 65535 f \n' + offsets.join('') +
  'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + offset + '\n%%EOF\n'))

 await page.goto('/')
 await expect(page.locator('.tl-canvas')).toBeVisible()
 let releaseWorker: () => void
 const workerReady = new Promise<void>(resolve => { releaseWorker = resolve })
 await page.route('**/pdf.worker.min.mjs', async route => {
  await workerReady
  await route.continue()
 })
 await page.locator('input[type=file]').setInputFiles({ name: 'scan.pdf', mimeType: 'application/pdf', buffer: Buffer.concat(pieces) })
 const pdf = page.locator('[data-shape-type=pdf]')
 try {
  await expect(pdf.getByText('scan.pdf')).toBeVisible()
  await expect(pdf.getByText('Обрабатывается…')).toBeVisible()
 } finally {
  releaseWorker()
 }
 await expect(pdf.locator('canvas')).toBeVisible()
 await expect(page.getByRole('toolbar', { name: 'Действия с scan.pdf' })).toContainText('1 / 1')
 await expect(page.locator('.media-window')).toHaveCount(0)
 await page.getByTitle('Добавить страницу на доску').click()
 await expect(page.locator('img.tl-image')).toHaveCount(1)
 await expect.poll(() => page.locator('img.tl-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
 await page.reload()
 await expect(pdf.locator('canvas')).toBeVisible()
})
