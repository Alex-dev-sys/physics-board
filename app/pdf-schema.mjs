import { assetIdValidator, createTLSchema, defaultShapeSchemas } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const pdfCardHeight = 66
export const pdfShapeProps = {
 w: T.nonZeroNumber,
 h: T.positiveNumber,
 assetId: assetIdValidator,
 page: T.positiveInteger,
 compact: T.boolean,
}

export function createBoardSchema() {
 return createTLSchema({ shapes: { ...defaultShapeSchemas, pdf: { props: pdfShapeProps } } })
}
