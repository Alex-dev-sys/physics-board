import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  devIndicators: false,
  serverExternalPackages: [
    'yjs', '@tldraw/tlschema', '@tldraw/store', '@tldraw/state', '@tldraw/utils', '@tldraw/validate',
  ],
}

export default nextConfig
