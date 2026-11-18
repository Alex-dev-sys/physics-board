import type { Editor, TLRecord } from 'tldraw'
// @ts-expect-error tldraw 4.5.12 exports this class at runtime but omits its internal API from declarations.
import { LocalIndexedDb } from 'tldraw'

export function watchPersonalBoard(editor: Editor, persistenceKey: string) {
 let touched = new Map<TLRecord['id'], TLRecord>()
 const stop = editor.store.listen(({ changes }) => {
  for (const record of Object.values(changes.added)) touched.set(record.id, record)
  for (const [, record] of Object.values(changes.updated)) touched.set(record.id, record)
  for (const record of Object.values(changes.removed)) touched.set(record.id, record)
 }, { scope: 'document', source: 'user' })
 let saving: Promise<void> | undefined

 async function flush() {
  editor.store._flushHistory()
  if (saving) {
   await saving
   return flush()
  }
  if (!touched.size) return

  // tldraw's autosave is throttled and stops when the editor unmounts.
  // Write the touched records to its existing database before leaving the page.
  const batch = touched
  touched = new Map()
  const added: Record<string, TLRecord> = {}
  const removed: Record<string, TLRecord> = {}
  for (const [id, previous] of batch) {
   const record = editor.store.get(id)
   if (record) added[id] = record
   else removed[id] = previous
  }
  const db = new LocalIndexedDb(persistenceKey)
  saving = (async () => {
   try {
    await db.storeChanges({ changes: { added, updated: {}, removed }, schema: editor.store.schema })
   } catch (error) {
    for (const [id, record] of batch) {
     if (!touched.has(id)) touched.set(id, record)
    }
    throw error
   } finally {
    await db.close()
   }
  })()
  try { await saving } finally { saving = undefined }
 }

 return {
  flush,
  dispose() {
   void flush().catch(error => console.error('Could not save the local board', error))
   stop()
  },
 }
}
