import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'
import type { TLStoreSnapshot } from 'tldraw'
import { isSharedMaterial } from '../../cloud/material-data'
import { seedCloudDocument, validateCloudDocument } from '../../cloud/store-binding'
import { encodeUpdate, maxUpdateParts, maxUpdateSize, updatePartSize, uuidPattern } from '../../cloud/wire'

type Checkpoint = { revision: number; payload: string }
type RequestBody = { room: string; payload?: string; upload?: string; parts?: number; initialize?: boolean }

function validateDocument(doc: Y.Doc, room: string, allowEmpty = false) {
 if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Incomplete Yjs update')
 const records = validateCloudDocument(doc, allowEmpty)
 for (const [id, material] of doc.getMap('materials')) {
  if (!isSharedMaterial(material, room) || id !== material.id) throw new Error('Invalid material')
 }
 return records
}

function applyUpdate(doc: Y.Doc, payload: string) {
 const bytes = Buffer.from(payload, 'base64')
 if (bytes.toString('base64') !== payload) throw new Error('Invalid encoding')
 const { structs } = Y.decodeUpdate(bytes)
 for (const struct of structs) {
  if (struct instanceof Y.Item && (
   !(struct.content instanceof Y.ContentAny || struct.content instanceof Y.ContentDeleted) ||
   typeof struct.parent === 'string' && !['tl_records', 'tl_base', 'tl_fields', 'materials'].includes(struct.parent)
  )) throw new Error('Invalid board update')
 }
 Y.applyUpdate(doc, bytes)
}

async function recoverLegacy(db: SupabaseClient, room: string): Promise<Y.Doc> {
 const recovered = new Y.Doc()
 try {
  let cursor = 0
  while (true) {
   const { data, error } = await db.from('board_updates').select('sequence,payload')
    .eq('room_id', room).gt('sequence', cursor).order('sequence').limit(32)
   if (error) throw error
   if (!data.length) break

   const goodState = Y.encodeStateAsUpdate(recovered)
   const trial = new Y.Doc()
   try {
    Y.applyUpdate(trial, goodState)
    for (const row of data) applyUpdate(trial, row.payload)
    validateDocument(trial, room)
    Y.applyUpdate(recovered, Y.encodeStateAsUpdate(trial))
   } catch {
    // A legacy entry may be corrupt. Keep independently valid edits and
    // exclude entries with missing dependencies from the published checkpoint.
    for (const row of data) {
     const candidate = new Y.Doc()
     try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(recovered))
      applyUpdate(candidate, row.payload)
      validateDocument(candidate, room)
      Y.applyUpdate(recovered, Y.encodeStateAsUpdate(candidate))
     } catch {
      console.warn('Skipped invalid legacy board update', room, row.sequence)
     } finally {
      candidate.destroy()
     }
    }
   } finally {
    trial.destroy()
   }
   cursor = Number(data[data.length - 1].sequence)
  }

  if (!Object.keys(validateDocument(recovered, room, true)).length) {
   const { data, error } = await db.from('board_documents').select('snapshot').eq('room_id', room).single()
   if (error) throw error
   seedCloudDocument(recovered, data.snapshot as TLStoreSnapshot)
  }
  validateDocument(recovered, room)
  return recovered
 } catch (error) {
  recovered.destroy()
  throw error
 }
}

