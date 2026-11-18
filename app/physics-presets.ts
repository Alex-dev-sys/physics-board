import { createShapeId, getIndices, type Editor, type TLShapeId, type TLShapePartial } from 'tldraw'

export type Preset = 'slope' | 'block' | 'axes' | 'spring' | 'resistor' | 'capacitor' | 'lens'
type Point = [number, number]

/** Insert editable tldraw vectors and group each physics symbol as one object. */
export function insertPhysicsPreset(editor: Editor, kind: Preset) {
  const center = editor.getViewportPageBounds().center
  const x = center.x - 110, y = center.y - 70
  const shapes: TLShapePartial[] = []
  const ids: TLShapeId[] = []
  const add = (shape: TLShapePartial) => { shapes.push(shape); ids.push(shape.id!) }
  const line = (points: Point[]) => {
    const indices = getIndices(points.length)
    const indexed = Object.fromEntries(points.map(([px, py], i) => {
      const index = indices[i]
      return [index, { id: index, index, x: px, y: py }]
    }))
    add({ id: createShapeId(), type: 'line', x, y, props: { points: indexed, color: 'black', dash: 'solid', size: 'm' } })
  }
  const box = (px: number, py: number, w: number, h: number, geo: 'rectangle' | 'ellipse' = 'rectangle') => {
    add({ id: createShapeId(), type: 'geo', x: x + px, y: y + py, props: { geo, w, h, color: 'black', dash: 'solid', fill: 'none' } })
  }
  const arrow = (px: number, py: number, dx: number, dy: number) => {
    add({ id: createShapeId(), type: 'arrow', x: x + px, y: y + py, props: { start: { x: 0, y: 0 }, end: { x: dx, y: dy }, color: 'black', dash: 'solid' } })
  }
  switch (kind) {
    case 'slope':
      line([[10, 125], [205, 15], [205, 125], [10, 125]])
      break
    case 'block':
      box(45, 25, 130, 95)
      break
    case 'axes':
      arrow(10, 110, 200, 0)
      arrow(55, 135, 0, -125)
      break
    case 'spring':
      line([[5, 70], [30, 70], [40, 45], [55, 95], [70, 45], [85, 95], [100, 45], [115, 95], [130, 45], [145, 95], [160, 45], [175, 95], [190, 70], [215, 70]])
      break
    case 'resistor':
      line([[5, 70], [55, 70]])
      box(55, 48, 110, 44)
      line([[165, 70], [215, 70]])
      break
    case 'capacitor':
      line([[5, 70], [95, 70]])
      line([[95, 30], [95, 110]])
      line([[125, 30], [125, 110]])
      line([[125, 70], [215, 70]])
      break
    case 'lens':
      box(75, 5, 70, 130, 'ellipse')
      line([[110, 5], [110, 135]])
      break
  }
  editor.createShapes(shapes)
  if (ids.length > 1) {
    editor.groupShapes(ids)
  } else {
    editor.select(...ids)
  }
  editor.setCurrentTool('select')
}
