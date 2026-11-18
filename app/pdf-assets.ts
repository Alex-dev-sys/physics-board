import { AssetRecordType, type TLAsset, type TLAssetId, type TLBookmarkAsset, type TLShape, type TLStoreSnapshot } from '@tldraw/tlschema'
import type { pdfShapeProps } from './pdf-schema.mjs'

type PdfProps = { [K in keyof typeof pdfShapeProps]: ReturnType<(typeof pdfShapeProps)[K]['validate']> }

declare module '@tldraw/tlschema' {
 interface TLGlobalShapePropsMap {
  pdf: PdfProps
 }
}

export type PdfShape = Extract<TLShape, { type: 'pdf' }>
export const pdfMimeType = 'application/pdf'
export const pdfWidth = 360

// tldraw stores non-visual file references as URL assets. The PDF bytes use
// the same IndexedDB or room-storage service as the editor's other files.
export function createPdfAsset(name: string, src: string | null, id: TLAssetId = AssetRecordType.createId()): TLBookmarkAsset {
 return {
  id, typeName: 'asset', type: 'bookmark',
  props: { title: name, description: '', favicon: '', image: '', src },
  meta: { mimeType: pdfMimeType },
 }
}

export function isPdfAsset(asset: TLAsset | undefined): asset is TLBookmarkAsset {
 return asset?.type === 'bookmark' && asset.meta.mimeType === pdfMimeType
}

export function isPdfFile(file: File) {
 return file.type === pdfMimeType || ((!file.type || file.type === 'application/octet-stream') && /\.pdf$/i.test(file.name))
}

export function removeUnusedPdfAssets({ store }: TLStoreSnapshot) {
 const ids = new Set(Object.values(store).flatMap(record => record.typeName === 'shape' && record.type === 'pdf' ? [record.props.assetId] : []))
 for (const record of Object.values(store)) {
  if (record.typeName === 'asset' && isPdfAsset(record) && !ids.has(record.id)) delete store[record.id]
 }
}
