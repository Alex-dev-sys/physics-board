import { test, expect } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { writeFileSync } from 'node:fs'
import { createCloudRoom, joinCloudRoom, uploadRoomMaterial, getRoomMaterialUrl } from '../app/cloud/rooms'
import { createTLSchema, DocumentRecordType, PageRecordType, TLDOCUMENT_ID, type IndexKey } from 'tldraw'
import * as Y from 'yjs'
import { publishCloudUpdate } from '../app/cloud/publish'
import { seedCloudDocument } from '../app/cloud/store-binding'
import { decodeUpdate, encodeUpdate } from '../app/cloud/wire'

test.skip(!process.env.RUN_CLOUD_INTEGRATION, 'Requires explicit cloud integration run')
test.setTimeout(60000)

function subscribe(client:SupabaseClient, topic:string, onMessage?:(value:string)=>void) {
 const channel=client.channel(topic,{config:{private:true,broadcast:{ack:true}}})
 if(onMessage)channel.on('broadcast',{event:'probe'},({payload})=>onMessage(payload.value))
 const result=new Promise<string>(resolve=>{
  const timeout=setTimeout(()=>resolve('TIMEOUT'),12000)
  channel.subscribe((status,error)=>{if(error)console.log('realtime error',error.message);if(status==='SUBSCRIBED'||status==='CHANNEL_ERROR'||status==='TIMED_OUT'){clearTimeout(timeout);resolve(status)}})
 })
 return {channel,result}
}

test('anonymous room members have isolated checkpoints, storage, and private realtime',async({baseURL})=>{
 const url=process.env.CLOUD_TEST_URL!, key=process.env.CLOUD_TEST_KEY!
 const clients=['a','b','c'].map(()=>createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}))
 const userIds:string[]=[]
 for(const client of clients){
  const {data,error}=await client.auth.signInAnonymously()
  expect(error).toBeNull();expect(data.user?.id).toBeTruthy()
  userIds.push(data.user!.id)
  writeFileSync('.cloud-test-users.json',JSON.stringify(userIds))
 }
 const [owner,member,outsider]=clients
 const document=DocumentRecordType.create({id:TLDOCUMENT_ID})
 const page=PageRecordType.create({id:PageRecordType.createId('page'),name:'Page 1',index:'a1' as IndexKey})
 const snapshot={store:{[document.id]:document,[page.id]:page},schema:createTLSchema().serialize()}
 let path:string|undefined
 try {
  console.log('cloud: create room')
  const room=await createCloudRoom(snapshot,owner)
  console.log('cloud: outsider read')
  const before=await outsider.from('board_documents').select('room_id').eq('room_id',room.id)
  expect(before.error).toBeNull();expect(before.data).toEqual([])
  console.log('cloud: invalid invite')
  await expect(joinCloudRoom('b'.repeat(64),outsider)).rejects.toThrow()
  console.log('cloud: join')
  const joined=await joinCloudRoom(room.token,member)
  expect(joined.id).toBe(room.id);expect(joined.revision).toBe(0)
  console.log('cloud: upload material')
  path=await uploadRoomMaterial(room.id,new Blob(['test'],{type:'application/pdf'}),owner)
  console.log('cloud: signed URL')
  const signed=await getRoomMaterialUrl(room.id,path,member)
  expect((await fetch(signed)).status).toBe(200)
  const range=await fetch(signed,{headers:{Range:'bytes=0-1'}})
  expect(range.status).toBe(206);expect(await range.text()).toBe('te')
  await expect(getRoomMaterialUrl(room.id,path,outsider)).rejects.toThrow()
  console.log('cloud: concurrent durable updates')
  const docA=new Y.Doc(),docB=new Y.Doc(),restored=new Y.Doc()
  const endpoint=new URL('/api/board-sync',baseURL).href
  const publish=(client:SupabaseClient,doc:Y.Doc,initialize=false)=>
   publishCloudUpdate(client,room.id,encodeUpdate(Y.encodeStateAsUpdate(doc)),undefined,initialize,endpoint)
  try {
   seedCloudDocument(docA,snapshot)
   expect(await publish(owner,docA,true)).toBe(1)
   Y.applyUpdate(docB,Y.encodeStateAsUpdate(docA))
   docA.getMap('tl_fields').set('document:document\u001fname',['Class'])
   docB.getMap('tl_fields').set('document:document\u001fgridSize',[20])
   await Promise.all([publish(owner,docA),publish(member,docB)])
   const read=await member.from('board_checkpoints').select('revision,payload').eq('room_id',room.id).single()
   expect(read.error).toBeNull();expect(read.data.revision).toBe(3)
   Y.applyUpdate(restored,decodeUpdate(read.data.payload))
   expect(restored.getMap('tl_fields').get('document:document\u001fname')).toEqual(['Class'])
   expect(restored.getMap('tl_fields').get('document:document\u001fgridSize')).toEqual([20])
   const hidden=await outsider.from('board_checkpoints').select('revision').eq('room_id',room.id)
   expect(hidden.error).toBeNull();expect(hidden.data).toEqual([])
  } finally {docA.destroy();docB.destroy();restored.destroy()}
  let resolveMessage:(value:string)=>void=()=>{}
  const received=new Promise<string>(resolve=>{resolveMessage=resolve})
  await Promise.all(clients.map(client=>client.realtime.setAuth()))
  console.log('cloud: realtime')
  const a=subscribe(owner,`board:${room.id}`), b=subscribe(member,`board:${room.id}`,resolveMessage), c=subscribe(outsider,`board:${room.id}`)
  try {
   expect(await a.result).toBe('SUBSCRIBED');expect(await b.result).toBe('SUBSCRIBED');expect(await c.result).not.toBe('SUBSCRIBED')
   expect(await a.channel.send({type:'broadcast',event:'probe',payload:{value:'ok'}})).toBe('ok')
   expect(await Promise.race([received,new Promise(resolve=>setTimeout(()=>resolve('timeout'),8000))])).toBe('ok')
  } finally {await Promise.all(clients.map(client=>client.removeAllChannels()))}
 } finally {
  console.log('cloud: cleanup')
  if(path){const {error}=await owner.storage.from('board-materials').remove([path]);expect(error).toBeNull()}
  await Promise.all(clients.map(client=>client.auth.signOut()))
 }
})



