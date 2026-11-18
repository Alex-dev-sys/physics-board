'use client'

import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Copy, Download, File as FileIcon, FileText, Link2, LoaderCircle, MoreHorizontal, PanelTop, Scan, Trash2 } from 'lucide-react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { AssetRecordType, BaseBoxShapeUtil, createShapeId, HTMLContainer, Rectangle2d, useEditor, useValue, type Editor, type VecLike } from 'tldraw'
import { createPdfAsset, isPdfAsset, pdfMimeType, pdfWidth, type PdfShape } from './pdf-assets'
import { pdfCardHeight, pdfShapeProps } from './pdf-schema.mjs'

function displayHeight({ h, compact }: PdfShape['props']) {
 return compact || !h ? pdfCardHeight : h
}

export class PdfShapeUtil extends BaseBoxShapeUtil<PdfShape> {
 static override type = 'pdf' as const
 static override props = pdfShapeProps

 getDefaultProps(): PdfShape['props'] {
  return { w: pdfWidth, h: 0, assetId: AssetRecordType.createId('pdf'), page: 1, compact: false }
 }

 override isAspectRatioLocked() { return true }
 override canResize(shape: PdfShape) { return !shape.props.compact && shape.props.h > 0 }
 override hideSelectionBoundsBg(shape: PdfShape) { return !shape.props.h }
 override hideSelectionBoundsFg(shape: PdfShape) { return !shape.props.h }
 override getGeometry(shape: PdfShape) {
  return new Rectangle2d({ width: shape.props.w, height: displayHeight(shape.props), isFilled: true })
 }
 override getText(shape: PdfShape) {
  const asset = this.editor.getAsset(shape.props.assetId)
  return isPdfAsset(asset) ? asset.props.title : ''
 }
 override onDoubleClick(shape: PdfShape) {
  return { id: shape.id, type: 'pdf' as const, props: { compact: !shape.props.compact } }
 }
 override indicator(shape: PdfShape) {
  return shape.props.h ? <rect width={shape.props.w} height={displayHeight(shape.props)} rx={shape.props.compact ? 14 : 0}/> : null
 }
 component(shape: PdfShape) { return <PdfOnBoard shape={shape}/> }
}

export const pdfShapeUtils = [PdfShapeUtil]

export async function addPdfToBoard(editor: Editor, file: File, center: VecLike) {
 const asset = createPdfAsset(file.name, null)
 const id = createShapeId()
 const w = Math.min(pdfWidth, editor.getViewportPageBounds().width * 0.72)
 editor.markHistoryStoppingPoint('Добавить PDF')
 editor.run(() => {
  editor.createAssets([asset])
  editor.createShape<PdfShape>({ id, type: 'pdf', x: center.x - w / 2, y: center.y - pdfCardHeight / 2, props: { w, assetId: asset.id } })
  editor.setCurrentTool('select').select(id)
 })
 if (!editor.getShape(id)) return
 try {
  const source = file.type === pdfMimeType ? file : new File([file], file.name, { type: pdfMimeType })
  const { src } = await editor.uploadAsset(asset, source)
  if (!editor.isDisposed && editor.getAsset(asset.id)) editor.updateAssets([{ ...asset, props: { ...asset.props, src } }])
 } catch {
  if (!editor.isDisposed && editor.getAsset(asset.id)) editor.updateAssets([{ ...asset, meta: { ...asset.meta, uploadFailed: true } }])
  throw new Error(`Не удалось загрузить «${file.name}»`)
 }
}

type Area = { x: number; y: number; w: number; h: number }

