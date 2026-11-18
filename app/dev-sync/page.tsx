'use client'
import { useEffect, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import { SyncCanvas, createLocalRoom } from '../sync-canvas'

// This route exists only to exercise the local sync implementation during development.
export default function SyncTestPage(){
 const [editor,setEditor]=useState<Editor|null>(null),[token,setToken]=useState<string|null>(null),[error,setError]=useState('')
 useEffect(()=>{setToken(new URLSearchParams(location.hash.slice(1)).get('room'))},[])
 const mount=(value:Editor)=>{setEditor(value);(window as unknown as {testEditor:Editor}).testEditor=value}
 if(process.env.NODE_ENV!=='development')return null
 return <><div style={{position:'fixed',top:0,left:0,zIndex:1000,display:'flex',gap:8,background:'white',color:'black',padding:8}}><button onClick={()=>{if(editor)void createLocalRoom(editor).then(id=>{location.hash=`room=${id}`;setToken(id)}).catch(e=>setError(e.message))}}>Создать комнату</button><button onClick={()=>editor?.createShape({type:'geo',x:200,y:200,props:{geo:'rectangle',w:120,h:80}})}>Добавить фигуру</button><button onClick={()=>{const canvas=document.createElement('canvas');canvas.width=40;canvas.height=40;const context=canvas.getContext('2d')!;context.fillStyle='#f00';context.fillRect(0,0,40,40);canvas.toBlob(blob=>{if(blob&&editor)void editor.putExternalContent({type:'files',files:[new File([blob],'test.png',{type:'image/png'})]})})}}>Добавить изображение</button><span>{token?'Общая доска':'Локальная доска'}</span><span role="alert">{error}</span></div><div style={{position:'fixed',inset:0}}>{token?<SyncCanvas token={token} onMount={mount}/>:<Tldraw hideUi onMount={mount}/>}</div></>
}

