'use client'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Tldraw, Editor, createShapesForAssets, DEFAULT_MAX_ASSET_SIZE, DefaultColorStyle, DefaultDashStyle, DefaultSizeStyle, GeoShapeGeoStyle, react as reactToState, toRichText, useEditor, useValue, type TLGridProps } from 'tldraw'
import { addPdfToBoard, pdfShapeUtils } from './pdf-shape'
import { isPdfAsset, isPdfFile, removeUnusedPdfAssets } from './pdf-assets'
import { PixelEraser } from './pixel-eraser'
import { insertPhysicsPreset, type Preset } from './physics-presets'
import { SyncCanvas, createLocalRoom } from './sync-canvas'
import { CloudCanvas, prepareCloudSnapshot } from './cloud/canvas'
import { createCloudRoom, initializeCloudRoom } from './cloud/rooms'
import { materialTypes } from './cloud/material-data'
import type { CloudSyncStatus } from './cloud/update-log'
import type { CloudMaterials, SharedMaterial } from './cloud/materials'
import { ArrowDownLeft, ArrowLeft, ArrowRight, ArrowUpRight, Check, ChevronLeft, ChevronRight, Circle, Download, Eraser, FileText, Grid2X2, Hand, Highlighter, Image as ImageIcon, Link2, LockKeyhole, Minus, MoreHorizontal, MousePointer2, MoveUpRight, PanelRightClose, Paperclip, Pen, Pin, PinOff, Plus, Redo2, Search, Settings2, Shapes, Sparkles, Square, Trash2, Type, Undo2, Upload, Users, X, ZoomIn, ZoomOut } from 'lucide-react'

