import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, createReadStream, writeFileSync, renameSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { WebSocketServer } from 'ws'
import { NodeSqliteWrapper, SQLiteSyncStorage, TLSocketRoom } from '@tldraw/sync-core'
import { createBoardSchema } from '../app/pdf-schema.mjs'

// This single-process server is for local development. It binds to loopback only.
const root = resolve(process.env.BOARD_ROOM_DIR || '.rooms')
const port = Number(process.env.BOARD_SYNC_PORT || 5858)
const appOrigin = process.env.BOARD_APP_ORIGIN || 'http://localhost:3000'
mkdirSync(root, { recursive: true })
const rooms = new Map()
const tokenOk = token => /^[a-f0-9]{64}$/.test(token || '')
const roomKey = token => createHash('sha256').update(token).digest('hex')
const roomPath = token => join(root, `${roomKey(token)}.sqlite`)
const assetDir = token => join(root, `${roomKey(token)}-assets`)

function loadRoom(token) {
  const key = roomKey(token)
  if (rooms.has(key)) return rooms.get(key).room
  const db = new DatabaseSync(roomPath(token))
  try {
    const storage = new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db) })
    const room = new TLSocketRoom({
      storage,
      schema: createBoardSchema(),
      onSessionRemoved(current, { numSessionsRemaining }) {
        if (numSessionsRemaining === 0) {
          current.close()
          db.close()
          rooms.delete(key)
        }
      },
    })
    rooms.set(key, { room, db })
    return room
  } catch (error) {
    db.close()
    throw error
  }
}
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('too_large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
const server = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true })
  // Browsers omit Origin on ordinary <img> requests. The unguessable room
  // capability is still required; all mutating requests must have our origin.
  if (req.headers.origin !== appOrigin && !(req.method === 'GET' && !req.headers.origin)) return reply(res, 403, { error: 'origin' })
  res.setHeader('Access-Control-Allow-Origin', appOrigin)
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Vary', 'Origin')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  const path = new URL(req.url, 'http://localhost').pathname.split('/').filter(Boolean)
  const token = path[1]
  if (!tokenOk(token)) return reply(res, 400, { error: 'invalid_room' })
  try {
    if (path[0] === 'rooms' && path.length === 2 && req.method === 'POST') {
      const snapshot = JSON.parse((await readBody(req, 12 * 1024 * 1024)).toString('utf8'))
      if (!snapshot?.store || !snapshot?.schema) return reply(res, 400, { error: 'invalid_snapshot' })
      const file = roomPath(token)
      if (existsSync(file)) return reply(res, 409, { error: 'room_exists' })
      const temporary = file + '.' + randomUUID() + '.tmp'
      try {
        const db = new DatabaseSync(temporary)
        try {
          new SQLiteSyncStorage({ sql: new NodeSqliteWrapper(db), snapshot })
        } finally {
          db.close()
        }
        renameSync(temporary, file)
      } finally {
        rmSync(temporary, { force: true })
      }
      return reply(res, 201, { ok: true })
    }
    if (path[0] === 'assets' && path.length === 3 && /^[a-f0-9]{32}$/.test(path[2])) {
      if (!existsSync(roomPath(token))) return reply(res, 404, { error: 'room_not_found' })
      const dir = assetDir(token), file = join(dir, path[2])
      if (req.method === 'PUT') {
        const type = (req.headers['content-type'] || '').split(';')[0]
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'].includes(type)) return reply(res, 415, { error: 'unsupported_type' })
        const data = await readBody(req, 10 * 1024 * 1024)
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, data, { flag: 'wx' })
        writeFileSync(`${file}.type`, type, { flag: 'wx' })
        return reply(res, 201, { ok: true })
      }
      if (req.method === 'GET' && existsSync(file) && existsSync(`${file}.type`)) {
        const { readFileSync } = await import('node:fs')
        res.writeHead(200, { 'Content-Type': readFileSync(`${file}.type`, 'utf8'), 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=31536000, immutable' })
        createReadStream(file).pipe(res)
        return
      }
    }
    reply(res, 404, { error: 'not_found' })
  } catch (error) {
    console.error('sync request failed:', error.message)
    if (!res.headersSent) reply(res, error.message === 'too_large' ? 413 : 500, { error: 'request_failed' })
  }
})
const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const parts = url.pathname.split('/').filter(Boolean)
  const token = parts[1], sessionId = url.searchParams.get('sessionId')
  if (req.headers.origin !== appOrigin || parts[0] !== 'connect' || parts.length !== 2 || !tokenOk(token) || !sessionId || sessionId.length > 128 || !existsSync(roomPath(token))) {
    socket.destroy(); return
  }
  wss.handleUpgrade(req, socket, head, ws => {
    try { loadRoom(token).handleSocketConnect({ sessionId, socket: ws }) }
    catch (error) { console.error('sync connection failed:', error.message); ws.close(1011) }
  })
})
server.listen(port, '127.0.0.1', () => console.log(`Local sync server listening on 127.0.0.1:${port}`))
