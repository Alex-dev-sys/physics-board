'use client'
import { useEffect, useState } from 'react'
import { Tldraw, type Editor } from 'tldraw'
import { CloudCanvas } from '../cloud/canvas'
import { createCloudRoom, initializeCloudRoom } from '../cloud/rooms'

export default function CloudTestPage(){
 const [editor,setEditor]=useState<Editor|null>(null),[token,setToken]=useState<string|null>(null),[status,setStatus]=useState('local'),[error,setError]=useState('')
 useEffect(()=>{setToken(new URLSearchParams(location.hash.slice(1)).get('cloud'))},[])
 const mount=(value:Editor)=>{setEditor(value);(window as unknown as {testEditor:Editor}).testEditor=value}
 if(process.env.NODE_ENV!=='development')return null
 const create=async()=>{
  if(!editor)return
  const snapshot=editor.store.getStoreSnapshot()
  const room=await createCloudRoom(snapshot)
  await initializeCloudRoom(room.id,snapshot)
  location.hash='cloud='+room.token
  setToken(room.token)
 }
 return <><div style={{position:'fixed',top:0,left:0,zIndex:1000,display:'flex',gap:8,background:'white',color:'black',padding:8}}><button onClick={()=>void create().catch(e=>setError(e.message))}>Создать облачную комнату</button><button onClick={()=>editor?.createShape({type:'geo',x:200,y:200,props:{geo:'rectangle',w:120,h:80}})}>Добавить фигуру</button><span data-testid="status">{status}</span><span role="alert">{error}</span></div><div style={{position:'fixed',inset:0}}>{token?<CloudCanvas key={token} token={token} onMount={mount} onStatus={setStatus} onReady={()=>{}}/>:<Tldraw hideUi onMount={mount}/>}</div></>
}
