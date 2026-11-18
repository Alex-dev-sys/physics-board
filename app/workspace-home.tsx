'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Cloud, Link2, Pencil, Plus, Presentation, UserRound, X } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { boardHref, createPersonalBoard, editorPath, invitationHref, listBoards, nameLimit, readBoard, readProfileName, roomToken, saveBoard, saveProfileName, type WorkspaceBoard } from './workspace-data'
import styles from './workspace-home.module.css'

type Action = { type: 'create' | 'join' | 'profile' } | { type: 'rename'; id: string }

const fields = {
 create: { title: 'Новая доска', label: 'Название доски', submit: 'Создать' },
 join: { title: 'Открыть по ссылке', label: 'Ссылка на доску', submit: 'Открыть' },
 profile: { title: 'Профиль', label: 'Имя', submit: 'Сохранить' },
 rename: { title: 'Переименовать доску', label: 'Название доски', submit: 'Сохранить' },
}

export function WorkspaceHome() {
 const router = useRouter()
 const dialog = useRef<HTMLDialogElement>(null)
 const [boards, setBoards] = useState<WorkspaceBoard[] | null>(null)
 const [name, setName] = useState('')
 const [action, setAction] = useState<Action | null>(null)
 const [value, setValue] = useState('')
 const [error, setError] = useState('')

 useEffect(() => {
  const followLegacyLink = () => {
   const { hash, search } = window.location
   const hasRoom = roomToken(hash) || process.env.NODE_ENV === 'development' && roomToken(hash, 'room')
   if (!hasRoom && !new URLSearchParams(search).has('pdf')) return false
   router.replace(editorPath + search + hash)
   return true
  }
  if (followLegacyLink()) return
  const refresh = () => {
   setBoards(listBoards())
   setName(readProfileName())
  }
  refresh()
  window.addEventListener('storage', refresh)
  window.addEventListener('focus', refresh)
  window.addEventListener('pageshow', refresh)
  window.addEventListener('hashchange', followLegacyLink)
  return () => {
   window.removeEventListener('storage', refresh)
   window.removeEventListener('focus', refresh)
   window.removeEventListener('pageshow', refresh)
   window.removeEventListener('hashchange', followLegacyLink)
  }
 }, [router])

 useEffect(() => {
  const element = dialog.current
  if (action && element && !element.open) {
   element.showModal()
   element.querySelector('input')?.focus()
  }
 }, [action])

 function open(next: Action, initialValue = '') {
  setValue(initialValue)
  setError('')
  setAction(next)
 }

 function submit(event: FormEvent<HTMLFormElement>) {
  event.preventDefault()
  if (!action) return
  const input = value.trim()
  if (!input) return
  try {
   switch (action.type) {
    case 'create':
     router.push(boardHref(createPersonalBoard(input)))
     break
    case 'join': {
     const href = invitationHref(input, window.location.origin)
     if (!href) {
      setError('Вставьте ссылку на совместную доску этого сайта.')
      return
     }
     router.push(href)
     break
    }
    case 'rename': {
     const board = readBoard(action.id)
     if (board) saveBoard({ ...board, title: input })
     setBoards(listBoards())
     break
    }
    case 'profile':
     saveProfileName(input)
     setName(input)
     break
   }
   dialog.current?.close()
  } catch {
   setError('Не удалось сохранить данные в браузере.')
  }
 }

 const field = action && fields[action.type]
 return <div className={styles.page}>
  <header className={styles.header}>
   <div className={styles.headerInner}>
    <span className={styles.brand}><span className={styles.mark} aria-hidden="true">φ</span>Физика</span>
    {boards && <button type="button" className={styles.profile} aria-label={name ? `Профиль ${name}` : 'Профиль'} onClick={() => open({ type: 'profile' }, name)}>
     <span className={styles.avatar} aria-hidden="true">{name ? Array.from(name)[0].toLocaleUpperCase('ru') : <UserRound size={18}/>}</span>
     <span className={styles.profileName}>{name || 'Профиль'}</span>
    </button>}
   </div>
  </header>
  <main className={styles.content} aria-busy={!boards}>
   {boards && <>
    <div className={styles.heading}>
     <h1>Мои доски</h1>
     <div className={styles.actions}>
      <button type="button" className={styles.secondary} onClick={() => open({ type: 'join' })}><Link2 size={17} aria-hidden="true"/>По ссылке</button>
      <button type="button" className={styles.primary} onClick={() => open({ type: 'create' })}><Plus size={19} aria-hidden="true"/>Новая доска</button>
     </div>
    </div>
    <ul className={styles.boards}>
     {boards.map(board => <li key={board.id} className={styles.card}>
      <Link href={boardHref(board)} className={styles.cardLink}>
       <span className={styles.cover} data-kind={board.kind} aria-hidden="true">
        <span>{board.kind === 'cloud' ? <Cloud size={24}/> : <Presentation size={24}/>}</span>
       </span>
       <div className={styles.cardInfo}>
        <h2>{board.title}</h2>
        <span>{board.kind === 'cloud' ? 'Совместная' : 'Личная'}</span>
       </div>
      </Link>
      <button type="button" className={styles.rename} aria-label={`Переименовать «${board.title}»`} title="Переименовать" onClick={() => open({ type: 'rename', id: board.id }, board.title)}><Pencil size={16} aria-hidden="true"/></button>
     </li>)}
    </ul>
   </>}
  </main>
  <dialog ref={dialog} className={styles.dialog} aria-labelledby="workspace-dialog-title" onClose={() => setAction(null)}>
   {field && <form onSubmit={submit}>
    <div className={styles.dialogHeading}>
     <h2 id="workspace-dialog-title">{field.title}</h2>
     <button type="button" className={styles.iconButton} aria-label="Закрыть" onClick={() => dialog.current?.close()}><X size={20}/></button>
    </div>
    {action?.type === 'profile' && <p className={styles.profileNote}>Имя сохраняется в этом браузере и отображается рядом с вашим курсором на совместных досках.</p>}
    <label className={styles.field}>
     {field.label}
     <input required value={value} maxLength={action?.type === 'join' ? 2048 : nameLimit} placeholder={action?.type === 'join' ? 'https://…' : undefined}
      onChange={event => { setValue(event.target.value); setError('') }} aria-invalid={Boolean(error)} aria-describedby={error ? 'workspace-dialog-error' : undefined}/>
    </label>
    {error && <p id="workspace-dialog-error" className={styles.error} role="alert">{error}</p>}
    <div className={styles.dialogActions}>
     <button type="button" className={styles.secondary} onClick={() => dialog.current?.close()}>Отмена</button>
     <button type="submit" className={styles.primary} disabled={!value.trim()}>{field.submit}</button>
    </div>
   </form>}
  </dialog>
 </div>
}
