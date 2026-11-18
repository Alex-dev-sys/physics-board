export const editorPath = '/board'
export const defaultBoardId = 'default'
export const sharedBoardTitle = 'Совместная доска'
export const nameLimit = 64

export type WorkspaceBoard = {
 id: string
 kind: 'personal' | 'cloud'
 title: string
 openedAt: number
}

export const defaultBoard: WorkspaceBoard = { id: defaultBoardId, kind: 'personal', title: 'Доска по физике', openedAt: 0 }
const boardsPrefix = 'physics-board.workspace.v1.board.'
const legacyRoomsPrefix = 'physics-board-room-'
const profileKey = 'physics-board.workspace.v1.name'
const personalId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const roomId = /^[a-f0-9]{64}$/

export function readBoard(id: string): WorkspaceBoard | null {
 try {
  const value = localStorage.getItem(boardsPrefix + id)
  if (value) {
   const board: WorkspaceBoard = JSON.parse(value)
   if (board?.id === id && typeof board.title === 'string' && board.title.trim() && board.title.length <= nameLimit &&
    Number.isFinite(board.openedAt) && (board.kind === 'personal' && (id === defaultBoardId || personalId.test(id)) ||
     board.kind === 'cloud' && roomId.test(id))) return board
  }
  if (roomId.test(id) && personalId.test(localStorage.getItem(legacyRoomsPrefix + id) ?? '')) {
   return { id, kind: 'cloud', title: sharedBoardTitle, openedAt: 0 }
  }
 } catch { /* An unavailable or corrupt entry cannot appear in the workspace. */ }
 return id === defaultBoardId ? defaultBoard : null
}

export function listBoards(): WorkspaceBoard[] {
 const boards = new Map([[defaultBoardId, readBoard(defaultBoardId) ?? defaultBoard]])
 try {
  for (let i = 0; i < localStorage.length; i++) {
   const key = localStorage.key(i)
   const prefix = [boardsPrefix, legacyRoomsPrefix].find(prefix => key?.startsWith(prefix))
   if (!prefix) continue
   const id = key.slice(prefix.length)
   if (boards.has(id)) continue
   const board = readBoard(id)
   if (board) boards.set(id, board)
  }
 } catch { /* The original board remains accessible when storage is unavailable. */ }
 return [...boards.values()].sort((a, b) => b.openedAt - a.openedAt)
}

export function saveBoard(board: WorkspaceBoard) {
 localStorage.setItem(boardsPrefix + board.id, JSON.stringify(board))
}

export function createPersonalBoard(title: string): WorkspaceBoard {
 const board: WorkspaceBoard = { id: crypto.randomUUID(), kind: 'personal', title, openedAt: Date.now() }
 saveBoard(board)
 return board
}

export function markBoardOpened(board: Omit<WorkspaceBoard, 'openedAt'>) {
 try {
  saveBoard({ ...(readBoard(board.id) ?? board), openedAt: Date.now() })
 } catch { /* The board stays open if the recent list cannot be saved. */ }
}

export function readProfileName(): string {
 try { return localStorage.getItem(profileKey)?.trim().slice(0, nameLimit) ?? '' } catch { return '' }
}

export function saveProfileName(name: string) {
 localStorage.setItem(profileKey, name)
}

export function boardHref(board: WorkspaceBoard): string {
 if (board.kind === 'cloud') return `${editorPath}#cloud=${board.id}`
 return board.id === defaultBoardId ? editorPath : `${editorPath}?id=${board.id}`
}

export function roomToken(hash: string, kind: 'cloud' | 'room' = 'cloud'): string | null {
 const token = new URLSearchParams(hash.slice(1)).get(kind)
 return token && roomId.test(token) ? token : null
}

export function invitationHref(input: string, origin: string): string | null {
 try {
  const url = new URL(input, origin)
  const token = roomToken(url.hash)
  if (!token || url.origin !== origin || (url.pathname !== '/' && url.pathname !== editorPath)) return null
  const params = new URLSearchParams()
  const pdf = url.searchParams.get('pdf')
  if (pdf) params.set('pdf', pdf)
  return editorPath + (params.size ? '?' + params : '') + '#cloud=' + token
 } catch {
  return null
 }
}
