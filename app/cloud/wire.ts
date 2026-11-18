import * as Y from 'yjs'

export const updatePartSize = 512 * 1024
export const maxUpdateParts = 64
export const maxUpdateSize = updatePartSize * maxUpdateParts
export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function encodeUpdate(bytes: Uint8Array): string {
 let binary = ''
 for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
 return btoa(binary)
}

export function decodeUpdate(payload: string): Uint8Array {
 const binary = atob(payload)
 const bytes = new Uint8Array(binary.length)
 for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
 return bytes
}

export function unsavedUpdate(local: Y.Doc, remote: Y.Doc): Uint8Array | null {
 const target = Y.snapshot(remote)
 const source = Y.snapshot(local)
 if (Y.equalSnapshots(source, target)) return null

 const update = Y.encodeStateAsUpdate(local, Y.encodeStateVector(remote))
 // V1 updates end with the same deletion encoding as a V1 snapshot.
 // Remove ranges the server already has, including when just a deletion changed.
 const deletions = Y.createDeleteSet()
 for (const [client, ranges] of source.ds.clients) {
  const known = target.ds.clients.get(client) ?? []
  const missing = []
  let index = 0
  for (const { clock, len } of ranges) {
   let start = clock
   const end = clock + len
   while (index < known.length && known[index].clock + known[index].len <= start) index++
   while (index < known.length && known[index].clock < end && start < end) {
    const range = known[index]
    if (range.clock > start) missing.push({ clock: start, len: range.clock - start })
    start = range.clock + range.len
    if (start <= end) index++
   }
   if (start < end) missing.push({ clock: start, len: end - start })
  }
  if (missing.length) deletions.clients.set(client, missing)
 }

 const oldTail = Y.encodeSnapshot(Y.createSnapshot(source.ds, new Map())).subarray(0, -1)
 const tail = Y.encodeSnapshot(Y.createSnapshot(deletions, new Map())).subarray(0, -1)
 const head = update.subarray(0, update.length - oldTail.length)
 if (head.length === 1 && head[0] === 0 && !deletions.clients.size) return null
 const result = new Uint8Array(head.length + tail.length)
 result.set(head)
 result.set(tail, head.length)
 return result
}
