import { test, expect, type WebSocketRoute, type Page } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import * as Y from 'yjs'
import { readCloudRecords } from '../app/cloud/store-binding'

async function cloudRecordIds(page:Page):Promise<string[]>{
 const updates=await page.evaluate(async()=>{
  const databases=await indexedDB.databases()
  const name=databases.find(db=>db.name?.startsWith('physics-board-cloud-'))?.name
  if(!name)return []
  const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open(name);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
  const values=await new Promise<Uint8Array[]>((resolve,reject)=>{const request=db.transaction('updates').objectStore('updates').getAll();request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)})
  db.close()
  return values.map(value=>Array.from(value))
 })
 const doc=new Y.Doc()
 for(const bytes of updates)Y.applyUpdate(doc,new Uint8Array(bytes))
 const ids=Object.keys(readCloudRecords(doc))
 doc.destroy()
 return ids
}

test.skip(!process.env.RUN_CLOUD_INTEGRATION, 'Requires explicit cloud integration run')
test.setTimeout(90000)

test('independent browsers share a cloud board and recover after reopening',async({browser})=>{
 const first=await browser.newContext(),second=await browser.newContext()
 const a=await first.newPage(),b=await second.newPage(),errors:string[]=[],userIds:string[]=[]
 for(const page of [a,b]){
  page.on('pageerror',e=>errors.push(e.message))
  page.on('response',async response=>{
   if(!response.url().includes('/auth/v1/signup')||!response.ok())return
   try{const body=await response.json();const id=body.user?.id;if(id&&!userIds.includes(id)){userIds.push(id);writeFileSync('.cloud-test-users.json',JSON.stringify(userIds))}}catch{}
  })
 }
 try{
  await a.goto('/dev-cloud')
  await a.getByRole('button',{name:'Добавить фигуру'}).click()
  await a.getByRole('button',{name:'Создать облачную комнату'}).click()
  await expect(a.getByTestId('status')).toHaveText('saved',{timeout:30000})
  await expect(a.locator('.tl-canvas:visible')).toBeVisible()
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count()).toBe(1)
  const url=a.url()
  await b.goto(url)
  await expect(b.getByTestId('status')).toHaveText('saved',{timeout:30000})
  await expect.poll(()=>b.locator('[data-shape-id]').count()).toBe(1)
  await Promise.all([a.getByRole('button',{name:'Добавить фигуру'}).click(),b.getByRole('button',{name:'Добавить фигуру'}).click()])
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count(),{timeout:20000}).toBe(3)
  await expect.poll(()=>b.locator('[data-shape-id]').count(),{timeout:20000}).toBe(3)
  await expect.poll(()=>a.evaluate(()=>(window as any).testEditor.store.allRecords().filter((r:any)=>r.typeName==='instance_presence').length),{timeout:20000}).toBeGreaterThan(0)
  await a.bringToFront();await a.mouse.move(500,400)
  await expect(b.locator('.tl-collaborator__cursor')).toBeVisible({timeout:10000})
  const oldCursor=await b.locator('.tl-collaborator__cursor').boundingBox()
  for(let i=0;i<10;i++){await a.mouse.move(520+i*15,400);await a.waitForTimeout(140)}
  await expect.poll(async()=>{const bounds=await b.locator('.tl-collaborator__cursor').boundingBox();return bounds&&oldCursor?Math.abs(bounds.x-oldCursor.x):0},{timeout:10000}).toBeGreaterThan(30)
  await expect(a.getByTestId('status')).toHaveText('saved',{timeout:20000})
  await expect(a.getByTestId('status')).toHaveText('saved',{timeout:20000})
  await expect(b.getByTestId('status')).toHaveText('saved',{timeout:20000})
  await a.reload()
  await expect(a.getByTestId('status')).toHaveText('saved',{timeout:30000})
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count()).toBe(3)
  expect(errors).toEqual([])
 }finally{await first.close();await second.close()}
})

