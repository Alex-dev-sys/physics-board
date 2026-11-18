import * as Y from 'yjs'
import { AssetRecordType, createShapeId, type TLRecord, type TLStore } from '@tldraw/tlschema'
import { getIndexAbove } from '@tldraw/utils'
import type { TLStoreSnapshot } from 'tldraw'
import { createBoardSchema } from '../pdf-schema.mjs'
import { createPdfAsset, pdfMimeType, pdfWidth } from '../pdf-assets'
import { isSharedMaterial, type SharedMaterial } from './material-data'

type LegacyRecord = { key: string; val: TLRecord }
type FieldValue = [unknown] | []
const delimiter = '\u001f'
const schema = createBoardSchema()
const recordRoots = new Set(['tl_records', 'tl_base', 'tl_fields'])
const validFields = new Set(['x', 'y', 'rotation', 'index', 'parentId', 'opacity', 'isLocked', 'name', 'fromId', 'toId', 'gridSize'])
const pdfMigration = Symbol('pdf-migration')

function recordMaps(doc: Y.Doc) {
 return {
  legacy: doc.getArray<LegacyRecord>('tl_records'),
  base: doc.getMap<TLRecord | null>('tl_base'),
  fields: doc.getMap<FieldValue>('tl_fields'),
 }
}

function setField(target: Record<string, unknown>, key: string, value: FieldValue) {
 if (value.length) target[key] = value[0]
 else delete target[key]
}

export function readCloudRecords(doc: Y.Doc): TLStoreSnapshot['store'] {
 const { legacy, base, fields } = recordMaps(doc)
 const records = new Map<string, TLRecord>()
 for (const { key, val } of legacy) {
  if (!val || key !== val.id) throw new Error('Invalid legacy record')
  records.set(key, val)
 }
 for (const [id, record] of base) {
  if (record === null) records.delete(id)
  else {
   if (!record || record.id !== id) throw new Error('Invalid board record')
   records.set(id, record)
  }
 }

 const changes = new Map<string, Record<string, unknown>>()
 for (const [key, value] of fields) {
  const [id, field, property, ...rest] = key.split(delimiter)
  const nested = field === 'props' || field === 'meta'
  if (!id || rest.length || (nested ? !property : property !== undefined || !validFields.has(field)) ||
   ['__proto__', 'constructor', 'prototype'].includes(property) ||
   !Array.isArray(value) || value.length > 1) throw new Error('Invalid record field')
  const record = records.get(id)
  if (!record) continue
  const updated = changes.get(id) ?? { ...record }
  if (nested) {
   const properties = { ...(updated[field] as Record<string, unknown>) }
   setField(properties, property, value)
   updated[field] = properties
  } else setField(updated, field, value)
  changes.set(id, updated)
 }
 for (const [id, record] of changes) records.set(id, record as unknown as TLRecord)
 return Object.fromEntries(records) as TLStoreSnapshot['store']
}

export function validateCloudRecords(records: TLStoreSnapshot['store']) {
 for (const [id, record] of Object.entries(records)) {
  const type = Object.hasOwn(schema.types, record.typeName) && schema.types[record.typeName]
  if (!type || type.scope !== 'document' || !type.isId(id)) throw new Error('Invalid board record type')
  type.validate(record)
 }
}

export function seedCloudDocument(doc: Y.Doc, snapshot: TLStoreSnapshot) {
 const migrated = schema.migrateStoreSnapshot(snapshot)
 if (migrated.type !== 'success') throw new Error('Не удалось открыть формат доски')
 validateCloudRecords(migrated.value)
 const { base } = recordMaps(doc)
 doc.transact(() => {
  for (const record of Object.values(migrated.value)) base.set(record.id, record)
 }, 'seed')
}

export function validateCloudDocument(doc: Y.Doc, allowEmpty = false) {
 for (const name of doc.share.keys()) {
  if (!recordRoots.has(name) && name !== 'materials') throw new Error('Unknown board data')
 }
 const records = readCloudRecords(doc)
 validateCloudRecords(records)
 if (!allowEmpty || Object.keys(records).length) {
  if (records['document:document']?.typeName !== 'document' ||
   !Object.values(records).some(record => record.typeName === 'page')) throw new Error('Missing board document')
 }
 return records
}