function PdfOnBoard({ shape }: { shape: PdfShape }) {
 const editor = useEditor()
 const { id, props: { assetId, compact, h, w } } = shape
 const asset = useValue('PDF asset', () => editor.getAsset(assetId), [editor, assetId])
 const selected = useValue('PDF selection', () => editor.getOnlySelectedShapeId() === id && editor.getCurrentToolId() === 'select', [editor, id])
 const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
 const [rendered, setRendered] = useState<{ doc: PDFDocumentProxy; page: number; ratio: number } | null>(null)
 const [error, setError] = useState('')
 const [actionMessage, setActionMessage] = useState('')
 const [attempt, setAttempt] = useState(0)
 const [cropping, setCropping] = useState(false)
 const [area, setArea] = useState<Area | null>(null)
 const [busy, setBusy] = useState(false)
 const canvas = useRef<HTMLCanvasElement>(null)
 const currentRender = useRef<RenderTask | null>(null)
 const start = useRef<{ x: number; y: number } | null>(null)
 const pdf = isPdfAsset(asset) ? asset : null
 const name = pdf?.props.title || 'PDF'
 const page = Math.max(1, Math.min(shape.props.page, doc?.numPages ?? shape.props.page))
 const ready = !!doc && rendered?.doc === doc && rendered.page === page
 const status = error || (pdf?.meta.uploadFailed ? 'Не удалось загрузить PDF' : !pdf ? 'Файл недоступен' : !h || !doc ? 'Обрабатывается…' : '')

 useEffect(() => {
  let disposed = false
  let task: { destroy: () => Promise<void> } | undefined
  setDoc(null)
  setRendered(null)
  setError('')
  if (!pdf?.props.src) return
  void (async () => {
   try {
    const [url, library] = await Promise.all([editor.resolveAssetUrl(assetId, { shouldResolveToOriginal: true }), import('pdfjs-dist')])
    if (disposed) return
    if (!url) throw new Error()
    library.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const loading = library.getDocument({ url })
    task = loading
    const document = await loading.promise
    if (!disposed) setDoc(document)
   } catch {
    if (!disposed) setError('Не удалось открыть PDF')
   }
  })()
  return () => { disposed = true; void task?.destroy().catch(() => {}) }
 }, [editor, assetId, pdf?.props.src, attempt])

 useEffect(() => {
  setArea(null)
  setCropping(false)
  setActionMessage('')
 }, [selected, page, compact])

 useEffect(() => {
  if (!error) return
  const retry = () => setAttempt(value => value + 1)
  window.addEventListener('online', retry)
  return () => window.removeEventListener('online', retry)
 }, [error])

 useEffect(() => {
  if (!doc || !canvas.current || (compact && editor.getShape<PdfShape>(id)?.props.h)) return
  let disposed = false
  let render: RenderTask | undefined
  const target = canvas.current
  const previous = currentRender.current
  setRendered(null)
  setError('')
  void (async () => {
   try {
    if (previous) await previous.promise.catch(() => {})
    if (disposed) return
    const pdfPage = await doc.getPage(page)
    if (disposed) return
    const original = pdfPage.getViewport({ scale: 1 })
    // Bound both decoded memory and the PNG used by the board's image tool.
    const scale = Math.min(2, Math.sqrt(2_000_000 / (original.width * original.height)), 4096 / Math.max(original.width, original.height))
    const viewport = pdfPage.getViewport({ scale })
    target.width = Math.max(1, Math.ceil(viewport.width))
    target.height = Math.max(1, Math.ceil(viewport.height))
    render = pdfPage.render({ canvas: target, viewport })
    currentRender.current = render
    await render.promise
    if (disposed) return
    const ratio = original.height / original.width
    const current = editor.getShape<PdfShape>(id)
    if (current && !current.props.h) {
     const height = current.props.w * ratio
     editor.run(() => editor.updateShape<PdfShape>({ id, type: 'pdf', y: current.y + (pdfCardHeight - height) / 2, props: { h: height } }), { history: 'ignore' })
    }
    setRendered({ doc, page, ratio })
   } catch {
    if (!disposed) setError('Не удалось отобразить страницу')
   } finally {
    if (currentRender.current === render) currentRender.current = null
   }
  })()
  return () => { disposed = true; render?.cancel() }
 }, [editor, id, doc, page, compact])

 const update = (props: Partial<PdfShape['props']>) => editor.updateShape<PdfShape>({ id, type: 'pdf', props })
 const pageWidth = ready ? Math.min(w, h / rendered.ratio) : w
 const pageHeight = ready ? pageWidth * rendered.ratio : h
 const point = (event: PointerEvent) => {
  const local = editor.getPointInShapeSpace(shape, editor.screenToPage({ x: event.clientX, y: event.clientY }))
  return {
   x: Math.max(0, Math.min(pageWidth, local.x - (w - pageWidth) / 2)),
   y: Math.max(0, Math.min(pageHeight, local.y - (h - pageHeight) / 2)),
  }
 }
 const exportImage = async (crop?: Area) => {
  const source = canvas.current
  if (!ready || !source || busy) return
  setBusy(true)
  try {
   let image = source
   if (crop) {
    const sx = source.width / pageWidth, sy = source.height / pageHeight
    image = document.createElement('canvas')
    image.width = Math.max(1, Math.round(crop.w * sx))
    image.height = Math.max(1, Math.round(crop.h * sy))
    image.getContext('2d')?.drawImage(source, crop.x * sx, crop.y * sy, crop.w * sx, crop.h * sy, 0, 0, image.width, image.height)
   }
   const blob = await new Promise<Blob | null>(resolve => image.toBlob(resolve, 'image/png'))
   if (!blob) throw new Error()
   const bounds = editor.getShapePageBounds(id)
   const position = bounds ? { x: bounds.maxX + pageWidth / 2 + 24, y: bounds.center.y } : undefined
   await editor.putExternalContent({ type: 'files', files: [new File([blob], 'Страница PDF.png', { type: 'image/png' })], point: position })
   setCropping(false)
   setArea(null)
  } catch {
   setActionMessage('Не удалось добавить изображение')
  } finally {
   setBusy(false)
  }
 }
 const download = async () => {
  try {
   const url = await editor.resolveAssetUrl(assetId, { shouldResolveToOriginal: true })
   const response = url && await fetch(url)
   if (!response || !response.ok) throw new Error()
   const objectUrl = URL.createObjectURL(await response.blob())
   const link = document.createElement('a')
   link.href = objectUrl
   link.download = name
   link.click()
   setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch {
   setActionMessage('Не удалось скачать PDF')
  }
 }
 const copyLink = async () => {
  try {
   const url = editor.createDeepLink({ to: { type: 'shapes', shapeIds: [id] }, param: 'pdf' })
   await navigator.clipboard.writeText(url.href)
   setActionMessage('Ссылка скопирована')
  } catch {
   setActionMessage('Не удалось скопировать ссылку')
  }
 }

 return <HTMLContainer className="board-pdf" aria-label={name} style={{ width: w, height: displayHeight(shape.props) }}>
  {(compact || !h) && <div className="board-pdf-card" role={status ? 'status' : undefined}>
   <span className="board-pdf-file" aria-hidden="true"><FileIcon size={35}/><b>PDF</b></span>
   <div className="board-pdf-card-copy"><strong title={name}>{name}</strong><span>{status || (doc ? `${page} / ${doc.numPages}` : 'Обрабатывается…')}</span></div>
   {status === 'Обрабатывается…' || (!status && !doc) ? <LoaderCircle className="board-pdf-spinner" size={20} aria-hidden="true"/> : null}
  </div>}
  <div className="board-pdf-paper" hidden={compact || !h} aria-busy={!ready}>
   {!ready && !compact && h > 0 && <span role="status">{status || 'Страница загружается…'}</span>}
   <div className={`board-pdf-sheet${cropping && ready ? ' is-cropping' : ''}`} style={{ width: pageWidth, height: pageHeight }}
    onPointerDown={event => {
     if (!cropping || !ready || event.button !== 0) return
     event.stopPropagation()
     event.currentTarget.setPointerCapture(event.pointerId)
     start.current = point(event)
     setArea(null)
    }} onPointerMove={event => {
     if (!start.current) return
     event.stopPropagation()
     const p = point(event), origin = start.current
     setArea({ x: Math.min(p.x, origin.x), y: Math.min(p.y, origin.y), w: Math.abs(p.x - origin.x), h: Math.abs(p.y - origin.y) })
    }} onLostPointerCapture={() => { start.current = null }}>
    <canvas ref={canvas} className="board-pdf-canvas" aria-label={`${name}, страница ${page}`}/>
    {cropping && area && <div className="board-pdf-crop" style={{ left: area.x, top: area.y, width: area.w, height: area.h }}/>}
   </div>
  </div>
  {selected && ready && !compact && !shape.isLocked && <div className="board-pdf-handles" aria-hidden="true"><i/><i/><i/><i/></div>}
  {selected && (h > 0 || status !== 'Обрабатывается…' && !!status) && <PdfToolbar shapeId={id} name={name} compact={compact} page={page} pages={doc?.numPages} ready={ready && !compact} busy={busy}
   cropping={cropping} canCrop={!!area && area.w > 5 && area.h > 5} message={actionMessage}
   canDownload={!!pdf?.props.src} retry={error ? () => setAttempt(value => value + 1) : undefined}
   setCompact={value => update({ compact: value })} goToPage={value => update({ page: value })} exportImage={() => void exportImage()}
   toggleCrop={() => { setCropping(!cropping); setArea(null) }} exportCrop={() => { if (area) void exportImage(area) }}
   download={() => void download()} copyLink={() => void copyLink()} duplicate={() => editor.duplicateShapes([id], { x: 24, y: 24 })} remove={() => editor.deleteShapes([id])}/>}
 </HTMLContainer>
}

function PdfToolbar({ shapeId, name, compact, page, pages, ready, busy, cropping, canCrop, message, canDownload, retry, setCompact, goToPage, exportImage, toggleCrop, exportCrop, download, copyLink, duplicate, remove }: {
 shapeId: PdfShape['id']; name: string; compact: boolean; page: number; pages?: number; ready: boolean; busy: boolean; cropping: boolean; canCrop: boolean; message: string; canDownload: boolean;
 retry?: () => void; setCompact: (value: boolean) => void; goToPage: (value: number) => void; exportImage: () => void; toggleCrop: () => void;
 exportCrop: () => void; download: () => void; copyLink: () => void; duplicate: () => void; remove: () => void;
}) {
 const editor = useEditor()
 const [menu, setMenu] = useState(false)
 const position = useValue('PDF toolbar position', () => {
  const bounds = editor.getShapePageBounds(shapeId)
  if (!bounds || !bounds.collides(editor.getViewportPageBounds())) return null
  const point = editor.pageToViewport({ x: bounds.center.x, y: bounds.minY })
  const viewport = editor.getViewportScreenBounds()
  const margin = Math.min(566, viewport.w - 24) / 2 + 12
  const offset = compact ? -(viewport.w <= 580 ? 70 : 50) : 10
  return {
   left: Math.max(margin, Math.min(viewport.w - margin, point.x)),
   top: Math.max(78, Math.min(viewport.h - 90, point.y + offset)),
  }
 }, [editor, shapeId, compact])
 if (!position) return null
 return createPortal(<div className="board-pdf-controls" style={position} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
  <div className="board-pdf-toolbar" role="toolbar" aria-label={`Действия с ${name}`}>
   <span className="board-pdf-title" title={name}>{name}</span>
   <div className="board-pdf-tools">
    <button title="Показать карточку PDF" aria-pressed={compact} onClick={() => setCompact(true)}><PanelTop size={18}/></button>
    <button title="Показать страницу PDF" aria-pressed={!compact} onClick={() => setCompact(false)}><FileText size={18}/></button>
   </div>
   <div className="board-pdf-tools">
    <button title="Предыдущая страница" disabled={!pages || page <= 1} onClick={() => goToPage(page - 1)}><ChevronLeft size={18}/></button>
    <span className="board-pdf-count" aria-live="polite">{pages ? `${page} / ${pages}` : '…'}</span>
    <button title="Следующая страница" disabled={!pages || page >= pages} onClick={() => goToPage(page + 1)}><ChevronRight size={18}/></button>
   </div>
   <div className="board-pdf-tools">
    <button title="Добавить страницу на доску" disabled={!ready || busy} onClick={exportImage}><Copy size={17}/></button>
    <button title="Вырезать фрагмент" aria-pressed={cropping} disabled={!ready} onClick={toggleCrop}><Scan size={18}/></button>
    <button title="Скачать PDF" disabled={!canDownload} onClick={download}><Download size={18}/></button>
    <button title="Копировать ссылку на PDF" onClick={copyLink}><Link2 size={18}/></button>
    <button title="Действия с PDF" aria-expanded={menu} onClick={() => setMenu(!menu)}><MoreHorizontal size={18}/></button>
   </div>
  </div>
  {menu && <div className="board-pdf-menu">
   <button onClick={() => { duplicate(); setMenu(false) }}><Copy size={15}/> Дублировать</button>
   <button onClick={remove}><Trash2 size={15}/> Удалить PDF</button>
  </div>}
  {cropping && <div className="board-pdf-action"><span>Выделите область на странице</span><button disabled={!canCrop || busy} onClick={exportCrop}>На доску</button></div>}
  {retry && <div className="board-pdf-action"><button onClick={retry}>Открыть повторно</button></div>}
  {message && <span className="board-pdf-action" role="status">{message}</span>}
 </div>, editor.getContainer())
}