type Media = { id:string; scope?:string; name:string; url:string; type:string; minimized:boolean; pinned?:boolean; x:number; y:number; shared?:boolean; path?:string; refreshAt?:number; upload?:'uploading'|'failed' }
const tools = [
  {id:'select', label:'Выбор', icon:MousePointer2, key:'V'}, {id:'hand', label:'Перемещение', icon:Hand, key:'H'},
  {id:'draw', label:'Карандаш', icon:Pen, key:'P'}, {id:'highlight', label:'Маркер', icon:Highlighter, key:'B'},
  {id:'eraser', label:'Ластик', icon:Eraser, key:'E'}, {id:'arrow', label:'Стрелка', icon:MoveUpRight, key:'A'},
  {id:'geo', label:'Фигуры', icon:Square, key:'R'}, {id:'text', label:'Текст', icon:Type, key:'T'},
]
const colors = [{id:'black',hex:'#f1f2f4'},{id:'grey',hex:'#8e9aa9'},{id:'red',hex:'#f17c83'},{id:'orange',hex:'#efb46d'},{id:'yellow',hex:'#e7d580'},{id:'green',hex:'#84c7aa'},{id:'blue',hex:'#8aaaf4'},{id:'violet',hex:'#bd9df2'}] as const
function NotebookGrid({x,y,z,size}:TLGridProps){
 const id=useId().replace(/:/g,''), editor=useEditor()
 return <svg className="tl-grid" aria-hidden="true"><defs>{editor.options.gridSteps.map(({min,mid,step})=>{const spacing=step*size*z;const opacity=z<mid?Math.max(0,Math.min(1,(z-min)/(mid-min))):1;const major=spacing*5;return <g key={step}><pattern id={`${id}-${step}`} x={x*z} y={y*z} width={spacing} height={spacing} patternUnits="userSpaceOnUse"><path d={`M ${spacing} 0 H 0 V ${spacing}`} fill="none" stroke="var(--tl-color-grid)" strokeWidth="1" opacity={opacity}/></pattern><pattern id={`${id}-major-${step}`} x={x*z} y={y*z} width={major} height={major} patternUnits="userSpaceOnUse"><path d={`M ${major} 0 H 0 V ${major}`} fill="none" stroke="var(--tl-color-grid)" strokeWidth="1.8" opacity={opacity}/></pattern></g>})}</defs>{editor.options.gridSteps.map(({step})=><rect key={step} width="100%" height="100%" fill={`url(#${id}-${step})`}/>)}<g className="graph-grid-major">{editor.options.gridSteps.map(({step})=><rect key={step} width="100%" height="100%" fill={`url(#${id}-major-${step})`}/>)}</g></svg>
}
function BoardBackground(){
 const editor=useEditor()
 const camera=useValue('board camera',()=>editor.getCamera(),[editor])
 const size=useValue('board grid size',()=>editor.getDocumentSettings().gridSize,[editor])
 return <><div className="tl-background"/><NotebookGrid {...camera} size={size}/></>
}
const canvasComponents={Background:BoardBackground,Grid:null}
export default function Board(){
 const [editor,setEditor]=useState<Editor|null>(null), [active,setActive]=useState('select'), [color,setColor]=useState('black'), [background,setBackground]=useState('dark'), [menu,setMenu]=useState<string|null>(null), [size,setSize]=useState('m'), [grid,setGrid]=useState(true), [panel,setPanel]=useState(true), [media,setMedia]=useState<Media[]>([]), [dragging,setDragging]=useState(false), [notice,setNotice]=useState(''), [room,setRoom]=useState<string|null>(()=>{if(typeof window==='undefined'||process.env.NODE_ENV!=='development')return null;const value=new URLSearchParams(window.location.hash.slice(1)).get('room');return value&&/^[a-f0-9]{64}$/.test(value)?value:null}), [creatingRoom,setCreatingRoom]=useState(false)
 const [cloudToken,setCloudToken]=useState<string|null>(()=>{if(typeof window==='undefined')return null;const value=new URLSearchParams(window.location.hash.slice(1)).get('cloud');return value&&/^[a-f0-9]{64}$/.test(value)?value:null}), [cloudStatus,setCloudStatus]=useState<CloudSyncStatus|'loading'|'failed'>('loading'), [shareOpen,setShareOpen]=useState(false)
 const [snapToGrid,setSnapToGrid]=useState(true),[gridStyle,setGridStyle]=useState<'notebook'|'graph'>('notebook'),[eraserMode,setEraserMode]=useState<'stroke'|'partial'>('stroke'),[licenseBlocked,setLicenseBlocked]=useState(false)
 const [dashStyle,setDashStyle]=useState<'draw'|'solid'|'dashed'>('draw')
 const personalEditor=useRef<Editor|null>(null)
 const canvasContainer=useRef<HTMLDivElement>(null)
 const retryMissingMaterials=useRef<(()=>void)|null>(null)
 const previousMediaUrls=useRef(new Set<string>())
 const input=useRef<HTMLInputElement>(null), dragDepth=useRef(0), urls=useRef<string[]>([]), pendingCloudShare=useRef(false), materialApi=useRef<CloudMaterials|null>(null), mediaRef=useRef<Media[]>([]), desiredMaterials=useRef(new Map<string,SharedMaterial>()), loadingMaterials=useRef(new Set<string>()), cancelledMaterials=useRef(new Set<string>())
 mediaRef.current=media
 useEffect(()=>{
  const container=canvasContainer.current
  if(!container)return
  const check=()=>setLicenseBlocked(!!container.querySelector('[data-testid="tl-license-expired"]'))
  const observer=new MutationObserver(check)
  observer.observe(container,{childList:true,subtree:true})
  check()
  return()=>observer.disconnect()
 },[])
 useEffect(()=>()=>urls.current.forEach(URL.revokeObjectURL),[])
 useEffect(()=>{
  const current=new Set(media.map(item=>item.url))
  for(const url of previousMediaUrls.current){
   if(current.has(url))continue
   const index=urls.current.indexOf(url)
   if(index>=0){URL.revokeObjectURL(url);urls.current.splice(index,1)}
  }
  previousMediaUrls.current=current
 },[media])
 useEffect(()=>{
  const refreshing=new Set<string>()
  const refresh=()=>{
   const api=materialApi.current
   if(!api)return
   if(Array.from(desiredMaterials.current.values()).some(item=>!loadingMaterials.current.has(item.id)&&!mediaRef.current.some(value=>value.id===item.id)))retryMissingMaterials.current?.()
   for(const item of mediaRef.current){
    if(!item.shared||!item.path||!item.refreshAt||item.refreshAt>Date.now()||refreshing.has(item.id))continue
    const {id,path}=item
    refreshing.add(id)
    void api.resolve(path).then(url=>{
     if(materialApi.current!==api||desiredMaterials.current.get(id)?.path!==path)return
     setMedia(current=>current.map(value=>value.id===id&&value.path===path?{...value,url,refreshAt:Date.now()+45*60_000}:value))
    }).catch(()=>{/* Retry on the next check or when the connection returns. */}).finally(()=>refreshing.delete(id))
   }
  }
  const timer=setInterval(refresh,60_000)
  window.addEventListener('online',refresh)
  window.addEventListener('focus',refresh)
  return()=>{clearInterval(timer);window.removeEventListener('online',refresh);window.removeEventListener('focus',refresh)}
 },[])
 useEffect(()=>{const saved=localStorage.getItem('physics-board-background'); if(saved && ['dark','white','cream','blue'].includes(saved)) setBackground(saved);setGrid(localStorage.getItem('physics-board-grid')!=='false');setSnapToGrid(localStorage.getItem('physics-board-grid-snap')!=='false');if(localStorage.getItem('physics-board-grid-style')==='graph')setGridStyle('graph')},[])
 useEffect(()=>{editor?.user.updateUserPreferences({colorScheme:background==='dark'?'dark':'light'})},[editor,background])
 useEffect(()=>{
  if(!editor)return
  return reactToState('active board tool',()=>{const id=editor.getCurrentToolId();setActive(id==='pixel-eraser'?'eraser':id)})
 },[editor])
 useEffect(()=>{
  if(!editor)return
  const onKeyDown=(event:KeyboardEvent)=>{
   if(event.repeat||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey||shareOpen||creatingRoom||licenseBlocked||editor.getEditingShapeId())return
   const target=event.target
   if(target instanceof HTMLElement&&(target.isContentEditable||target.closest('input,textarea,select,[contenteditable="true"],[role="textbox"]')))return
   const shortcuts:Record<string,string>={v:'select',h:'hand',p:'draw',b:'highlight',e:'eraser',a:'arrow',r:'geo',t:'text'}
   const tool=shortcuts[event.key.toLowerCase()]
   if(!tool)return
   event.preventDefault();event.stopPropagation()
   editor.setCurrentTool(tool==='eraser'&&eraserMode==='partial'?'pixel-eraser':tool)
   setMenu(null)
  }
  window.addEventListener('keydown',onKeyDown,true)
  return()=>window.removeEventListener('keydown',onKeyDown,true)
 },[editor,eraserMode,shareOpen,creatingRoom,licenseBlocked])
 useEffect(()=>{if(!notice)return; const timer=setTimeout(()=>setNotice(''),2500);return()=>clearTimeout(timer)},[notice])
 const mount=useCallback((ed:Editor)=>{
  if(!ed.root.children?.['pixel-eraser'])ed.root.addChild(PixelEraser)
  ed.updateInstanceState({isGridMode:localStorage.getItem('physics-board-grid-snap')!=='false'})
  setEditor(ed)
  if(new URLSearchParams(location.search).has('pdf'))ed.navigateToDeepLink({param:'pdf'})
 },[])
 const mountPersonal=useCallback((ed:Editor)=>{
  personalEditor.current=ed
  mount(ed)
  const shouldSeed=localStorage.getItem('physics-board-initialized-v1')!=='1'&&ed.getCurrentPageShapes().length===0
  localStorage.setItem('physics-board-initialized-v1','1')
  if(shouldSeed){
    ed.createShapes([
      {type:'text',x:170,y:130,props:{richText:toRichText('Движение по наклонной плоскости'),size:'l',color:'black'}},
      {type:'text',x:172,y:190,props:{richText:toRichText('Разложим силы, действующие на тело'),size:'m',color:'grey'}},
      {type:'geo',x:250,y:310,rotation:0,props:{geo:'triangle',w:330,h:210,color:'grey',dash:'solid',fill:'none'}},
      {type:'geo',x:400,y:300,rotation:-0.55,props:{geo:'rectangle',w:85,h:70,color:'blue',dash:'solid',fill:'semi'}},
      {type:'arrow',x:440,y:325,props:{start:{x:0,y:0},end:{x:0,y:140},color:'red',size:'m'}},
      {type:'arrow',x:440,y:325,props:{start:{x:0,y:0},end:{x:75,y:-105},color:'green',size:'m'}},
      {type:'text',x:455,y:450,props:{richText:toRichText('mg'),color:'red',size:'m'}},
      {type:'text',x:515,y:215,props:{richText:toRichText('N'),color:'green',size:'m'}},
      {type:'text',x:260,y:545,props:{richText:toRichText('α'),color:'yellow',size:'l'}},
      {type:'text',x:650,y:310,props:{richText:toRichText('ΣF = ma\n\nN = mg cos α\n\nFₓ = mg sin α'),color:'black',size:'l'}}
    ]); ed.zoomToFit({animation:{duration:0}})
   }
 },[mount])
 const choose=(id:string)=>{setActive(id);editor?.setCurrentTool(id==='eraser'&&eraserMode==='partial'?'pixel-eraser':id);setMenu(['draw','highlight','eraser','arrow','geo','text'].includes(id)?id:null)}
 const addFiles=(files:FileList|File[], drop?:{x:number;y:number})=>{
  const accepted=Array.from(files).filter(file=>isPdfFile(file)||(cloudToken?materialTypes.has(file.type):file.type.startsWith('image/')))
  if(!accepted.length){setNotice('Выберите поддерживаемое изображение или PDF');return}
  const pictures=accepted.filter(file=>!isPdfFile(file))
  const pdfs=accepted.filter(isPdfFile)
  if(pdfs.length){
   if(!editor||editor.isDisposed)setNotice('Доска ещё загружается')
   else {
    const bounds=editor.getViewportScreenBounds()
    const panelWidth=panel && bounds.w>650 ? (bounds.w>900 ? 296 : 249) : 0
    const center=editor.screenToPage(drop??{x:bounds.x+(bounds.w-panelWidth)/2,y:bounds.center.y+24})
    pdfs.forEach((file,index)=>{void addPdfToBoard(editor,file,{x:center.x+index*24,y:center.y+index*24}).catch(error=>setNotice(error.message))})
    setMenu(null)
   }
  }
  if(!pictures.length)return
  const added=pictures.map((file,index)=>{
   const url=URL.createObjectURL(file)
   urls.current.push(url)
   return {id:crypto.randomUUID(),scope:cloudToken??room??undefined,name:file.name,url,type:file.type,
    minimized:false,x:window.innerWidth-520-index*25,y:100+index*25}
  })
  setMedia(current=>[...current,...added])
  const api=materialApi.current
  if(api)pictures.forEach((file,index)=>{void publishMaterial(api,added[index].id,file).catch(error=>setNotice(error.message))})
 }
 const patch=(id:string, changes:Partial<Media>)=>setMedia(m=>m.map(item=>item.id===id?{...item,...changes}:item))
 const focusMedia=(id:string)=>setMedia(current=>{const index=current.findIndex(item=>item.id===id);if(index<0||index===current.length-1)return current;const next=current.slice();const [item]=next.splice(index,1);next.push(item);return next})
 const publishMaterial=async(api:CloudMaterials,id:string,file:File)=>{
  if(materialApi.current!==api||cancelledMaterials.current.has(id))return
  patch(id,{upload:'uploading'})
  let path:string|undefined
  try{
   path=await api.upload(file)
   if(materialApi.current!==api||cancelledMaterials.current.has(id)){await api.discard(path);return}
   api.publish({id,name:file.name.slice(0,255),type:file.type,path,page:1})
   patch(id,{upload:undefined})
  }catch{
   if(path)await api.discard(path)
   if(materialApi.current!==api||cancelledMaterials.current.has(id))return
   patch(id,{upload:'failed'})
   throw new Error('Не удалось загрузить «'+file.name+'»')
  }
 }
 const receiveMaterials=(items:SharedMaterial[],api:CloudMaterials)=>{
  materialApi.current=api
  retryMissingMaterials.current=()=>receiveMaterials(Array.from(desiredMaterials.current.values()),api)
  const desired=new Map(items.map(item=>[item.id,item]))
  desiredMaterials.current=desired
  setMedia(current=>current.filter(item=>item.scope!==cloudToken||!item.shared||desired.has(item.id)).map(item=>{
   const shared=item.scope===cloudToken&&desired.get(item.id)
   return shared?{...item,shared:true,upload:undefined}:item
  }))
  for(const item of items){
   if(mediaRef.current.some(value=>value.id===item.id)||loadingMaterials.current.has(item.id))continue
   loadingMaterials.current.add(item.id)
   void api.resolve(item.path).then(url=>{
    const latest=desiredMaterials.current.get(item.id)
    if(materialApi.current!==api||!latest)return
    setMedia(current=>current.some(value=>value.id===item.id)?current:[...current,{
     id:latest.id,scope:cloudToken,name:latest.name,type:latest.type,url,shared:true,
     path:latest.path,refreshAt:Date.now()+45*60_000,minimized:false,x:window.innerWidth-520,y:100,
    }])
   }).catch(()=>{if(materialApi.current===api)setNotice('Не удалось открыть «'+item.name+'»')})
    .finally(()=>loadingMaterials.current.delete(item.id))
  }
 }
 const closeMedia=(id:string)=>{cancelledMaterials.current.add(id);materialApi.current?.close(id);setMedia(current=>current.filter(item=>item.id!==id))}
 const retryMaterial=async(item:Media)=>{
  const api=materialApi.current
  if(!api)return
  patch(item.id,{upload:'uploading'})
  try{
   const response=await fetch(item.url)
   if(!response.ok)throw new Error()
   const blob=await response.blob()
   await publishMaterial(api,item.id,new File([blob],item.name,{type:item.type}))
  }catch(error){
   if(materialApi.current!==api||cancelledMaterials.current.has(item.id))throw error
   patch(item.id,{upload:'failed'})
   throw new Error('Не удалось загрузить «'+item.name+'»')
  }
 }
 const move=(event:React.PointerEvent<HTMLDivElement>,id:string)=>{
  if(event.button!==0||(event.target as Element).closest('button'))return
  const header=event.currentTarget
  const bounds=header.parentElement!.getBoundingClientRect()
  const startX=event.clientX,startY=event.clientY
  const pointer=event.pointerId
  header.setPointerCapture(pointer)
  const onMove=(next:PointerEvent)=>{
   if(next.pointerId!==pointer)return
   patch(id,{x:Math.max(0,Math.min(window.innerWidth-bounds.width,bounds.left+next.clientX-startX)),
    y:Math.max(0,Math.min(window.innerHeight-bounds.height,bounds.top+next.clientY-startY))})
  }
  const end=()=>{
   header.removeEventListener('pointermove',onMove)
   header.removeEventListener('lostpointercapture',end)
  }
  header.addEventListener('pointermove',onMove)
  header.addEventListener('lostpointercapture',end)
 }
 const toggleGrid=()=>{setGrid(!grid);localStorage.setItem('physics-board-grid',String(!grid))}
 const toggleSnap=()=>{const next=!snapToGrid;editor?.updateInstanceState({isGridMode:next});setSnapToGrid(next);localStorage.setItem('physics-board-grid-snap',String(next))}
 const insertImage=async(blob:Blob)=>{
  if(!editor)throw new Error('Доска ещё загружается')
  if(blob.size>DEFAULT_MAX_ASSET_SIZE)throw new Error('Изображение слишком большое')
  const type=blob.type||'image/png'
  const file=new File([blob],type==='image/webp'?'material.webp':type==='image/jpeg'?'material.jpg':'material.png',{type})
  const asset=await editor.getAssetForExternalContent({type:'file',file})
  if(!asset||asset.type!=='image'||!asset.props.src||editor.isDisposed)throw new Error('Не удалось загрузить изображение')
  const ids=await createShapesForAssets(editor,[asset],editor.getViewportPageBounds().center)
  if(!ids.some(id=>editor.getShape(id)))throw new Error('Не удалось вставить изображение')
  setNotice('Добавлено на доску')
 }
 const insertLocalImage=async(url:string)=>{
  const response=await fetch(url)
  if(!response.ok)throw new Error('Не удалось прочитать изображение')
  const blob=await response.blob()
  let image=blob
  try{
   const file=new File([blob],'image',{type:blob.type})
   const {default:compress}=await import('browser-image-compression')
   image=await compress(file,{maxSizeMB:1,maxWidthOrHeight:2400,useWebWorker:true,fileType:'image/webp'})
  }catch{/* The editor can insert the original if it meets its file limit. */}
  await insertImage(image)
 }
 const stamp=(kind:Preset)=>{if(!editor)return;insertPhysicsPreset(editor,kind);setActive('select');setMenu(null);setNotice('Объект добавлен на доску')}
 const shareLocalRoom=async()=>{if(!editor||creatingRoom)return;setCreatingRoom(true);try{const token=room||await createLocalRoom(editor);const link=`${location.origin}${location.pathname}#room=${token}`;if(!room){history.replaceState(null,'',link);setEditor(null);setRoom(token)}try{await navigator.clipboard.writeText(link);setNotice('Ссылка скопирована. Комната работает только на этом компьютере.')}catch{setNotice('Комната открыта. Скопируйте адрес из строки браузера.')}}catch(error){setNotice(error instanceof Error?error.message:'Не удалось создать локальную комнату')}finally{setCreatingRoom(false)}}
 const leaveRoom=()=>{
  history.replaceState(null,'',location.pathname+location.search)
  pendingCloudShare.current=false
  materialApi.current=null
  retryMissingMaterials.current=null
  desiredMaterials.current.clear()
  const scope=cloudToken??room
  setMedia(current=>current.filter(item=>item.scope!==scope))
  setCreatingRoom(false)
  setShareOpen(false)
 setEditor(personalEditor.current)
  setRoom(null)
  setCloudToken(null)
  setNotice('Открыта личная доска')
 }
 const shareCloud=async()=>{
  if(cloudToken){
   if(mediaRef.current.some(item=>item.upload)){setNotice('Дождитесь загрузки материалов или повторите загрузку');return}
   if(cloudStatus!=='saved'){setNotice('Дождитесь сохранения доски перед отправкой ссылки');return}
   setShareOpen(true)
   return
  }
  if(!editor||creatingRoom)return
  setCreatingRoom(true)
  try{
   const original=structuredClone(editor.store.getStoreSnapshot())
   removeUnusedPdfAssets(original)
   const initial=structuredClone(original)
   for(const record of Object.values(initial.store)){
    if(record.typeName==='asset'&&record.type==='video')throw new Error('Перенос видео в облачную комнату пока не поддерживается')
    if(record.typeName==='asset'&&(record.type==='image'||isPdfAsset(record)))record.props.src=null
   }
   const created=await createCloudRoom(initial)
   const snapshot=await prepareCloudSnapshot(editor,created.id,original)
   await initializeCloudRoom(created.id,snapshot)
   pendingCloudShare.current=true
   setMedia(current=>current.map(item=>({...item,scope:created.token})))
   setEditor(null)
   setRoom(null)
   history.replaceState(null,'',location.pathname+location.search+'#cloud='+created.token)
   setCloudToken(created.token)
  }catch(error){
   setCreatingRoom(false)
   setNotice(error instanceof Error?error.message:'Не удалось создать комнату')
  }
 }
 const cloudReady=(api:CloudMaterials)=>{
  materialApi.current=api
  const sharing=pendingCloudShare.current
  const existing=mediaRef.current.filter(item=>item.scope===cloudToken&&!item.shared&&!item.upload)
  void (async()=>{
   const results=await Promise.allSettled(existing.map(retryMaterial))
   if(materialApi.current!==api)return
   const failed=results.some(result=>result.status==='rejected')
   if(failed)setNotice('Некоторые файлы не загрузились. Повторите загрузку.')
   if(!sharing)return
   pendingCloudShare.current=false
   setCreatingRoom(false)
   if(failed)return
   try{
    await api.flush()
    if(materialApi.current===api)setShareOpen(true)
   }catch{
    if(materialApi.current===api)setNotice('Не удалось сохранить все изменения в облаке. Повторите отправку ссылки после восстановления соединения.')
   }
  })()
 }
 const cloudState=(status:CloudSyncStatus|'loading'|'failed')=>{setCloudStatus(status);if(status==='failed'){setCreatingRoom(false);pendingCloudShare.current=false}}
 const cloudLabel=cloudStatus==='saved'?'Сохранено в облаке':cloudStatus==='syncing'?'Сохранение…':cloudStatus==='offline'?'Нет соединения':cloudStatus==='error'?'Ошибка сохранения':cloudStatus==='failed'?'Ошибка подключения':'Подключение…'
 return <main className="workspace" data-background={background} data-grid={grid ? "visible" : "hidden"} data-grid-style={gridStyle} onDragEnter={e=>{e.preventDefault();dragDepth.current++;setDragging(true)}} onDragOver={e=>e.preventDefault()} onDragLeave={e=>{e.preventDefault();dragDepth.current--;if(dragDepth.current<=0){dragDepth.current=0;setDragging(false)}}} onDropCapture={e=>{dragDepth.current=0;setDragging(false);if(!Array.from(e.dataTransfer.files).some(isPdfFile))return;e.preventDefault();e.stopPropagation();addFiles(e.dataTransfer.files,{x:e.clientX,y:e.clientY})}} onDrop={e=>{e.preventDefault();if(e.dataTransfer.files.length)addFiles(e.dataTransfer.files)}}>
  <div className="canvas" ref={canvasContainer}>
   {(!room&&!cloudToken||personalEditor.current)&&<div className="personal-canvas" inert={!!(room||cloudToken)} style={{visibility:room||cloudToken?'hidden':undefined}}>
    <Tldraw licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY} hideUi components={canvasComponents} persistenceKey="physics-board-v1" shapeUtils={pdfShapeUtils} onMount={mountPersonal}/>
   </div>}
   {cloudToken?<CloudCanvas key={cloudToken} token={cloudToken} onMount={mount} components={canvasComponents} onStatus={cloudState} onReady={cloudReady} onMaterials={receiveMaterials}/>:room?<SyncCanvas token={room} onMount={mount} components={canvasComponents}/>:null}
  </div>
  <header className="topbar">
   <span className="brand-icon" aria-hidden="true">φ</span>
   <div className="board-name">
    <h1>Доска по физике</h1>
    <span className="board-status" role="status" data-status={cloudToken ? cloudStatus : room ? 'local' : 'saved'}>
     <span className="status-dot" aria-hidden="true"/>
     <span>{cloudToken ? cloudLabel : room ? 'Комната на этом компьютере' : 'Сохранено на устройстве'}</span>
    </span>
   </div>
   <div className="header-actions">
    <span className="session">{cloudToken ? 'Облачная комната' : room ? 'Локальная комната' : 'Личная доска'}</span>
    {(room || cloudToken) && <button type="button" className="header-button exit-room" title="На личную доску" onClick={leaveRoom}>
     <ArrowLeft size={16} aria-hidden="true"/>
     <span className="header-button-label">На личную доску</span>
    </button>}
    {process.env.NODE_ENV === 'development' && !cloudToken && <button type="button" className="header-button local-room" disabled={!editor || creatingRoom} title="Работает только на этом компьютере" onClick={() => void shareLocalRoom()}>
     <Users size={16} aria-hidden="true"/>
     <span className="header-button-label">{room ? 'Ссылка на локальную комнату' : 'Локальная комната'}</span>
    </button>}
    <button type="button" className="header-button share" title="Поделиться" disabled={!editor || creatingRoom} onClick={() => void shareCloud()}>
     <Link2 size={16} aria-hidden="true"/>
     <span className="header-button-label">{creatingRoom ? 'Создание…' : 'Поделиться'}</span>
    </button>
   </div>
  </header>
  <nav className="left-tools glass" aria-label="Инструменты доски"><div className="tool-group">{tools.map((t,i)=><div key={t.id} className={i===2||i===5?'tool-separator':''}><button className={'tool '+(active===t.id?'selected':'')} title={`${t.label} (${t.key})`} aria-label={t.label} aria-pressed={active===t.id} onClick={()=>{if(active===t.id && menu===t.id)setMenu(null);else choose(t.id)}}><t.icon size={19} strokeWidth={1.7}/>{['draw','highlight','eraser','arrow','geo','text'].includes(t.id)&&<span className="tool-corner"/>}</button></div>)}</div><div className="tool-separator"><button className="tool" title="Добавить файл" aria-label="Добавить файл" onClick={()=>{setMenu(null);input.current?.click()}}><Paperclip size={19}/></button><button className={'tool '+(menu==='background'?'selected':'')} title="Фон и сетка" aria-label="Фон и сетка" aria-expanded={menu==='background'} onClick={()=>setMenu(menu==='background'?null:'background')}><Settings2 size={19}/></button></div>
  {menu&&<div className="tool-popover" role="dialog" aria-label={menu==='background'?'Фон и сетка':'Настройки инструмента'}><div className="popover-title"><strong>{menu==='background'?'Фон и сетка':tools.find(t=>t.id===menu)?.label}</strong><button aria-label="Закрыть" onClick={()=>setMenu(null)}><X size={15}/></button></div>{menu==='background'?<><span className="popover-label">Цвет фона</span><div className="background-swatches">{[{id:'white',name:'Белый',hex:'#ffffff'},{id:'cream',name:'Бумажный',hex:'#f7f1e4'},{id:'blue',name:'Голубой',hex:'#e8f1f7'},{id:'dark',name:'Тёмный',hex:'#171a22'}].map(c=><button key={c.id} title={c.name} aria-label={c.name} aria-pressed={background===c.id} className={'background-swatch '+(background===c.id?'current':'')} style={{background:c.hex}} onClick={()=>{setBackground(c.id);localStorage.setItem('physics-board-background',c.id)}}>{background===c.id&&<Check size={16} color={c.id==='dark'?'white':'#242833'}/>}</button>)}</div><span className="popover-label">Разметка</span><div className="grid-options"><button className={!grid?'current':''} onClick={()=>{if(grid)toggleGrid()}}>Без сетки</button><button className={grid?'current':''} onClick={()=>{if(!grid)toggleGrid()}}>Сетка</button></div><span className="popover-label">Вид сетки</span><div className="grid-options"><button aria-pressed={gridStyle==='notebook'} className={gridStyle==='notebook'?'current':''} onClick={()=>{setGridStyle('notebook');localStorage.setItem('physics-board-grid-style','notebook')}}>Тетрадь</button><button aria-pressed={gridStyle==='graph'} className={gridStyle==='graph'?'current':''} onClick={()=>{setGridStyle('graph');localStorage.setItem('physics-board-grid-style','graph')}}>Миллиметровка</button></div><span className="popover-label">Привязка к клеткам</span><div className="grid-options"><button aria-pressed={!snapToGrid} className={!snapToGrid?'current':''} onClick={()=>{if(snapToGrid)toggleSnap()}}>Выключена</button><button aria-pressed={snapToGrid} className={snapToGrid?'current':''} onClick={()=>{if(!snapToGrid)toggleSnap()}}>Включена</button></div></>:menu==='eraser'?<><span className="popover-label">Режим ластика</span><div className="grid-options eraser-options"><button aria-pressed={eraserMode==='stroke'} className={eraserMode==='stroke'?'current':''} onClick={()=>{setEraserMode('stroke');editor?.setCurrentTool('eraser')}}>Весь штрих</button><button aria-pressed={eraserMode==='partial'} className={eraserMode==='partial'?'current':''} onClick={()=>{setEraserMode('partial');editor?.setCurrentTool('pixel-eraser')}}>Часть штриха</button></div><p className="eraser-description">{eraserMode==='partial'?'Стирает части карандаша и маркера.':'Удаляет объект целиком.'}</p></>:<>{menu==='geo'&&<><span className="popover-label">Фигура</span><div className="shape-options">{([{id:'rectangle',name:'Прямоугольник',icon:Square},{id:'ellipse',name:'Круг',icon:Circle},{id:'triangle',name:'Треугольник',icon:Shapes}] as const).map(shape=><button key={shape.id} title={shape.name} aria-label={shape.name} onClick={()=>{editor?.setStyleForNextShapes(GeoShapeGeoStyle,shape.id);editor?.setCurrentTool('geo')}}><shape.icon size={19}/></button>)}</div></>}{(menu==='geo'||menu==='arrow')&&<><span className="popover-label">Линия</span><div className="grid-options dash-options">{([{id:'draw',name:'От руки'},{id:'solid',name:'Сплошная'},{id:'dashed',name:'Пунктирная'}] as const).map(item=><button key={item.id} aria-pressed={dashStyle===item.id} className={dashStyle===item.id?'current':''} onClick={()=>{setDashStyle(item.id);editor?.setStyleForNextShapes(DefaultDashStyle,item.id)}}>{item.name}</button>)}</div></>}<span className="popover-label">Цвет</span><div className="popover-swatches">{colors.map(c=><button key={c.id} title={c.id} aria-label={`Цвет ${c.id}`} aria-pressed={color===c.id} className={'swatch '+(color===c.id?'chosen':'')} style={{'--swatch':c.hex} as React.CSSProperties} onClick={()=>{setColor(c.id);editor?.setStyleForNextShapes(DefaultColorStyle,c.id)}}/>)}</div><span className="popover-label">Толщина</span><div className="size-options">{([{id:'s',name:'Тонкая',dot:4},{id:'m',name:'Средняя',dot:7},{id:'l',name:'Толстая',dot:10}] as const).map(item=><button key={item.id} title={item.name} aria-label={item.name} aria-pressed={size===item.id} className={size===item.id?'current':''} onClick={()=>{setSize(item.id);editor?.setStyleForNextShapes(DefaultSizeStyle,item.id)}}><span style={{width:item.dot,height:item.dot}}/></button>)}</div></>}</div>}</nav>
  {panel?<aside className="sidepanel glass"><div className="panel-heading"><div><span className="overline">ВАША БИБЛИОТЕКА</span><h2>Материалы</h2></div><button className="icon-btn" title="Закрыть панель" onClick={()=>setPanel(false)}><PanelRightClose size={18}/></button></div><p className="panel-copy">Всё необходимое для занятия<br/>под рукой.</p><button className="upload" onClick={()=>input.current?.click()}><span className="upload-icon"><Upload size={19}/></span><strong>Добавить файл</strong><small>Перетащите сюда или выберите</small><span className="formats">PDF, PNG, JPG, WEBP</span></button><div className="section-heading"><h3>Быстрые фигуры</h3><Shapes size={16}/></div><p className="section-copy">Нажмите, чтобы добавить на доску</p><div className="presets">{[{id:'slope',symbol:'◩',name:'Плоскость'},{id:'block',symbol:'▱',name:'Тело'},{id:'axes',symbol:'↗',name:'Оси X / Y'},{id:'spring',symbol:'∿',name:'Пружина'},{id:'resistor',symbol:'▭',name:'Резистор'},{id:'capacitor',symbol:'⊣⊢',name:'Конденсатор'},{id:'lens',symbol:'⬭',name:'Линза'}].map(p=><button key={p.id} onClick={()=>stamp(p.id as Preset)}><span>{p.symbol}</span><small>{p.name}</small></button>)}</div><div className="panel-footer"><span className="tiny-dot"/> Ваше пространство для работы</div></aside>:<button className="open-panel glass" onClick={()=>setPanel(true)}><Paperclip size={17}/> Материалы</button>}
  <div className="bottom-left glass"><button title="Отменить" onClick={()=>editor?.undo()}><Undo2 size={17}/></button><button title="Повторить" onClick={()=>editor?.redo()}><Redo2 size={17}/></button></div>
  <div className="bottom-center glass"><button title="Уменьшить" onClick={()=>{editor?.zoomOut()}}><Minus size={17}/></button><button className="zoom" title="Показать всю доску" onClick={()=>{editor?.zoomToFit()}}>Вписать</button><button title="Увеличить" onClick={()=>{editor?.zoomIn()}}><Plus size={17}/></button></div>
  <div className="bottom-hint"><span>✦</span> Пространство для больших идей</div>
  <input ref={input} type="file" accept="image/*,application/pdf" multiple hidden onChange={e=>{if(e.target.files)addFiles(e.target.files);e.target.value=''}}/>
  {media.map(m=><div className="media-window glass" key={m.id} onPointerDownCapture={e=>{if(!(e.target as HTMLElement).closest('button'))focusMedia(m.id)}} onClickCapture={e=>{if((e.target as HTMLElement).closest('button'))focusMedia(m.id)}} style={{'--media-x':m.x+'px','--media-y':m.y+'px',zIndex:m.pinned?32:30,display:m.minimized?'none':undefined} as React.CSSProperties}><div className="media-header" onPointerDown={e=>move(e,m.id)}><FileText size={16}/><strong>{m.name}</strong>{m.upload==='uploading'&&<span className="media-upload">Загрузка…</span>}{m.upload==='failed'&&<button className="retry-upload" onClick={()=>void retryMaterial(m).catch(error=>setNotice(error.message))}>Повторить загрузку</button>}<button title={m.pinned?'Открепить окно':'Закрепить поверх окон'} aria-label={m.pinned?'Открепить окно':'Закрепить поверх окон'} aria-pressed={!!m.pinned} onClick={()=>patch(m.id,{pinned:!m.pinned})}>{m.pinned?<PinOff size={16}/>:<Pin size={16}/>}</button><button title="Свернуть" onClick={()=>patch(m.id,{minimized:true})}><Minus size={16}/></button><button title={m.shared?'Закрыть для всех':'Закрыть'} onClick={()=>closeMedia(m.id)}><X size={16}/></button></div><div className="image-preview"><img src={m.url} alt={m.name}/></div><div className="media-footer">Изображение <button onClick={()=>{void insertLocalImage(m.url).catch(()=>setNotice('Не удалось добавить изображение'))}}>На доску</button></div></div>)}
  {media.some(m=>m.minimized)&&<div className="dock glass">{media.filter(m=>m.minimized).map(m=><button key={m.id} onClick={()=>{patch(m.id,{minimized:false});focusMedia(m.id)}}><FileText size={15}/>{m.name}</button>)}</div>}
  {licenseBlocked&&<div className="license-notice" role="alert"><div><strong>Доска временно недоступна</strong><p>Лицензия редактора не активна. Пожалуйста, сообщите владельцу доски.</p></div></div>}
  {creatingRoom&&<div className="room-creating" role="status">Создаём комнату и сохраняем материалы…</div>}{shareOpen&&cloudToken&&<div className="modal-backdrop" onClick={()=>setShareOpen(false)}><section className="share-dialog" role="dialog" aria-modal="true" aria-label="Пригласить на доску" onClick={e=>e.stopPropagation()}><div className="formula-heading"><h2>Пригласить на доску</h2><button aria-label="Закрыть" onClick={()=>setShareOpen(false)}><X size={18}/></button></div><p>Любой, у кого есть ссылка, сможет открыть и редактировать эту доску.</p><input aria-label="Ссылка на доску" readOnly value={`${location.origin}${location.pathname}#cloud=${cloudToken}`} onFocus={e=>e.currentTarget.select()}/>{['localhost','127.0.0.1'].includes(location.hostname)&&<p>Сейчас адрес ведёт на этот компьютер. Для доступа с других устройств нужно опубликовать приложение.</p>}<div className="formula-actions"><button onClick={()=>setShareOpen(false)}>Закрыть</button><button className="primary" onClick={()=>{void navigator.clipboard?.writeText(`${location.origin}${location.pathname}#cloud=${cloudToken}`).then(()=>setNotice('Ссылка скопирована')).catch(()=>setNotice('Скопируйте ссылку из поля'))}}>Копировать ссылку</button></div></section></div>}{dragging&&<div className="drop-overlay"><div><Upload size={30}/><strong>Отпустите файл здесь</strong><span>PDF появится на доске</span></div></div>}{notice&&<div className="toast">{notice}</div>}
 </main>
}