test('main board shares its existing image and synchronizes another browser',async({browser})=>{
 const first=await browser.newContext(),second=await browser.newContext()
 const a=await first.newPage(),b=await second.newPage(),errors:string[]=[],userIds:string[]=[],failures:string[]=[]
 let socket:WebSocketRoute|undefined,blockSocket=false
 await a.routeWebSocket(/\/realtime\/v1\/websocket/,ws=>{if(blockSocket){void ws.close();return}socket=ws;ws.connectToServer()})
 for(const page of [a,b]){
  page.on('pageerror',e=>errors.push(e.message))
  page.on('response',response=>{if(response.status()>=400&&response.url().includes('supabase.co'))failures.push(`${response.status()} ${new URL(response.url()).pathname}`)})
  page.on('response',async response=>{
   if(!response.url().includes('/auth/v1/signup')||!response.ok())return
   try{const body=await response.json();const id=body.user?.id;if(id&&!userIds.includes(id)){userIds.push(id);writeFileSync('.cloud-test-users.json',JSON.stringify(userIds))}}catch{}
  })
 }
 try{
  await a.goto(process.env.TEST_BASE_URL || '/')
  await expect(a.getByRole('button',{name:'Пружина'})).toBeVisible()
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a4sAAAAASUVORK5CYII=','base64')
  await a.locator('input[type=file]').setInputFiles({name:'task.png',mimeType:'image/png',buffer:png})
  await a.locator('.media-footer').getByRole('button',{name:'На доску'}).click()
  await expect(a.locator('img.tl-image')).toHaveCount(1)
  const before=await a.locator('[data-shape-id]:visible').count()
  await a.getByRole('button',{name:'Поделиться'}).click()
  const dialog=a.getByRole('dialog',{name:'Пригласить на доску'})
  await expect(dialog).toBeVisible({timeout:45000})
  const url=await dialog.getByLabel('Ссылка на доску').inputValue()
  expect(url).toContain('#cloud=')
  await dialog.getByLabel('Закрыть').click()
  await b.goto(url)
  await expect(b.getByText('Облачная комната')).toBeVisible()
  await expect.poll(()=>b.locator('[data-shape-id]').count(),{timeout:30000}).toBe(before)
  const image=b.locator('img.tl-image').first()
  await expect(image).toBeVisible({timeout:20000})
  await expect.poll(()=>image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0),{timeout:15000}).toBe(true)
  await b.getByRole('button',{name:'Резистор'}).click()
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count(),{timeout:20000}).toBeGreaterThan(before)
  await a.bringToFront()
  for(let i=0;i<10;i++){await a.mouse.move(400+i*20,400);await a.waitForTimeout(140)}
  await expect(a.getByText('Сохранено в облаке')).toBeVisible({timeout:10000})
  expect(socket).toBeDefined()
  blockSocket=true
  await socket!.close()
  const beforeIds=await cloudRecordIds(a)
  await a.getByRole('button',{name:'Карандаш'}).click()
  await a.mouse.move(360,550);await a.mouse.down();await a.mouse.move(800,550,{steps:40});await a.mouse.up()
  await expect.poll(async()=> (await cloudRecordIds(a)).filter(id=>id.startsWith('shape:')&&!beforeIds.includes(id)).length,{timeout:10000}).toBe(1)
  const original=(await cloudRecordIds(a)).find(id=>id.startsWith('shape:')&&!beforeIds.includes(id))
  expect(original).toBeTruthy()
  await expect.poll(async()=> (await cloudRecordIds(b)).includes(original!),{timeout:20000}).toBe(true)
  await a.getByRole('button',{name:'Ластик'}).click()
  await a.getByRole('button',{name:'Часть штриха'}).click()
  await expect(a.locator('.tl-canvas:visible')).toBeVisible()
  await a.mouse.move(600,530);await a.mouse.down();await a.mouse.move(600,570,{steps:6});await a.mouse.up()
  try{await expect.poll(async()=> (await cloudRecordIds(a)).filter(id=>id.startsWith('shape:')&&!beforeIds.includes(id)).length,{timeout:10000}).toBe(2)}
  catch(error){console.log('Author board:',(await a.locator('body').innerText()).slice(0,1800),'Canvas:',await a.locator('.tl-canvas:visible').count(),'Browser errors:',errors,'Failed requests:',failures);throw error}
  const fragments=(await cloudRecordIds(a)).filter(id=>id.startsWith('shape:')&&!beforeIds.includes(id))
  expect(fragments).toHaveLength(2)
  try{await expect.poll(async()=>{const ids=await cloudRecordIds(b);return fragments.every(id=>id&&ids.includes(id))},{timeout:20000}).toBe(true)}
  catch(error){console.log('Board status:',await a.locator('.board-name').innerText(),'Failed requests:',failures,'Browser errors:',errors);throw error}
  await a.getByTitle('Отменить').click()
  await expect.poll(async()=>{const ids=await cloudRecordIds(b);return fragments.filter(id=>id&&ids.includes(id)).length},{timeout:20000}).toBe(1)
  try{await expect(a.getByText('Сохранено в облаке')).toBeVisible({timeout:20000})}
  catch(error){console.log('Board status:',await a.locator('.board-name').innerText(),'Failed requests:',failures,'Browser errors:',errors);throw error}
  blockSocket=false
  await a.reload()
  await expect(a.getByText('Сохранено в облаке')).toBeVisible({timeout:30000})
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count()).toBeGreaterThan(before)
  expect(errors).toEqual([])
 }finally{
  // Remove only assets uploaded by this short-lived test user, before the
  // administrator removes its anonymous account and room.
  const session=await a.evaluate(()=>{const k=Object.keys(localStorage).find(key=>key.startsWith('sb-')&&key.endsWith('-auth-token'));return k?JSON.parse(localStorage.getItem(k) || 'null'):null}).catch(()=>null)
  if(session?.access_token&&session?.refresh_token){
   const {createClient}=await import('@supabase/supabase-js')
   const client=createClient('https://kiqgwzigmubtcyuxojyh.supabase.co','sb_publishable_e_qw5ej96HXJzjg8guDT8Q_xBeDKPJx',{auth:{persistSession:false,autoRefreshToken:false}})
   await client.auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token})
   const {data:rooms}=await client.from('board_rooms').select('id').eq('owner_id',session.user.id)
   for(const room of rooms||[]){const {data:files}=await client.storage.from('board-materials').list(room.id);if(files?.length)await client.storage.from('board-materials').remove(files.map(file=>`${room.id}/${file.name}`))}
  }
  await first.close();await second.close()
 }
})



