import type { SupabaseClient } from '@supabase/supabase-js'
import { maxUpdateSize, updatePartSize } from './wire'

export class CloudSyncRequestError extends Error {
 constructor(readonly status: number) {
  super(status === 413 ? 'Изменения превышают размер облачной доски' :
   status === 422 ? 'Облако не приняло изменения доски' : 'Не удалось сохранить доску в облаке')
 }
}

export async function publishCloudUpdate(
 client: SupabaseClient, room: string, payload?: string, upload = crypto.randomUUID(), initialize = false,
 endpoint = '/api/board-sync',
): Promise<number> {
 if (payload && payload.length > maxUpdateSize) throw new CloudSyncRequestError(413)
 const { data, error } = await client.auth.getSession()
 if (error || !data.session) throw new CloudSyncRequestError(401)
 let body: Record<string, unknown> = { room, payload, initialize }
 if (payload && payload.length > updatePartSize) {
  const parts = Math.ceil(payload.length / updatePartSize)
  for (let first = 0; first < parts; first += 4) {
   const batch = Array.from({ length: Math.min(4, parts - first) }, (_, index) => {
    const part = first + index
    return { room_id: room, upload_id: upload, part, payload: payload.slice(part * updatePartSize, (part + 1) * updatePartSize) }
   })
   const { error: stagingError } = await client.from('board_update_parts').upsert(batch, {
    onConflict: 'room_id,user_id,upload_id,part', ignoreDuplicates: true,
   })
   if (stagingError) throw stagingError
  }
  body = { room, upload, parts, initialize }
 }

 const response = await fetch(endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + data.session.access_token },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(45_000),
 })
 if (!response.ok) {
  if ((response.status === 413 || response.status === 422) && body.upload) {
   await client.from('board_update_parts').delete().eq('room_id', room).eq('upload_id', upload)
  }
  throw new CloudSyncRequestError(response.status)
 }
 const result = await response.json()
 if (!Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error('Invalid board revision')
 return result.revision
}
