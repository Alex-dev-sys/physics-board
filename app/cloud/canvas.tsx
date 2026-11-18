'use client'
import { useEffect, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'
import { Tldraw, createTLStore, defaultShapeUtils, defaultBindingUtils, getUserPreferences, getDefaultUserPresence, InstancePresenceRecordType, react, type Editor, type TLAssetStore, type TLComponents, type TLInstancePresence, type TLStore, type TLStoreSnapshot } from 'tldraw'
import { getCloudClient } from './client'
import { CloudRoomNotFound, resolveCloudRoom, getRoomMaterialUrl, uploadRoomMaterial } from './rooms'
import { CloudUpdateLog, type CloudSyncStatus } from './update-log'
import { bindCloudStore, validateCloudDocument } from './store-binding'
import { CloudMaterials, type SharedMaterial } from './materials'
import { uuidPattern } from './wire'

function cachedRoom(key: string): string | null {
 try {
  const value = localStorage.getItem(key)
  return uuidPattern.test(value ?? '') ? value : null
 } catch {
  return null
 }
}

export function CloudCanvas({token,onMount,components,onStatus,onReady,onMaterials}:{token:string;onMount:(editor:Editor)=>void;components?:TLComponents;onStatus:(status:CloudSyncStatus|'loading'|'failed')=>void;onReady:(materials:CloudMaterials)=>void;onMaterials?:(items:SharedMaterial[],materials:CloudMaterials)=>void}){
 const [store,setStore]=useState<TLStore|null>(null),[error,setError]=useState('')
 useEffect(()=>{
  let disposed = false
  let doc: Y.Doc | undefined, idb: IndexeddbPersistence | undefined, log: CloudUpdateLog | undefined
  let unbind: (() => void) | undefined, stopPresence: (() => void) | undefined, stopMaterials: (() => void) | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const key = 'physics-board-room-' + token

  const open = async () => {
   try{
    const client = getCloudClient()
    const savedRoom = cachedRoom(key)
    const room = savedRoom ?? await resolveCloudRoom(token, client)
    if (disposed) return
    doc = new Y.Doc()
    idb = new IndexeddbPersistence('physics-board-cloud-' + room, doc)
    await idb.whenSynced
    if (disposed) return
    let hasLocalBoard = false
    try {
     if (doc.store.pendingStructs || doc.store.pendingDs) throw new Error('Некорректная локальная копия')
     hasLocalBoard = Object.keys(validateCloudDocument(doc, true)).length > 0
    } catch {
     await idb.clearData()
     doc.destroy()
     if (disposed) return
     doc = new Y.Doc()
     idb = new IndexeddbPersistence('physics-board-cloud-' + room, doc)
     await idb.whenSynced
     if (disposed) return
    }
    const document = doc
    const assets: TLAssetStore = {
     async upload(_asset, file) {
      const path = await uploadRoomMaterial(room, file, client)
      return { src: 'asset:cloud/' + path }
     },
     async resolve(asset) {
      const src = asset.props.src
      return src?.startsWith('asset:cloud/') ? getRoomMaterialUrl(room, src.slice(12), client).catch(() => null) : src
     },
    }
    const boardStore = createTLStore({ shapeUtils: defaultShapeUtils, bindingUtils: defaultBindingUtils, assets })
    let previousPeers = new Set<TLInstancePresence['id']>()
    let verified = !savedRoom
    const active = new CloudUpdateLog(client, room, document, async () => {
     if (!verified) {
      if (await resolveCloudRoom(token, client) !== room) throw new Error('Комната изменилась')
     }
     verified = false
    }, status => {
     if (!disposed) onStatus(status)
    }, (update, origin) => {
     if (disposed) return
     if (unbind) boardStore._flushHistory()
     Y.applyUpdate(document, update, origin)
     try { localStorage.setItem(key, room) } catch { /* Storage may be unavailable. */ }
     mountStore()
    }, peers => {
     if (disposed || !unbind) return
     const next = new Set(peers.map(peer => peer.id))
     const removed = [...previousPeers].filter(id => !next.has(id))
     previousPeers = next
     boardStore.mergeRemoteChanges(() => {
      if (removed.length) boardStore.remove(removed)
      if (peers.length) boardStore.put(peers)
     })
    })
    log = active

    function mountStore() {
     if (unbind) return
     unbind = bindCloudStore(document, boardStore)
     const presenceId = InstancePresenceRecordType.createId(crypto.randomUUID())
     stopPresence = react('sync cloud presence', () => {
      const info = getDefaultUserPresence(boardStore, getUserPreferences())
      if (info) active.setPresence(InstancePresenceRecordType.create({ ...info, id: presenceId }))
     })
     const materials = new CloudMaterials(document, room, client, active)
     stopMaterials = materials.watch(items => { if (!disposed) onMaterials?.(items, materials) })
     setStore(boardStore)
     onReady(materials)
    }

    onStatus('connecting')
    active.start()
    if (hasLocalBoard) mountStore()
   } catch (cause) {
    if (disposed) return
    if (!doc && !(cause instanceof CloudRoomNotFound)) {
     onStatus('offline')
     retry = setTimeout(open, 3000)
    } else {
     setError(cause instanceof Error ? cause.message : 'Не удалось открыть комнату')
     onStatus('failed')
    }
   }
  }

  onStatus('loading')
  void open()
  return () => {
   disposed = true
   if (retry) clearTimeout(retry)
   unbind?.()
   stopPresence?.()
   stopMaterials?.()
   void (async () => {
    await log?.stop()
    await idb?.destroy()
    doc?.destroy()
   })()
  }
 // The room token uniquely identifies this mounted connection.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[token])
 if(error)return <div className="sync-status" role="alert">{error}</div>
 if(!store)return <div className="sync-status" role="status">Подключение к облачной комнате…</div>
 return <Tldraw licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY} hideUi store={store} components={components} onMount={onMount}/>
}

/** Copy all image assets to the private bucket before publishing an invitation. */
export async function prepareCloudSnapshot(editor:Editor,roomId:string,snapshot:TLStoreSnapshot):Promise<TLStoreSnapshot>{
 const copy=structuredClone(snapshot)
 for(const record of Object.values(copy.store)){
  if(record.typeName!=='asset'||record.type!=='image')continue
  const url=await editor.resolveAssetUrl(record.id,{shouldResolveToOriginal:true})
  if(!url)throw new Error('Не удалось найти изображение на доске')
  const response=await fetch(url)
  if(!response.ok)throw new Error('Не удалось прочитать изображение на доске')
  const blob=await response.blob()
  const path=await uploadRoomMaterial(roomId,blob)
  record.props.src=`asset:cloud/${path}`
 }
 return copy
}