async function commit(db: SupabaseClient, room: string, payload?: string, initialize = false) {
 for (let attempt = 0; attempt < 4; attempt++) {
  const { data, error } = await db.from('board_checkpoints').select('revision,payload').eq('room_id', room).maybeSingle<Checkpoint>()
  if (error) throw error
  if (data && (!payload || initialize)) return { revision: data.revision }
  const doc = data || initialize ? new Y.Doc() : await recoverLegacy(db, room)
  try {
   if (data) Y.applyUpdate(doc, Buffer.from(data.payload, 'base64'))
   const before = Y.snapshot(doc)
   if (payload) {
    try {
     applyUpdate(doc, payload)
     validateDocument(doc, room)
    } catch {
     return { status: 422 }
    }
   }
   if (data && Y.equalSnapshots(before, Y.snapshot(doc))) return { revision: data.revision }
   const checkpoint = encodeUpdate(Y.encodeStateAsUpdate(doc))
   if (checkpoint.length > maxUpdateSize) return { status: 413 }
   const revision = (data?.revision ?? 0) + 1
   if (data) {
    const write = await db.from('board_checkpoints').update({ revision, payload: checkpoint })
     .eq('room_id', room).eq('revision', data.revision).select('revision').maybeSingle()
    if (write.error) throw write.error
    if (write.data) return { revision }
   } else {
    const write = await db.from('board_checkpoints').insert({ room_id: room, revision, payload: checkpoint })
    if (!write.error) return { revision }
    if (write.error.code !== '23505') throw write.error
   }
  } finally {
   doc.destroy()
  }
 }
 return { status: 409 }
}

export async function POST(request: Request) {
 const url = process.env.NEXT_PUBLIC_SUPABASE_URL
 const secret = process.env.SUPABASE_SECRET_KEY
 if (!url || !secret) return new Response(null, { status: 503 })
 const token = request.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1]
 if (!token) return new Response(null, { status: 401 })
 if (Number(request.headers.get('content-length')) > updatePartSize + 1024) return new Response(null, { status: 413 })
 let body: RequestBody
 try {
  body = await request.json()
 } catch {
  return new Response(null, { status: 400 })
 }
 if (!body || typeof body.room !== 'string' || !uuidPattern.test(body.room) ||
  body.payload !== undefined && (typeof body.payload !== 'string' || body.payload.length > updatePartSize) ||
  body.upload !== undefined && (typeof body.upload !== 'string' || !uuidPattern.test(body.upload) || !Number.isInteger(body.parts) || body.parts < 1 || body.parts > maxUpdateParts || body.payload !== undefined) ||
  body.initialize !== undefined && typeof body.initialize !== 'boolean' ||
  body.initialize && body.payload === undefined && !body.upload) return new Response(null, { status: 400 })

 const db = createClient(url, secret, { auth: { autoRefreshToken: false, persistSession: false } })
 try {
  const { data: { user }, error: authError } = await db.auth.getUser(token)
  if (authError || !user) return new Response(null, { status: 401 })
  const { data: membership, error: memberError } = await db.from('board_members').select('room_id')
   .eq('room_id', body.room).eq('user_id', user.id).maybeSingle()
  if (memberError) throw memberError
  if (!membership) return new Response(null, { status: 403 })
  if (body.initialize) {
   const owner = await db.from('board_rooms').select('id').eq('id', body.room).eq('owner_id', user.id).maybeSingle()
   if (owner.error) throw owner.error
   if (!owner.data) return new Response(null, { status: 403 })
   const legacy = await db.from('board_updates').select('sequence').eq('room_id', body.room).limit(1)
   if (legacy.error) throw legacy.error
   if (legacy.data.length) return new Response(null, { status: 409 })
  }

  let payload = body.payload
  const parts = () => db.from('board_update_parts').select('part,payload')
   .eq('room_id', body.room).eq('user_id', user.id).eq('upload_id', body.upload)
  if (body.upload) {
   const { data, error } = await parts().order('part').limit(maxUpdateParts)
   if (error) throw error
   if (data.length !== body.parts || data.some((row, i) => row.part !== i)) return new Response(null, { status: 409 })
   payload = data.map(row => row.payload).join('')
  }

  const result = await commit(db, body.room, payload, body.initialize)
  if ('status' in result) return new Response(null, { status: result.status })
  if (body.upload) {
   const cleanup = await db.from('board_update_parts').delete().eq('room_id', body.room)
    .eq('user_id', user.id).or('upload_id.eq.' + body.upload + ',created_at.lt.' + new Date(Date.now() - 86400000).toISOString())
   if (cleanup.error) console.warn('Could not remove published board update parts', cleanup.error.code)
  }
  return Response.json(result)
 } catch (error) {
  console.error('Board sync request failed', error)
  return new Response(null, { status: 503 })
 }
}
