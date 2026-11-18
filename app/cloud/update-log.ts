import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'
import { InstancePresenceRecordType, type TLInstancePresence } from 'tldraw'
import * as Y from 'yjs'
import { CloudSyncRequestError, publishCloudUpdate } from './publish'
import { decodeUpdate, encodeUpdate, unsavedUpdate, uuidPattern } from './wire'

export type CloudSyncStatus = 'connecting' | 'syncing' | 'saved' | 'offline' | 'error'
const remoteOrigin = Symbol('cloud-remote')

export class CloudUpdateLog {
 private readonly serverDoc = new Y.Doc()
 private readonly presenceKey = crypto.randomUUID()
 private readonly peers = new Map<string, TLInstancePresence>()
 private channel: RealtimeChannel | null = null
 private presence: TLInstancePresence | null = null
 private connected = false
 private tracked = false
 private revision = 0
 private localVersion = 0
 private confirmedVersion = -1
 private rejectedVersion: number | null = null
 private authorized = false
 private closed = false
 private running: Promise<void> | null = null
 private pollTimer: ReturnType<typeof setInterval> | null = null
 private timer: ReturnType<typeof setTimeout> | null = null
 private presenceTimer: ReturnType<typeof setTimeout> | null = null
 private upload: { payload: string; id: string } | null = null

 constructor(
  private readonly client: SupabaseClient,
  private readonly room: string,
  private readonly doc: Y.Doc,
  private readonly authorize: () => Promise<void>,
  private readonly onStatus: (status: CloudSyncStatus) => void,
  private readonly onCheckpoint: (update: Uint8Array, origin: symbol) => void,
  private readonly onPeers: (peers: TLInstancePresence[]) => void,
 ) {}

 private readonly onUpdate = (_bytes: Uint8Array, origin: unknown) => {
  if (this.closed || origin === remoteOrigin) return
  this.localVersion++
  this.onStatus('syncing')
  this.schedule()
 }

 private readonly refresh = () => {
  if (!this.closed) void this.run().catch(() => {})
 }

 start() {
  this.doc.on('update', this.onUpdate)
  window.addEventListener('online', this.refresh)
  this.pollTimer = setInterval(this.refresh, 5000)
  this.refresh()
 }

 async flush() {
  const target = this.localVersion
  await this.run()
  if (this.confirmedVersion < target) await this.run()
  if (this.confirmedVersion < target) throw new Error('Изменения ещё не сохранены в облаке')
 }

 private schedule() {
  if (this.timer || this.closed) return
  this.timer = setTimeout(() => {
   this.timer = null
   this.refresh()
  }, 200)
 }

 private run(): Promise<void> {
  if (this.closed) return Promise.reject(new Error('Комната закрыта'))
  return this.running ??= this.sync().finally(() => { this.running = null })
 }

 private async pull() {
  const { data, error } = await this.client.from('board_checkpoints').select('revision,payload')
   .eq('room_id', this.room).gt('revision', this.revision).maybeSingle()
  if (error) throw error
  if (this.closed || !data) return
  const bytes = decodeUpdate(data.payload)
  Y.applyUpdate(this.serverDoc, bytes, remoteOrigin)
  this.onCheckpoint(bytes, remoteOrigin)
  this.revision = Number(data.revision)
 }