test('shared PDF opens on both boards, follows pages and inserts a crop',async({browser})=>{
 const generator=await browser.newPage()
 await generator.setContent('<html><body><h1>First problem</h1><div style="break-before:page"><h1>Second problem</h1></div></body></html>')
 const pdf=await generator.pdf({format:'A4'});await generator.close()
 const first=await browser.newContext(),second=await browser.newContext()
 const a=await first.newPage(),b=await second.newPage(),errors:string[]=[],userIds:string[]=[]
 await a.addInitScript(()=>{
  const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL)
  const state=window as unknown as {createdPdfUrl?:string;revokedUrls:string[]}
  state.revokedUrls=[]
  URL.createObjectURL=(value:Blob|MediaSource)=>{const url=create(value);if(value instanceof File&&value.name==='problems.pdf')state.createdPdfUrl=url;return url}
  URL.revokeObjectURL=(url:string)=>{state.revokedUrls.push(url);revoke(url)}
 })
 await b.clock.install()
 for(const page of [a,b]){
  page.on('pageerror',e=>errors.push(e.message))
  page.on('response',async response=>{
   if(!response.url().includes('/auth/v1/signup')||!response.ok())return
   try{const body=await response.json();const id=body.user?.id;if(id&&!userIds.includes(id)){userIds.push(id);writeFileSync('.cloud-test-users.json',JSON.stringify(userIds))}}catch{}
  })
 }
 try{
  await a.goto(process.env.TEST_BASE_URL || '/')
  await expect(a.getByRole('button',{name:'Пружина'})).toBeVisible()
  await a.locator('input[type=file]').setInputFiles({name:'problems.pdf',mimeType:'application/pdf',buffer:pdf})
  const localPdfUrl=await a.evaluate(()=>(window as unknown as {createdPdfUrl?:string}).createdPdfUrl)
  expect(localPdfUrl).toBeTruthy()
  await expect(a.locator('.pdf-toolbar').getByText('1 / 2')).toBeVisible({timeout:20000})
  await a.getByTitle('Следующая страница').click()
  await expect(a.locator('.pdf-toolbar').getByText('2 / 2')).toBeVisible()
  await a.getByRole('button',{name:'Поделиться'}).click()
  const dialog=a.getByRole('dialog',{name:'Пригласить на доску'})
  await expect(dialog).toBeVisible({timeout:45000})
  const url=await dialog.getByLabel('Ссылка на доску').inputValue()
  await dialog.getByLabel('Закрыть').click()
  let firstOpenAttempts=0
  await b.route('**/storage/v1/object/sign/**',async route=>{
   firstOpenAttempts++
   if(firstOpenAttempts===1)await route.abort('internetdisconnected')
   else await route.continue()
  })
  await b.goto(url)
  await expect(b.getByText('Не удалось открыть «problems.pdf»')).toBeVisible({timeout:30000})
  await b.evaluate(()=>window.dispatchEvent(new Event('online')))
  await expect(b.locator('.media-header').getByText('problems.pdf')).toBeVisible({timeout:30000})
  await expect(b.locator('.pdf-toolbar').getByText('2 / 2')).toBeVisible({timeout:30000})
  expect(firstOpenAttempts).toBeGreaterThanOrEqual(2)
  await b.unroute('**/storage/v1/object/sign/**')
  let signAttempts=0
  await b.route('**/storage/v1/object/sign/**',async route=>{
   signAttempts++
   if(signAttempts===1)await route.abort('internetdisconnected')
   else await route.continue()
  })
  await b.clock.setSystemTime(new Date(Date.now()+46*60_000))
  await b.evaluate(()=>window.dispatchEvent(new Event('online')))
  await expect.poll(()=>signAttempts).toBe(1)
  await b.evaluate(()=>window.dispatchEvent(new Event('online')))
  await expect.poll(()=>signAttempts).toBe(2)
  await expect(b.locator('.pdf-toolbar').getByText('2 / 2')).toBeVisible({timeout:30000})
  await b.unroute('**/storage/v1/object/sign/**')
  await b.getByTitle('Предыдущая страница').click()
  await expect(a.locator('.pdf-toolbar').getByText('1 / 2')).toBeVisible({timeout:20000})
  const shapes=await a.locator('[data-shape-id]:visible').count()
  await b.getByTitle('Вырезать фрагмент').click()
  const bounds=await b.locator('.pdf-page canvas').boundingBox()
  expect(bounds).not.toBeNull()
  await b.mouse.move(bounds!.x+15,bounds!.y+15);await b.mouse.down();await b.mouse.move(bounds!.x+130,bounds!.y+100);await b.mouse.up()
  await b.getByRole('button',{name:'На доску',exact:true}).click()
  await expect.poll(()=>a.locator('[data-shape-id]:visible').count(),{timeout:20000}).toBeGreaterThan(shapes)
  await b.getByTitle('Закрыть для всех').click()
  await expect(a.locator('.media-header').getByText('problems.pdf')).toHaveCount(0,{timeout:20000})
  await expect.poll(()=>a.evaluate(url=>(window as unknown as {revokedUrls:string[]}).revokedUrls.includes(url!),localPdfUrl),{timeout:20000}).toBe(true)
  await b.locator('input[type=file]').setInputFiles({name:'second.pdf',mimeType:'application/pdf',buffer:pdf})
  await expect(a.locator('.media-header').getByText('second.pdf')).toBeVisible({timeout:30000})
  await expect(a.locator('.pdf-toolbar').getByText('1 / 2')).toBeVisible({timeout:30000})
  await b.getByTitle('Следующая страница').click()
  await expect(a.locator('.pdf-toolbar').getByText('2 / 2')).toBeVisible({timeout:20000})
  expect(errors).toEqual([])
 }finally{
  const session=await a.evaluate(()=>{const key=Object.keys(localStorage).find(value=>value.startsWith('sb-')&&value.endsWith('-auth-token'));return key?JSON.parse(localStorage.getItem(key)||'null'):null}).catch(()=>null)
  if(session?.access_token&&session?.refresh_token){
   const {createClient}=await import('@supabase/supabase-js')
   const client=createClient('https://kiqgwzigmubtcyuxojyh.supabase.co','sb_publishable_e_qw5ej96HXJzjg8guDT8Q_xBeDKPJx',{auth:{persistSession:false,autoRefreshToken:false}})
   await client.auth.setSession({access_token:session.access_token,refresh_token:session.refresh_token})
   const {data:rooms}=await client.from('board_rooms').select('id').eq('owner_id',session.user.id)
   for(const room of rooms||[]){const {data:files}=await client.storage.from('board-materials').list(room.id);if(files?.length)await client.storage.from('board-materials').remove(files.map(file=>`${room.id}/${file.name}`))}
  }
  await first.close();await second.close()
 }
})
