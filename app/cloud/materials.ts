import type { SupabaseClient } from '@supabase/supabase-js'
import * as Y from 'yjs'
import { getRoomMaterialUrl, uploadRoomMaterial } from './rooms'
import type { CloudUpdateLog } from './update-log'
import { isSharedMaterial, type SharedMaterial } from './material-data'

export type { SharedMaterial } from './material-data'

/** Shared metadata only; files stay in the room's private Storage folder. */
export class CloudMaterials {
 private readonly materials:Y.Map<SharedMaterial>
 constructor(private readonly doc:Y.Doc,private readonly roomId:string,private readonly client:SupabaseClient,private readonly log:CloudUpdateLog){this.materials=doc.getMap('materials')}
 watch(callback:(items:SharedMaterial[])=>void):()=>void {
  const emit=()=>callback(Array.from(this.materials.values()).filter(value=>isSharedMaterial(value,this.roomId)))
  this.materials.observe(emit);emit();return()=>this.materials.unobserve(emit)
 }
 async upload(file:File):Promise<string>{
  let material:Blob=file
  if(file.type.startsWith('image/')&&file.type!=='image/gif'){
   try{const {default:compress}=await import('browser-image-compression');material=await compress(file,{maxSizeMB:1,maxWidthOrHeight:2400,useWebWorker:true,fileType:'image/webp'})}catch{/* Keep the original if compression is unavailable. */}
  }
  return uploadRoomMaterial(this.roomId,material,this.client)
 }
 publish(item:SharedMaterial){if(!isSharedMaterial(item,this.roomId))throw new Error('Некорректный файл');this.doc.transact(()=>this.materials.set(item.id,item),'material')}
 close(id:string){this.doc.transact(()=>this.materials.delete(id),'material')}
 resolve(path:string){return getRoomMaterialUrl(this.roomId,path,this.client)}
 async discard(path:string){await this.client.storage.from('board-materials').remove([path])}
 flush(){return this.log.flush()}
}
