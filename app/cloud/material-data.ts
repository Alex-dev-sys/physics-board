export type SharedMaterial = { id: string; name: string; type: string; path: string; page: number }

export const materialTypes = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isSharedMaterial(value: unknown, roomId: string): value is SharedMaterial {
 if (!value || typeof value !== 'object') return false
 const material = value as SharedMaterial
 const prefix = roomId + '/'
 return typeof material.id === 'string' && /^[0-9a-f-]{36}$/i.test(material.id) &&
  typeof material.name === 'string' && material.name.length <= 255 && materialTypes.has(material.type) &&
  typeof material.path === 'string' && material.path.startsWith(prefix) &&
  /^[0-9a-f-]{36}\.(png|jpg|webp|gif|pdf)$/i.test(material.path.slice(prefix.length)) &&
  Number.isInteger(material.page) && material.page >= 1 && material.page <= 100000
}
