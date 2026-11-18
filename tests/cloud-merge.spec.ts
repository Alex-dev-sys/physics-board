import { expect, test } from '@playwright/test'
import { createTLSchema, createTLStore, createShapeId, GeoShapeUtil, DocumentRecordType, PageRecordType, TLDOCUMENT_ID, type IndexKey, type TLGeoShape } from 'tldraw'
import * as Y from 'yjs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { POST } from '../app/api/board-sync/route'
import { publishCloudUpdate } from '../app/cloud/publish'
import { bindCloudStore, moveLegacyPdfsToBoard, seedCloudDocument, validateCloudDocument } from '../app/cloud/store-binding'
import { createBoardSchema } from '../app/pdf-schema.mjs'
import { encodeUpdate, unsavedUpdate, updatePartSize } from '../app/cloud/wire'

globalThis.requestAnimationFrame ??= callback =>
 setTimeout(() => callback(performance.now()), 16) as unknown as number
globalThis.cancelAnimationFrame ??= handle => clearTimeout(handle)

test('different edits to a legacy figure merge without republishing old deletions', () => {
 const first = new Y.Doc()
 const second = new Y.Doc()
 const firstStore = createTLStore()
 const secondStore = createTLStore()
 const document = DocumentRecordType.create({ id: TLDOCUMENT_ID })
 const page = PageRecordType.create({ id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' as IndexKey })
 const shape = firstStore.schema.types.shape.create({
  id: createShapeId('example'), type: 'geo', parentId: page.id, index: 'a1' as IndexKey,
  props: new GeoShapeUtil(null).getDefaultProps(),
 }) as TLGeoShape
 first.getArray('tl_records').push([document, page, shape].map(val => ({ key: val.id, val })))
 Y.applyUpdate(second, Y.encodeStateAsUpdate(first))
 const unbindFirst = bindCloudStore(first, firstStore)
 const unbindSecond = bindCloudStore(second, secondStore)
 try {
  firstStore.put([{ ...shape, x: 300 }])
  secondStore.put([{ ...shape, props: { ...shape.props, color: 'blue' } }])
  firstStore._flushHistory()
  secondStore._flushHistory()

  const firstUpdate = unsavedUpdate(first, second)!
  const secondUpdate = unsavedUpdate(second, first)!
  Y.applyUpdate(first, secondUpdate)
  Y.applyUpdate(second, firstUpdate)
  for (const doc of [first, second]) {
   expect(validateCloudDocument(doc)[shape.id]).toMatchObject({ x: 300, props: { color: 'blue' } })
  }
  expect(firstStore.get(shape.id)).toMatchObject({ x: 300, props: { color: 'blue' } })
  expect(secondStore.get(shape.id)).toMatchObject({ x: 300, props: { color: 'blue' } })
  expect(unsavedUpdate(first, second)).toBeNull()

  firstStore.remove([shape.id])
  firstStore._flushHistory()
  Y.applyUpdate(second, unsavedUpdate(first, second)!)
  expect(secondStore.get(shape.id)).toBeUndefined()
  expect(unsavedUpdate(first, second)).toBeNull()
 } finally {
  unbindFirst()
  unbindSecond()
  first.destroy()
  second.destroy()
  firstStore.dispose()
  secondStore.dispose()
 }
})

test('a new seed materializes a complete board before a client opens it', () => {
 const store = createTLStore()
 const doc = new Y.Doc()
 try {
  const document = DocumentRecordType.create({ id: TLDOCUMENT_ID })
  const page = PageRecordType.create({ id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' as IndexKey })
  store.put([document, page])
  seedCloudDocument(doc, store.getStoreSnapshot())
  expect(validateCloudDocument(doc)).toMatchObject({ [document.id]: document, [page.id]: page })
 } finally {
  doc.destroy()
  store.dispose()
 }
})

test('an existing cloud PDF becomes one board object and retains its file and page', () => {
 const room = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
 const id = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
 const path = `${room}/${id}.pdf`
 const doc = new Y.Doc()
 const store = createTLStore({ schema: createBoardSchema() })
 try {
  const document = DocumentRecordType.create({ id: TLDOCUMENT_ID })
  const page = PageRecordType.create({ id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' as IndexKey })
  store.put([document, page])
  seedCloudDocument(doc, store.getStoreSnapshot())
  const unbind = bindCloudStore(doc, store)
  try {
   doc.getMap('materials').set(id, { id, name: 'old.pdf', type: 'application/pdf', path, page: 3 })
   moveLegacyPdfsToBoard(doc, room)
   moveLegacyPdfsToBoard(doc, room)
   expect(doc.getMap('materials').has(id)).toBe(false)
   const shapes = store.allRecords().filter(record => record.typeName === 'shape')
   expect(shapes).toEqual([expect.objectContaining({ type: 'pdf', props: expect.objectContaining({ page: 3 }) })])
   const file = store.allRecords().find(record => record.typeName === 'asset')
   expect(file).toMatchObject({ props: { title: 'old.pdf', src: `asset:cloud/${path}` } })
  } finally { unbind() }
 } finally {
  doc.destroy()
  store.dispose()
 }
})

test('a board update larger than 8 MiB is validated and saved in parts', async () => {
 const fakeFetch = globalThis.fetch
 const fakeUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
 const fakeSecret = process.env.SUPABASE_SECRET_KEY
 const room = crypto.randomUUID()
 const user = crypto.randomUUID()
 const doc = new Y.Doc()
 const parts: { part: number; payload: string }[] = []
 let checkpoint: { revision: number; payload: string } | undefined
 let deleted = false
 process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.invalid'
 process.env.SUPABASE_SECRET_KEY = 'local-test-key'

 try {
  globalThis.fetch = async (input, options) => {
   const request = new Request(new URL(String(input), 'https://fixture.invalid'), options)
   const url = new URL(request.url)
   const route = url.pathname.split('/').pop()
   if (url.pathname === '/api/board-sync') return POST(request)
   if (route === 'user') return Response.json({ id: user })
   if (route === 'board_members') return Response.json([{ room_id: room }])
   if (route === 'board_rooms') return Response.json([{ id: room }])
   if (route === 'board_updates') return Response.json([])
   if (route === 'board_update_parts' && request.method === 'GET') return Response.json(parts)
   if (route === 'board_update_parts' && request.method === 'DELETE') {
    deleted = true
    return new Response(null, { status: 204 })
   }
   if (route === 'board_checkpoints' && request.method === 'GET') return Response.json([])
   if (route === 'board_checkpoints' && request.method === 'POST') {
    checkpoint = await request.json()
    return new Response(null, { status: 201 })
   }
   throw new Error('Unexpected fixture request ' + url.pathname)
  }
  const client = {
   auth: { getSession: async () => ({ data: { session: { access_token: 'local-test-session' } } }) },
   from: () => ({
    upsert: async (batch: typeof parts) => {
     parts.push(...batch.map(({ part, payload }) => ({ part, payload })))
     return { error: null }
    },
   }),
  } as unknown as SupabaseClient
  const document = DocumentRecordType.create({ id: TLDOCUMENT_ID, meta: { lessonNotes: 'a'.repeat(7 * 1024 * 1024) } })
  const page = PageRecordType.create({ id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' as IndexKey })
  seedCloudDocument(doc, { store: { [document.id]: document, [page.id]: page }, schema: createTLSchema().serialize() })
  const payload = encodeUpdate(Y.encodeStateAsUpdate(doc))
  expect(payload.length).toBeGreaterThan(8 * 1024 * 1024)
  await expect(publishCloudUpdate(client, room, payload, undefined, true)).resolves.toBe(1)
  expect(parts.length).toBeGreaterThan(1)
  expect(parts.every(part => part.payload.length <= updatePartSize)).toBe(true)
  expect(checkpoint?.payload.length).toBeGreaterThan(8 * 1024 * 1024)
  expect(deleted).toBe(true)
 } finally {
  globalThis.fetch = fakeFetch
  if (fakeUrl === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL
  else process.env.NEXT_PUBLIC_SUPABASE_URL = fakeUrl
  if (fakeSecret === undefined) delete process.env.SUPABASE_SECRET_KEY
  else process.env.SUPABASE_SECRET_KEY = fakeSecret
  doc.destroy()
 }
})
