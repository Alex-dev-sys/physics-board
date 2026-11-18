import type { SupabaseClient } from '@supabase/supabase-js'
import type { TLStoreSnapshot } from 'tldraw'
import * as Y from 'yjs'
import { ensureAnonymousSession, getCloudClient } from './client'
import { publishCloudUpdate } from './publish'
import { seedCloudDocument } from './store-binding'
import { encodeUpdate, uuidPattern } from './wire'

const bucket = 'board-materials'
const tokenPattern = /^[a-f0-9]{64}$/
export type CloudRoom = { id: string; revision: number; snapshot: TLStoreSnapshot }
export class CloudRoomNotFound extends Error {}

function newToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), n => n.toString(16).padStart(2, '0')).join('')
}
function validateRoomId(id:string) {
  if (!uuidPattern.test(id)) throw new Error('Некорректный идентификатор комнаты')
}
function validateToken(token:string) {
  if (!tokenPattern.test(token)) throw new Error('Некорректная ссылка на комнату')
}

export async function createCloudRoom(snapshot: TLStoreSnapshot, client: SupabaseClient = getCloudClient()): Promise<{id:string;token:string}> {
  await ensureAnonymousSession(client)
  const token = newToken()
  const { data, error } = await client.rpc('create_board_room', { p_token: token, p_snapshot: snapshot })
  if (error || typeof data !== 'string') throw new Error('Не удалось создать облачную комнату')
  return { id: data, token }
}

export async function initializeCloudRoom(room: string, snapshot: TLStoreSnapshot, client = getCloudClient()) {
 const doc = new Y.Doc()
 try {
  seedCloudDocument(doc, snapshot)
  await publishCloudUpdate(client, room, encodeUpdate(Y.encodeStateAsUpdate(doc)), undefined, true)
 } finally {
  doc.destroy()
 }
}

export async function resolveCloudRoom(token: string, client = getCloudClient()): Promise<string> {
  validateToken(token)
  await ensureAnonymousSession(client)
  const { data: id, error: joinError } = await client.rpc('join_board_room', { p_token: token })
  if (joinError?.code === 'P0002') throw new CloudRoomNotFound('Комната не найдена или ссылка недействительна')
  if (joinError || typeof id !== 'string') throw new Error('Не удалось подключиться к комнате')
  return id
}

export async function joinCloudRoom(token: string, client: SupabaseClient = getCloudClient()): Promise<CloudRoom> {
  const id = await resolveCloudRoom(token, client)
  const { data, error } = await client.from('board_documents').select('room_id, snapshot, revision').eq('room_id',id).single()
  if (error || !data) throw new Error('Не удалось загрузить доску')
  return { id, revision: Number(data.revision), snapshot: data.snapshot as TLStoreSnapshot }
}

export async function uploadRoomMaterial(roomId:string, file:Blob, client:SupabaseClient=getCloudClient()):Promise<string> {
  validateRoomId(roomId)
  if (file.size > 50*1024*1024) throw new Error('Максимальный размер файла — 50 МБ')
  const extensions:Record<string,string> = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','application/pdf':'pdf'}
  const extension=extensions[file.type]
  if (!extension) throw new Error('Этот формат файла не поддерживается')
  const path=`${roomId}/${crypto.randomUUID()}.${extension}`
  const { error }=await client.storage.from(bucket).upload(path,file,{contentType:file.type,upsert:false})
  if(error)throw new Error('Не удалось загрузить файл')
  return path
}

export async function getRoomMaterialUrl(roomId:string, path:string, client:SupabaseClient=getCloudClient()):Promise<string> {
  validateRoomId(roomId)
  if(!path.startsWith(`${roomId}/`) || path.slice(roomId.length+1).includes('/'))throw new Error('Некорректный путь к файлу')
  const {data,error}=await client.storage.from(bucket).createSignedUrl(path,3600)
  if(error||!data?.signedUrl)throw new Error('Не удалось открыть файл')
  return data.signedUrl
}

