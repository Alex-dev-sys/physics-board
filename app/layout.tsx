import type { Metadata } from 'next'
import './globals.css'
import 'tldraw/tldraw.css'
export const metadata: Metadata = { title: 'Физика — рабочая доска', description: 'Пространство для занятий физикой' }
export default function RootLayout({children}:{children:React.ReactNode}) { return <html lang="ru"><body>{children}</body></html> }
