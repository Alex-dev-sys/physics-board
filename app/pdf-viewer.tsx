'use client'
import { useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { ChevronLeft, ChevronRight, Scissors, Pin } from 'lucide-react'

export default function PdfViewer({url,onInsert,sharedPage,onPageChange}:{url:string;onInsert:(blob:Blob)=>Promise<void>;sharedPage?:number;onPageChange?:(page:number)=>void}) {
 const [doc,setDoc]=useState<PDFDocumentProxy|null>(null), [page,setPage]=useState(1), [error,setError]=useState(''), [crop,setCrop]=useState(false), [selection,setSelection]=useState<{x:number;y:number;w:number;h:number}|null>(null), [busy,setBusy]=useState(false)
 const [rendered,setRendered]=useState<{doc:PDFDocumentProxy;page:number}|null>(null)
 const canvas=useRef<HTMLCanvasElement>(null), start=useRef<{x:number;y:number}|null>(null)
 const currentRender=useRef<RenderTask|null>(null)
 const ready=!!doc&&rendered?.doc===doc&&rendered.page===page
 useEffect(()=>{let cancelled=false;let task: {destroy:()=>Promise<void>}|undefined;setError('');setDoc(null);setPage(1);(async()=>{try{const pdf=await import('pdfjs-dist');pdf.GlobalWorkerOptions.workerSrc='/pdf.worker.min.mjs';const loading=pdf.getDocument({url});task=loading;const document=await loading.promise;if(!cancelled)setDoc(document)}catch{if(!cancelled)setError('Не удалось открыть PDF. Проверьте файл.')}})();return()=>{cancelled=true;void task?.destroy()}},[url])
 useEffect(()=>{if(doc&&sharedPage)setPage(Math.max(1,Math.min(sharedPage,doc.numPages)))},[doc,sharedPage])
 useEffect(()=>{
  if(!doc||!canvas.current)return
  let cancelled=false,render:RenderTask|undefined
  const element=canvas.current,previous=currentRender.current
  setSelection(null);setRendered(null);setError('')
  ;(async()=>{try{
   if(previous)await previous.promise.catch(()=>{})
   if(cancelled)return
   const pdfPage=await doc.getPage(page)
   if(cancelled)return
   const original=pdfPage.getViewport({scale:1})
   // Keep the RGBA canvas and the exported PNG within the editor's file limit.
   const scale=Math.min(1.5,Math.sqrt(2_000_000/(original.width*original.height)),4096/Math.max(original.width,original.height))
   const viewport=pdfPage.getViewport({scale})
   element.width=viewport.width;element.height=viewport.height
   render=pdfPage.render({canvas:element,canvasContext:element.getContext('2d')!,viewport})
   currentRender.current=render
   await render.promise
   if(!cancelled)setRendered({doc,page})
  }catch(e){if(!cancelled&&(e as Error).name!=='RenderingCancelledException')setError('Не удалось отобразить страницу.')}
  finally{if(render&&currentRender.current===render)currentRender.current=null}})()
  return()=>{cancelled=true;render?.cancel()}
 },[doc,page])
 const point=(e:React.PointerEvent<HTMLDivElement>)=>{const rect=e.currentTarget.getBoundingClientRect();return {x:Math.max(0,Math.min(rect.width,e.clientX-rect.left)),y:Math.max(0,Math.min(rect.height,e.clientY-rect.top))}}
 const insert=async(partial:boolean)=>{const source=canvas.current;if(!source||!ready)return;setBusy(true);try{let result=source;if(partial&&selection){const rect=source.getBoundingClientRect();const scaleX=source.width/rect.width,scaleY=source.height/rect.height;result=document.createElement('canvas');result.width=Math.max(1,Math.round(selection.w*scaleX));result.height=Math.max(1,Math.round(selection.h*scaleY));result.getContext('2d')?.drawImage(source,selection.x*scaleX,selection.y*scaleY,result.width,result.height,0,0,result.width,result.height)}const blob=await new Promise<Blob|null>(resolve=>result.toBlob(resolve,'image/png'));if(!blob)throw new Error('Не удалось обработать изображение');await onInsert(blob);setError('');setCrop(false);setSelection(null)}catch{setError('Не удалось вставить страницу на доску.')}finally{setBusy(false)}}
 const changePage=(next:number)=>{setPage(next);onPageChange?.(next)}
 return <><div className="pdf-toolbar"><button title="Предыдущая страница" disabled={page<=1} onClick={()=>changePage(page-1)}><ChevronLeft size={16}/></button><span>{doc?`${page} / ${doc.numPages}`:'Загрузка…'}</span><button title="Следующая страница" disabled={!doc||page>=doc.numPages} onClick={()=>changePage(page+1)}><ChevronRight size={16}/></button><div className="pdf-spacer"/><button title="Вырезать фрагмент" className={crop?'active':''} disabled={!ready} onClick={()=>{setCrop(!crop);setSelection(null)}}><Scissors size={16}/></button><button title="Добавить страницу на доску" disabled={!ready||busy} onClick={()=>void insert(false)}><Pin size={16}/></button></div><div className="pdf-scroll">{error&&<div className="pdf-error">{error}</div>}{doc&&!ready&&!error&&<div className="pdf-loading" role="status">Страница загружается…</div>}<div className={'pdf-page '+(crop&&ready?'cropping':'')} aria-busy={!ready} onPointerDown={e=>{if(!crop||!ready)return;e.currentTarget.setPointerCapture(e.pointerId);start.current=point(e);setSelection(null)}} onPointerMove={e=>{if(!start.current)return;const p=point(e),s=start.current;setSelection({x:Math.min(s.x,p.x),y:Math.min(s.y,p.y),w:Math.abs(p.x-s.x),h:Math.abs(p.y-s.y)})}} onPointerUp={()=>{start.current=null}}><canvas ref={canvas}/>{selection&&<div className="crop-selection" style={{left:selection.x,top:selection.y,width:selection.w,height:selection.h}}/>}</div></div>{crop&&<div className="crop-actions"><span>{selection&&selection.w>5&&selection.h>5?'Фрагмент выделен':'Выделите область на странице'}</span><button disabled={!ready||!selection||selection.w<5||selection.h<5||busy} onClick={()=>void insert(true)}>На доску</button></div>}</>
}

