'use client'
import { useMemo } from 'react'
import { useSync } from '@tldraw/sync'
import { FileHelpers, Tldraw, type Editor, type TLAssetStore, type TLComponents } from 'tldraw'
import { isPdfAsset, removeUnusedPdfAssets } from './pdf-assets'
import { createBoardSchema } from './pdf-schema.mjs'
import { pdfShapeUtils } from './pdf-shape'

// A room URL is a bearer capability. The local server only listens on loopback.
const localSyncOrigin = 'http://127.0.0.1:5858'
const schema = createBoardSchema()
export function SyncCanvas({token,onMount,components}:{token:string;onMount:(editor:Editor)=>void;components?:TLComponents}) {
 const assets=useMemo<TLAssetStore>(()=>({
  async upload(_asset,file){
   const bytes=crypto.getRandomValues(new Uint8Array(16));const id=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
   const url=`${localSyncOrigin}/assets/${token}/${id}`
   const response=await fetch(url,{method:'PUT',headers:{'Content-Type':file.type},body:file})
   if(!response.ok)throw new Error('Не удалось сохранить файл')
   return {src:url}
  },
  resolve(asset){return asset.props.src},
 }),[token])
 const store=useSync({uri:`ws://127.0.0.1:5858/connect/${token}`,assets,schema})
 if(store.status==='loading')return <div className="sync-status">Подключение к комнате…</div>
 if(store.status==='error')return <div className="sync-status" role="alert">Не удалось подключиться к комнате: {store.error.message}</div>
 return <Tldraw licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY} hideUi store={store} shapeUtils={pdfShapeUtils} components={components} onMount={onMount}/>
}
export async function createLocalRoom(editor:Editor) {
 const snapshot=structuredClone(editor.store.getStoreSnapshot())
 removeUnusedPdfAssets(snapshot)
 // The local editor stores blobs in IndexedDB; turn those into portable data
 // before handing the snapshot to the shared store.
 for(const record of Object.values(snapshot.store)){
  if(record.typeName!=='asset'||(record.type!=='image'&&!isPdfAsset(record)))continue
  const url=await editor.resolveAssetUrl(record.id,{shouldResolveToOriginal:true})
  if(!url)throw new Error('Не удалось найти файл на доске')
  const response=await fetch(url)
  if(!response.ok)throw new Error('Не удалось прочитать файл на доске')
  const blob=await response.blob()
  if(blob.size>6*1024*1024)throw new Error('Файл на доске слишком большой для локальной комнаты')
  record.props.src=await FileHelpers.blobToDataUrl(blob)
 }
 const bytes=crypto.getRandomValues(new Uint8Array(32))
 const token=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('')
 const response=await fetch(`${localSyncOrigin}/rooms/${token}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(snapshot)})
 if(!response.ok)throw new Error('Не удалось создать комнату')
 return token
}