export function moveLegacyPdfsToBoard(doc: Y.Doc, roomId: string) {
 const materials = doc.getMap('materials')
 const pdfs = [...materials.values()].filter((value): value is SharedMaterial => isSharedMaterial(value, roomId) && value.type === pdfMimeType)
 if (!pdfs.length) return
 const records = readCloudRecords(doc)
 const page = Object.values(records).find(record => record.typeName === 'page')
 if (page?.typeName !== 'page') return
 let topIndex = Object.values(records).flatMap(record => record.typeName === 'shape' && record.parentId === page.id ? [record.index] : []).sort().pop()
 const { base } = recordMaps(doc)
 doc.transact(() => {
  pdfs.sort((a, b) => a.id.localeCompare(b.id)).forEach((material, offset) => {
   const id = createShapeId(`pdf-${material.id}`)
   const asset = createPdfAsset(material.name, `asset:cloud/${material.path}`, AssetRecordType.createId(`pdf-${material.id}`))
   if (!base.has(id) && !records[id]) {
    topIndex = getIndexAbove(topIndex)
    const shape = schema.types.shape.create({
     id, type: 'pdf', parentId: page.id, index: topIndex, x: 230 + offset * 24, y: 330 + offset * 24,
     props: { assetId: asset.id, page: material.page, w: pdfWidth, h: 0, compact: false },
    })
    base.set(asset.id, asset)
    base.set(id, shape)
   }
   materials.delete(material.id)
  })
 }, pdfMigration)
}

function writeFields(fields: Y.Map<FieldValue>, before: TLRecord, after: TLRecord) {
 const previous = before as unknown as Record<string, unknown>
 const current = after as unknown as Record<string, unknown>
 const write = (key: string, oldValue: unknown, value: unknown) => {
  if (!Object.is(oldValue, value)) fields.set(key, value === undefined ? [] : [value])
 }
 for (const field of new Set([...Object.keys(previous), ...Object.keys(current)])) {
  const key = after.id + delimiter + field
  if ((field === 'props' || field === 'meta') && previous[field] !== current[field]) {
   const oldProps = previous[field] as Record<string, unknown> ?? {}
   const newProps = current[field] as Record<string, unknown> ?? {}
   for (const property of new Set([...Object.keys(oldProps), ...Object.keys(newProps)])) {
    write(key + delimiter + property, oldProps[property], newProps[property])
   }
  } else if (validFields.has(field)) write(key, previous[field], current[field])
 }
}

/** Bind collaborative document records while leaving session and presence local. */
export function bindCloudStore(doc: Y.Doc, store: TLStore): () => void {
 const { legacy, base, fields } = recordMaps(doc)
 const storeSnapshot = validateCloudDocument(doc)
 store.loadStoreSnapshot({ store: storeSnapshot, schema: schema.serialize() })

 const unsubscribe = store.listen(({ changes }) => {
  doc.transact(() => {
   const replaced = new Set([...Object.keys(changes.added), ...Object.keys(changes.removed)])
   if (replaced.size) {
    for (const key of fields.keys()) {
     if (replaced.has(key.split(delimiter, 1)[0])) fields.delete(key)
    }
   }
   for (const record of Object.values(changes.added)) {
    base.set(record.id, record)
   }
   for (const [before, after] of Object.values(changes.updated)) {
    writeFields(fields, before, after)
   }
   for (const record of Object.values(changes.removed)) {
    base.set(record.id, null)
   }
  }, 'tldraw')
 }, { source: 'user', scope: 'document' })

 const apply = (transaction: Y.Transaction) => {
  if (transaction.local && transaction.origin !== pdfMigration) return
  const baseChanges = transaction.changed.get(base)
  const fieldChanges = transaction.changed.get(fields)
  const legacyChanged = transaction.changed.has(legacy)
  if (!baseChanges && !fieldChanges && !legacyChanged) return
  const records = readCloudRecords(doc)
  const ids = new Set([
   ...baseChanges ?? [],
   ...Array.from(fieldChanges ?? [], key => key.split(delimiter, 1)[0]),
   ...legacyChanged ? [...Object.keys(records), ...Object.keys(store.getStoreSnapshot().store)] : [],
  ]) as Set<TLRecord['id']>
  const put: TLRecord[] = []
  const remove: TLRecord['id'][] = []
  for (const id of ids) {
   if (records[id]) put.push(records[id])
   else if (store.has(id)) remove.push(id)
  }
  validateCloudRecords(Object.fromEntries(put.map(record => [record.id, record])))
  store.mergeRemoteChanges(() => {
   if (remove.length) store.remove(remove)
   if (put.length) store.put(put)
  })
 }
 doc.on('afterTransaction', apply)
 return () => {
  store._flushHistory()
  unsubscribe()
  doc.off('afterTransaction', apply)
 }
}