 private async sync() {
  try {
   if (!this.authorized) {
    await this.authorize()
    if (this.closed) return
    this.authorized = true
   }
   if (!this.channel) this.connectPresence()
   await this.pull()
   if (this.closed) return
   if (!this.revision) {
    await publishCloudUpdate(this.client, this.room)
    await this.pull()
    if (this.closed) return
    if (!this.revision) throw new CloudSyncRequestError(403)
   }

   const version = this.localVersion
   if (this.rejectedVersion === version) {
    this.onStatus('error')
    return
   }
   const bytes = unsavedUpdate(this.doc, this.serverDoc)
   if (bytes) {
    this.onStatus('syncing')
    const payload = encodeUpdate(bytes)
    if (this.upload?.payload !== payload) this.upload = { payload, id: crypto.randomUUID() }
    let revision: number
    try {
     revision = await publishCloudUpdate(this.client, this.room, payload, this.upload.id)
    } catch (error) {
     if (error instanceof CloudSyncRequestError && [413, 422].includes(error.status)) {
      this.rejectedVersion = version
      this.upload = null
     }
     throw error
    }
    if (this.closed) return
    this.upload = null
    await this.pull()
    if (this.closed) return
    if (this.revision < revision) throw new Error('Не удалось подтвердить сохранение')
    if (this.connected) void this.channel?.send({ type: 'broadcast', event: 'board-update', payload: {} }).catch(() => {})
   }

   this.confirmedVersion = version
   if (this.localVersion === version) this.onStatus('saved')
   else this.schedule()
  } catch (error) {
   if (!this.closed) {
    const status = error instanceof CloudSyncRequestError && error.status
    if (status === 401 || status === 403) this.authorized = false
    this.onStatus(status === 403 || status === 413 || status === 422 ? 'error' : 'offline')
   }
   throw error
  }
 }

 private connectPresence() {
  const channel = this.client.channel('board:' + this.room, {
   config: { private: true, broadcast: { ack: true }, presence: { key: this.presenceKey } },
  })
  this.channel = channel
  channel.on('broadcast', { event: 'board-update' }, this.refresh)
   .on('broadcast', { event: 'cursor' }, ({ payload }) => {
    if (!payload || !this.acceptPresence(payload.key, payload.presence)) return
    this.emitPeers()
   })
   .on('presence', { event: 'sync' }, () => {
    this.emitPeers()
    this.schedulePresence()
   })
   .subscribe(status => {
    if (this.closed) return
    this.connected = status === 'SUBSCRIBED'
    this.tracked = false
    if (this.connected) {
     this.refresh()
     this.schedulePresence()
    } else {
     this.peers.clear()
     this.onPeers([])
    }
   })
 }

 private parsePresence(key: unknown, value: unknown) {
  if (typeof key !== 'string' || key === this.presenceKey || !uuidPattern.test(key)) return null
  try {
   const validated = InstancePresenceRecordType.validate(value)
   return { ...validated, id: InstancePresenceRecordType.createId(key) }
  } catch {
   return null
  }
 }

 private acceptPresence(key: string, value: unknown): boolean {
  if (!Object.hasOwn(this.channel?.presenceState() ?? {}, key)) return false
  const peer = this.parsePresence(key, value)
  if (!peer) return false
  this.peers.set(key, peer)
  return true
 }

 private emitPeers() {
  const state = this.channel?.presenceState<{ presence: unknown }>() ?? {}
  for (const key of this.peers.keys()) if (!Object.hasOwn(state, key)) this.peers.delete(key)
  for (const [key, entries] of Object.entries(state)) {
   if (!this.peers.has(key)) {
    const peer = this.parsePresence(key, entries[0]?.presence)
    if (peer) this.peers.set(key, peer)
   }
  }
  this.onPeers([...this.peers.values()])
 }

 setPresence(presence: TLInstancePresence) {
  this.presence = presence
  this.schedulePresence()
 }

 private schedulePresence() {
  if (this.closed || this.presenceTimer || !this.connected || !this.presence) return
  this.presenceTimer = setTimeout(() => {
   this.presenceTimer = null
   if (!this.channel || !this.connected || !this.presence || this.closed) return
   if (!this.tracked) {
    this.tracked = true
    void this.channel.track({ presence: this.presence }).then(result => {
     if (result !== 'ok') this.tracked = false
    }).catch(() => { this.tracked = false })
   }
   void this.channel.send({
    type: 'broadcast', event: 'cursor', payload: { key: this.presenceKey, presence: this.presence },
   }).catch(() => {})
  }, 100)
 }

 async stop() {
  this.closed = true
  this.doc.off('update', this.onUpdate)
  window.removeEventListener('online', this.refresh)
  if (this.timer) clearTimeout(this.timer)
  if (this.pollTimer) clearInterval(this.pollTimer)
  if (this.presenceTimer) clearTimeout(this.presenceTimer)
  if (this.channel) void this.client.removeChannel(this.channel).catch(() => {})
  await this.running?.catch(() => {})
  this.serverDoc.destroy()
 }
}
